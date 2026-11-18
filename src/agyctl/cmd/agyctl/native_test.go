package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"agyctl/internal/assets"
	"agyctl/internal/compaction"
	"agyctl/internal/fsx"
	"agyctl/internal/layout"
	"agyctl/internal/limit"
	"agyctl/internal/lspatch"
	"agyctl/internal/testutil"
	"agyctl/internal/tooloutput"
)

func nativeRuntimeFixture(t *testing.T) (string, string, []byte) {
	t.Helper()
	root := testutil.TempDir(t)
	t.Setenv("AGYCTL_HOME", filepath.Join(root, "home"))
	if err := os.MkdirAll(filepath.Join(root, "compat"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"install-layout.json", "versions.json"} {
		data, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "compat", name))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, "compat", name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	base, err := os.ReadFile(filepath.Join("..", "..", "testdata", "limit", "original.bin"))
	if err != nil {
		t.Fatal(err)
	}
	versionsPath := filepath.Join(root, "compat", "versions.json")
	versionsJSON, err := os.ReadFile(versionsPath)
	if err != nil {
		t.Fatal(err)
	}
	var versions map[string]any
	if err := json.Unmarshal(versionsJSON, &versions); err != nil {
		t.Fatal(err)
	}
	entries := versions["entries"].([]any)
	entry := map[string]any{}
	for key, value := range entries[0].(map[string]any) {
		entry[key] = value
	}
	entry["id"], entry["app_version"], entry["binary_sha256"], entry["binary_size"] = "native-fixture", "2.32.1", fsx.SHA256(base), len(base)
	versions["entries"] = append(entries, entry)
	versionsJSON, err = json.Marshal(versions)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(versionsPath, versionsJSON, 0600); err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(root, "offline", "server.exe")
	if err := os.MkdirAll(filepath.Dir(binary), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(binary, base, 0600); err != nil {
		t.Fatal(err)
	}
	for _, feature := range []string{"tool-output", "compaction"} {
		offset := len(base) - 16
		roles := []string{"capacity"}
		if feature == "compaction" {
			offset = len(base) - 8
			roles = []string{"prompt", "capacity"}
		}
		output := bytes.Clone(base)
		segments := []map[string]any{}
		for i, role := range roles {
			at := offset + i
			output[at] ^= 1
			segments = append(segments, map[string]any{"name": role, "role": role, "offset": at, "expected_hex": hex.EncodeToString(base[at : at+1]), "new_hex": hex.EncodeToString(output[at : at+1])})
		}
		target := map[string]any{"id": "fixture-" + feature, "app_version": "2.32.1", "product": "fixture", "channel": "antigravity", "platform": "win32-x64", "arch": "x86-64", "binary_name": "server.exe", "binary_size": len(base), "member": "resources/bin/server.exe", "qualification": "candidate", "verified_at": "2026-11-16", "inputs": []map[string]any{{"input": "original", "binary_sha256": fsx.SHA256(base), "output_sha256": fsx.SHA256(output), "segments": segments}}}
		values := map[string]any{"fixture.value": map[string]any{"source_value": 1, "target": 2, "layer": "fixture"}}
		if feature == "tool-output" {
			target["capacity_targets"] = values
		} else {
			target["value_targets"] = values
		}
		data, err := json.Marshal(map[string]any{"schema": 1, "feature": feature, "targets": []map[string]any{target}})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, "compat", feature+".json"), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	return root, binary, base
}

func TestNativeCLIProofAndDesiredPlan(t *testing.T) {
	root, binary, base := nativeRuntimeFixture(t)
	invoke := func(args ...string) map[string]any {
		t.Helper()
		result, code, err := run(append([]string{"--root", root}, args...))
		if err != nil || code != 0 {
			t.Fatalf("%v: code=%d error=%v", args, code, err)
		}
		return result.(map[string]any)
	}
	status := invoke("native", "status", "--binary", binary, "--json")
	if status["verified"] != true || status["base_sha256"] != fsx.SHA256(base) || status["current_sha256"] != fsx.SHA256(base) || status["base_binary_path"] != binary || status["generation"] != uint64(0) {
		t.Fatalf("original proof: %v", status)
	}
	desired := `{"limit":{"enabled":true,"model_limits":[{"id":1318,"limit":300000}]},"compaction":true}`
	plan := invoke("native", "plan", "--binary", binary, "--desired", desired)
	expected := plan["expected"].(lspatch.Expected)
	if expected.BaseSHA != status["base_sha256"] || expected.CurrentSHA != status["current_sha256"] || expected.Generation != 0 || expected.AssetsFingerprint != status["assets_fingerprint"] || plan["after_sha256"] == expected.CurrentSHA {
		t.Fatalf("reviewed proof: %v", plan)
	}
	if plan["desired"].(lspatch.Config).ToolOutput {
		t.Fatal("omitted tool-output did not preserve the disabled state")
	}
	if _, err := os.Stat(filepath.Join(root, "home")); !os.IsNotExist(err) {
		t.Fatalf("status/plan wrote tool state: %v", err)
	}
	snapshot, err := assets.Capture(root, "native")
	if err != nil {
		t.Fatal(err)
	}
	engine, err := nativeEngine(root, snapshot)
	if err != nil {
		t.Fatal(err)
	}
	engine.RequireStopped = func(string) error { return nil }
	request, err := lspatch.ParseDesired([]byte(desired))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := engine.Apply(binary, request, expected, "native"); err != nil {
		t.Fatal(err)
	}
	if _, code, err := tooloutput.RunWithNative(root, snapshot, []string{"patch", "--binary", binary, "--apply"}, engine.Handle); err != nil || code != 0 {
		t.Fatalf("old tool-output patch failed to preserve L/C: %d %v", code, err)
	}
	status = invoke("limit", "status", "--binary", binary)
	patch := status["patch_state"].(map[string]any)
	if patch["kind"] != "patched" || status["settings_state"] != "applied" || !status["features"].(lspatch.Config).Compaction || len(patch["model_limits"].([]limit.ModelLimit)) != 1 || status["saved_settings"] == nil {
		t.Fatalf("old limit status contract: %v", status)
	}
	if _, code, err := run([]string{"--root", root, "native", "apply", "--binary", binary, "--desired", desired, "--expected", `{}`}); code == 0 || err == nil || !strings.Contains(err.Error(), "expected requires") {
		t.Fatalf("incomplete reviewed proof accepted: %d %v", code, err)
	}
	for _, feature := range []string{"limit", "tool-output", "compaction"} {
		var value map[string]any
		handler := func(request lspatch.Request) (map[string]any, bool, error) { return engine.Handle(request) }
		switch feature {
		case "limit":
			result, _, err := limit.RunWithNative(root, snapshot, []string{"restore", "--binary", binary}, handler)
			if err != nil {
				t.Fatal(err)
			}
			value = result.(map[string]any)
		case "tool-output":
			result, _, err := tooloutput.RunWithNative(root, snapshot, []string{"restore", "--binary", binary}, handler)
			if err != nil {
				t.Fatal(err)
			}
			value = result.(map[string]any)
		case "compaction":
			result, _, err := compaction.RunWithNative(root, snapshot, []string{"restore", "--binary", binary}, handler)
			if err != nil {
				t.Fatal(err)
			}
			value = result.(map[string]any)
		}
		if value["verified"] != true {
			t.Fatalf("restore %s failed: %v", feature, value)
		}
	}
	current, err := os.ReadFile(binary)
	if err != nil || !bytes.Equal(current, base) {
		t.Fatalf("independent restores did not preserve/rebuild the exact base: %v", err)
	}
}

func TestNativeCLIUnknownStatusDoesNotHideIOErrors(t *testing.T) {
	root, binary, base := nativeRuntimeFixture(t)
	base[len(base)-1] ^= 1
	if err := os.WriteFile(binary, base, 0600); err != nil {
		t.Fatal(err)
	}
	result, code, err := run([]string{"--root", root, "native", "status", "--binary", binary})
	if code != 0 || err != nil || result.(map[string]any)["verified"] != false || result.(map[string]any)["file_state"] != "unsupported" {
		t.Fatalf("unknown whole image: %v %d %v", result, code, err)
	}
	if _, code, err := run([]string{"--root", root, "native", "status", "--binary", binary + ".missing"}); code == 0 || !os.IsNotExist(err) {
		t.Fatalf("missing binary was swallowed as unsupported: %d %v", code, err)
	}
}

func TestNativeHistoricalRecipeMigration(t *testing.T) {
	for _, enabled := range []bool{true, false} {
		t.Run(fmt.Sprintf("compaction-%t", enabled), func(t *testing.T) {
			root, binary, base := nativeRuntimeFixture(t)
			load := func() lspatch.Engine {
				t.Helper()
				snapshot, err := assets.Capture(root, "native")
				if err != nil {
					t.Fatal(err)
				}
				engine, err := nativeEngine(root, snapshot)
				if err != nil {
					t.Fatal(err)
				}
				engine.RequireStopped = func(string) error { return nil }
				return engine
			}
			old := load()
			config := lspatch.EmptyConfig()
			config.Limit = lspatch.LimitConfig{Enabled: true, ModelLimits: []lspatch.ModelLimit{{ID: 1318, Limit: 300000}}}
			config.ToolOutput, config.Compaction = true, enabled
			desired := lspatch.Desired{Limit: &config.Limit, ToolOutput: &config.ToolOutput, Compaction: &config.Compaction}
			plan, err := old.Plan(binary, desired)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := old.Apply(binary, desired, plan.Expected, "native"); err != nil {
				t.Fatal(err)
			}
			oldStatus, err := old.Status(binary)
			if err != nil {
				t.Fatal(err)
			}
			oldImage, err := os.ReadFile(binary)
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(root, "compat", "compaction.json")
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var registry map[string]any
			if err := json.Unmarshal(data, &registry); err != nil {
				t.Fatal(err)
			}
			target := registry["targets"].([]any)[0].(map[string]any)
			input := target["inputs"].([]any)[0].(map[string]any)
			history, err := json.Marshal(input)
			if err != nil {
				t.Fatal(err)
			}
			target["historical_inputs"] = []json.RawMessage{history}
			output := bytes.Clone(base)
			for _, item := range input["segments"].([]any) {
				segment := item.(map[string]any)
				at := int(segment["offset"].(float64))
				output[at] ^= 2
				segment["new_hex"] = hex.EncodeToString(output[at : at+1])
			}
			input["output_sha256"] = fsx.SHA256(output)
			data, err = json.Marshal(registry)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, data, 0600); err != nil {
				t.Fatal(err)
			}
			current := load()
			status, err := current.Status(binary)
			if err != nil || status["verified"] != true || status["current_sha256"] != oldStatus["current_sha256"] || status["recipe_update_required"] != true {
				t.Fatalf("registered historical image was not verified as needing migration: %v %v", status, err)
			}
			historicalRegistry, err := compaction.LoadRegistry(root, nil)
			if err != nil {
				t.Fatal(err)
			}
			historicalTarget := &historicalRegistry.Targets[0]
			historicalTarget.HistoricalInputs[0].OutputSHA = fsx.SHA256([]byte("wrong-historical-output"))
			qualifiedHistory := current.Specs[0].HistoricalCompaction[0]
			current.Specs[0].HistoricalCompaction[0] = compaction.NativeRecipe(historicalTarget, &historicalTarget.HistoricalInputs[0])
			if _, err := current.Status(binary); err == nil || !strings.Contains(err.Error(), "registry inconsistency") {
				t.Fatalf("historical standalone output SHA gate was bypassed: %v", err)
			}
			current.Specs[0].HistoricalCompaction[0] = qualifiedHistory
			plan, err = current.Plan(binary, lspatch.Desired{})
			if err != nil || plan.Desired.Compaction != enabled || !plan.Desired.ToolOutput || !reflect.DeepEqual(plan.Desired.Limit, config.Limit) {
				t.Fatalf("migration changed independent feature settings: %+v %v", plan, err)
			}
			stale := plan.Expected
			stale.AssetsFingerprint = old.AssetsFingerprint
			if _, err := current.Apply(binary, lspatch.Desired{}, stale, "native"); err == nil || !strings.Contains(err.Error(), "stale-plan") {
				t.Fatalf("recipe migration admitted stale assets: %v", err)
			}
			result, err := current.Apply(binary, lspatch.Desired{}, plan.Expected, "native")
			if err != nil || result["verified"] != true || result["applied"] != true || result["recipe_update_required"] != false || result["generation"] != uint64(2) {
				t.Fatalf("migration was not committed once: %v %v", result, err)
			}
			if (plan.AfterSHA != plan.Expected.CurrentSHA) != enabled {
				t.Fatalf("disabled recipe migration changed the binary, or enabled migration did not: %+v", plan)
			}
			want := bytes.Clone(oldImage)
			if enabled {
				for _, item := range input["segments"].([]any) {
					at := int(item.(map[string]any)["offset"].(float64))
					want[at] = output[at]
				}
			}
			actual, err := os.ReadFile(binary)
			if err != nil || !bytes.Equal(actual, want) {
				t.Fatalf("migration changed bytes outside the reviewed compaction recipe: %v", err)
			}
			if _, err := current.Status(binary); err != nil {
				t.Fatalf("new layout does not reconstruct after migration: %v", err)
			}
		})
	}
}

func TestNativeHistoricalPromptRecipeMigration(t *testing.T) {
	for _, prompt := range []lspatch.CompactionPrompt{{Mode: "native"}, {Mode: "custom", Text: "界"}} {
		t.Run(prompt.Mode, func(t *testing.T) {
			root, binary, base := nativeRuntimeFixture(t)
			registry, err := compaction.LoadRegistry(root, nil)
			if err != nil {
				t.Fatal(err)
			}
			target := &registry.Targets[0]
			input := &target.Inputs[0]
			at := len(base) - 8
			segment := func(name, role string, offset, length int) compaction.Segment {
				original := hex.EncodeToString(base[offset : offset+length])
				return compaction.Segment{Name: name, Role: role, Offset: int64(offset), ExpectedHex: original, NewHex: original}
			}
			input.Segments = []compaction.Segment{segment("body", "prompt", at, 3), segment("length", "prompt", at+3, 4), segment("capacity", "capacity", at+7, 1)}
			input.Segments[2].NewHex = hex.EncodeToString([]byte{base[at+7] ^ 1})
			input.Prompt = &compaction.PromptRecipe{BodySegment: "body", MaxBytes: 3, Segments: append([]compaction.Segment(nil), input.Segments[:2]...), LengthFields: []compaction.PromptLengthField{{Segment: "length", Offset: 0, ExpectedHex: "03000000"}}}
			input.Prompt.Segments[0].NewHex = "202020"
			input.Prompt.Segments[1].NewHex = "03000000"
			output := bytes.Clone(base)
			output[at+7] ^= 1
			input.OutputSHA = fsx.SHA256(output)
			load := func() lspatch.Engine {
				t.Helper()
				data, marshalErr := json.Marshal(registry)
				if marshalErr != nil {
					t.Fatal(marshalErr)
				}
				if writeErr := os.WriteFile(filepath.Join(root, "compat", "compaction.json"), data, 0600); writeErr != nil {
					t.Fatal(writeErr)
				}
				snapshot, captureErr := assets.Capture(root, "native")
				if captureErr != nil {
					t.Fatal(captureErr)
				}
				engine, engineErr := nativeEngine(root, snapshot)
				if engineErr != nil {
					t.Fatal(engineErr)
				}
				engine.RequireStopped = func(string) error { return nil }
				return engine
			}
			old := load()
			enabled := true
			desired := lspatch.Desired{Compaction: &enabled, CompactionPrompt: &prompt}
			plan, err := old.Plan(binary, desired)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := old.Apply(binary, desired, plan.Expected, "native"); err != nil {
				t.Fatal(err)
			}
			historical := *input
			historical.Segments = append([]compaction.Segment(nil), input.Segments...)
			target.HistoricalInputs = []compaction.InputState{historical}
			input.Segments[2].NewHex = hex.EncodeToString([]byte{base[at+7] ^ 2})
			output[at+7] = base[at+7] ^ 2
			input.OutputSHA = fsx.SHA256(output)
			current := load()
			status, err := current.Status(binary)
			if err != nil || status["verified"] != true || status["recipe_update_required"] != true {
				t.Fatalf("historical prompt image cannot be reconstructed: %v %v", status, err)
			}
			plan, err = current.Plan(binary, lspatch.Desired{})
			if err != nil || !reflect.DeepEqual(plan.Desired.CompactionPrompt, &prompt) {
				t.Fatalf("migration lost the exact prompt selection: %+v %v", plan, err)
			}
			result, err := current.Apply(binary, lspatch.Desired{}, plan.Expected, "native")
			if err != nil || result["generation"] != uint64(2) || result["recipe_update_required"] != false {
				t.Fatalf("historical prompt migration failed: %v %v", result, err)
			}
			if _, err := current.Status(binary); err != nil {
				t.Fatalf("migrated prompt image does not reconstruct: %v", err)
			}
		})
	}
}

func TestDiscoveredLimitTargetUsesTheSharedNativeSnapshot(t *testing.T) {
	root, _, base := nativeRuntimeFixture(t)
	install := filepath.Join(root, "install")
	if err := os.MkdirAll(install, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AGYCTL_APP_DIR", install)
	snapshot, err := assets.Capture(root, "layout")
	if err != nil {
		t.Fatal(err)
	}
	config, err := layout.Load(root, snapshot)
	if err != nil {
		t.Fatal(err)
	}
	target, err := config.Target(runtime.GOOS, runtime.GOARCH)
	if err != nil {
		t.Fatal(err)
	}
	platform := config.Platforms[target.NodePlatform]
	resources := filepath.Join(install, platform.Resources)
	binary := filepath.Join(resources, "bin", platform.LanguageServer)
	if err := os.MkdirAll(filepath.Dir(binary), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(binary, base, 0600); err != nil {
		t.Fatal(err)
	}
	header := []byte(`{"files":{}}`)
	prelude := make([]byte, 16)
	prelude[12] = byte(len(header))
	if err := os.WriteFile(filepath.Join(resources, "app.asar"), append(prelude, header...), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(resources, "app"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(resources, "app", "package.json"), []byte(`{"version":"2.32.1"}`), 0600); err != nil {
		t.Fatal(err)
	}
	executable := filepath.Join(install, filepath.FromSlash(platform.Channels[0].Executable))
	if err := os.MkdirAll(filepath.Dir(executable), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(executable, []byte("fixture-not-executable"), 0600); err != nil {
		t.Fatal(err)
	}
	value, code, err := run([]string{"--root", root, "limit", "patch", "--model-limits", "1318=300000"})
	if err != nil || code != 0 {
		t.Fatalf("discovered dry run: %v %d %v", value, code, err)
	}
	result := value.(map[string]any)
	if _, ok := result["expected"].(lspatch.Expected); !ok {
		t.Fatalf("discovered native target bypassed the shared planner: %v", result)
	}
	if _, err := os.Stat(filepath.Join(root, "home")); !os.IsNotExist(err) {
		t.Fatalf("discovered dry run wrote state: %v", err)
	}
}
