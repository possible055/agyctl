package tooloutput

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"agyctl/internal/apptarget"
	"agyctl/internal/fsx"
	"agyctl/internal/testutil"
)

const syntheticImageSize = 0x400

// syntheticImage builds a minimal PE image with deterministic filler bytes.
func syntheticImage(seed byte) []byte {
	image := make([]byte, syntheticImageSize)
	image[0], image[1] = 'M', 'Z'
	binary.LittleEndian.PutUint32(image[0x3c:0x40], 0x40)
	copy(image[0x40:0x44], []byte("PE\x00\x00"))
	binary.LittleEndian.PutUint16(image[0x44:0x46], 0x8664)
	for i := 0x80; i < syntheticImageSize; i++ {
		image[i] = seed + byte(i)
	}
	return image
}

type syntheticFixture struct {
	registry   Registry
	image      []byte
	patched    []byte
	registryJS []byte
}

// syntheticFixtureData builds a two-segment registry and its matching image.
// The recipe changes 4 bytes at 0x100 and 2 bytes at 0x200.
func syntheticFixtureData(t *testing.T, seed byte, mutate func([]byte)) syntheticFixture {
	t.Helper()
	image := syntheticImage(seed)
	copy(image[0x100:0x104], []byte("AAAA"))
	copy(image[0x200:0x202], []byte("CC"))
	if mutate != nil {
		mutate(image)
	}
	patched := bytes.Clone(image)
	copy(patched[0x100:0x104], []byte("BBBB"))
	copy(patched[0x200:0x202], []byte("DD"))
	segments := []map[string]any{
		{"name": "seg-a", "role": "transform", "va": "0x0", "offset": 0x100, "expected_hex": "41414141", "new_hex": "42424242"},
		{"name": "seg-b", "role": "capacity", "va": "0x0", "offset": 0x200, "expected_hex": "4343", "new_hex": "4444"},
	}
	return syntheticFixture{
		registry: Registry{Schema: 1, Feature: "tool-output", Targets: []Target{{
			ID: "synthetic", Product: "Synthetic", Channel: "antigravity", Platform: "win32-x64", Arch: "x86-64",
			BinaryName: "language_server.exe", BinarySize: syntheticImageSize, Member: "resources/bin/language_server.exe",
			Qualification: "candidate", VerifiedAt: "2026-11-14",
			CapacityTargets: map[string]CapacityTarget{"demo.limit": {SourceValue: 1, Target: 2, Layer: "base default constant"}},
			Notes:           "synthetic fixture",
			Inputs: []InputState{{
				Input: "original", BinarySHA: fsx.SHA256(image), OutputSHA: fsx.SHA256(patched), Segments: []Segment{
					{Name: "seg-a", Role: "transform", Offset: 0x100, ExpectedHex: "41414141", NewHex: "42424242"},
					{Name: "seg-b", Role: "capacity", Offset: 0x200, ExpectedHex: "4343", NewHex: "4444"},
				},
			}},
		}}},
		image:   image,
		patched: patched,
		registryJS: mustJSON(t, map[string]any{
			"schema": 1, "feature": "tool-output",
			"targets": []map[string]any{{
				"id": "synthetic", "product": "Synthetic", "channel": "antigravity", "platform": "win32-x64", "arch": "x86-64",
				"binary_name": "language_server.exe", "binary_size": syntheticImageSize, "member": "resources/bin/language_server.exe",
				"qualification": "candidate", "verified_at": "2026-11-14",
				"capacity_targets": map[string]any{"demo.limit": map[string]any{"source_value": 1, "target": 2, "layer": "base default constant"}},
				"notes":            "synthetic fixture",
				"inputs": []map[string]any{{
					"input": "original", "binary_sha256": fsx.SHA256(image), "output_sha256": fsx.SHA256(patched), "segments": segments,
				}},
			}},
		}),
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func fixtureRoot(t *testing.T, registryJS []byte) string {
	t.Helper()
	root := testutil.TempDir(t)
	if err := os.MkdirAll(filepath.Join(root, "compat"), 0755); err != nil {
		t.Fatal(err)
	}
	layout, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "compat", "install-layout.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(root, "compat", "install-layout.json"), layout, 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(root, "compat", "tool-output.json"), registryJS, 0600); err != nil {
		t.Fatal(err)
	}
	return root
}

func dataHome(t *testing.T) string {
	t.Helper()
	home := testutil.TempDir(t)
	t.Setenv("AGYCTL_HOME", home)
	return home
}

func TestHistoricalRecipeValidation(t *testing.T) {
	for _, test := range []struct {
		name    string
		mutate  func(*Target)
		message string
	}{
		{"current-duplicate", func(target *Target) { target.HistoricalInputs = append(target.HistoricalInputs, target.Inputs[0]) }, "duplicated historical input"},
		{"history-duplicate", func(target *Target) {
			target.HistoricalInputs = append(target.HistoricalInputs, target.HistoricalInputs[0])
		}, "duplicated historical input"},
		{"different-base", func(target *Target) { target.HistoricalInputs[0].BinarySHA = fsx.SHA256([]byte("unregistered-base")) }, "unmatched"},
		{"invalid-bytes", func(target *Target) { target.HistoricalInputs[0].Segments[0].NewHex = "xx" }, "invalid or mismatched new bytes"},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := syntheticFixtureData(t, 0x10, nil)
			target := &fixture.registry.Targets[0]
			historical := target.Inputs[0]
			historical.Segments = append([]Segment(nil), historical.Segments...)
			historical.Segments[0].NewHex = "45454545"
			target.HistoricalInputs = []InputState{historical}
			test.mutate(target)
			if err := validateTarget(target, map[string]bool{}); err == nil || !strings.Contains(err.Error(), test.message) {
				t.Fatalf("historical recipe gate: want %q, got %v", test.message, err)
			}
		})
	}
}

func TestRegistryValidationRejectsBrokenRecipes(t *testing.T) {
	base := syntheticFixtureData(t, 0x10, nil)
	cases := map[string]func(document map[string]any){
		"overlapping segments": func(document map[string]any) {
			input := document["targets"].([]any)[0].(map[string]any)["inputs"].([]any)[0].(map[string]any)
			input["segments"].([]any)[1].(map[string]any)["offset"] = 0x101
		},
		"mismatched segment lengths": func(document map[string]any) {
			input := document["targets"].([]any)[0].(map[string]any)["inputs"].([]any)[0].(map[string]any)
			input["segments"].([]any)[1].(map[string]any)["new_hex"] = "44"
		},
		"unsupported role": func(document map[string]any) {
			input := document["targets"].([]any)[0].(map[string]any)["inputs"].([]any)[0].(map[string]any)
			input["segments"].([]any)[0].(map[string]any)["role"] = "wildcard"
		},
		"invalid input hash": func(document map[string]any) {
			input := document["targets"].([]any)[0].(map[string]any)["inputs"].([]any)[0].(map[string]any)
			input["binary_sha256"] = "not-a-hash"
		},
		"duplicated input name": func(document map[string]any) {
			input := document["targets"].([]any)[0].(map[string]any)["inputs"].([]any)[0].(map[string]any)
			document["targets"].([]any)[0].(map[string]any)["inputs"] = []any{input, input}
		},
		"segment beyond declared size": func(document map[string]any) {
			input := document["targets"].([]any)[0].(map[string]any)["inputs"].([]any)[0].(map[string]any)
			input["segments"].([]any)[0].(map[string]any)["offset"] = syntheticImageSize - 2
		},
	}
	for name, mutate := range cases {
		document := map[string]any{}
		if err := json.Unmarshal(base.registryJS, &document); err != nil {
			t.Fatal(err)
		}
		mutate(document)
		data, err := json.Marshal(document)
		if err != nil {
			t.Fatal(err)
		}
		root := fixtureRoot(t, data)
		if _, err = LoadRegistry(root, nil); err == nil {
			t.Fatalf("%s: registry accepted", name)
		}
	}
}

func TestRealRegistryLoadsAndSelfChecks(t *testing.T) {
	root := filepath.Join("..", "..", "..", "..")
	reg, err := LoadRegistry(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	type inputContract struct{ sha, output, fingerprint string }
	contracts := map[string]struct {
		version  string
		segments int
		inputs   map[string]inputContract
	}{
		"win-amd64-antigravity-2.31.2": {"2.31.2", 11, map[string]inputContract{
			"original":     {"e40f0447109c43ece15e7025ca0864a138e0e16cb8864d4ccf64a00512a99e1a", "47a439efe717e797533f1cdc0c303d40f264c5f1e0a1135f766b64f1208fa61e", "6bcdb233fcb372f8818d929f1dde4d1042ccc9ba8c5b29910c9f1b7314dc90e8"},
			"grep-patched": {"1c69b4fc10b15b016125d38a32a5b4fd13018dad22564207b576bbb3e759e164", "47a439efe717e797533f1cdc0c303d40f264c5f1e0a1135f766b64f1208fa61e", "06041ad4e5583fe796bfafb054085dbaedc39a8716618c9bb43ebbaf97a184b6"},
		}},
		"win-amd64-antigravity-2.32.1": {"2.32.1", 4, map[string]inputContract{
			"original": {"65cdb8d132fc61056625081be7d07d4d22f57eba485de7edf0d24d98e77c891f", "a53f6fcc14e73fa4117acbcf70bf4c1b4497731d9b72db9ca03284b21b82dea0", "7596c88a1085a14924361278b4085147726da76eaacecfd54ccaae489b8e44aa"},
		}},
		"win-amd64-antigravity-2.33.0": {"2.33.0", 4, map[string]inputContract{
			"original": {"eb6d986dfc5a859c6e9b1b36a0601f5c362993cc16eb8962ad554c9141defc9c", "9f230dcacd9be8736ca4d80b0d178bbee5d47b50e46ad7561e76ec9525636822", "11bf399578cfb68d282583e5ef4b5ac15bd5229bcf58ad5d644fc85e143af336"},
		}},
	}
	if len(reg.Targets) != len(contracts) {
		t.Fatalf("registered build contracts changed: got %d targets, want %d", len(reg.Targets), len(contracts))
	}
	for _, target := range reg.Targets {
		t.Run(target.ID, func(t *testing.T) {
			contract, ok := contracts[target.ID]
			if !ok {
				t.Fatalf("no reviewed contract for %s", target.ID)
			}
			if target.AppVersion != contract.version || target.Qualification != "candidate" {
				t.Fatalf("identity/qualification = %s/%s, want %s/candidate", target.AppVersion, target.Qualification, contract.version)
			}
			if len(target.Inputs) != len(contract.inputs) {
				t.Fatalf("input states = %d, want %d", len(target.Inputs), len(contract.inputs))
			}
			for _, state := range target.Inputs {
				want, ok := contract.inputs[state.Input]
				if !ok || state.BinarySHA != want.sha || state.OutputSHA != want.output || state.Fingerprint() != want.fingerprint {
					t.Fatalf("input %s changed its admission, output or restore fingerprint", state.Input)
				}
				if len(state.Segments) != contract.segments {
					t.Fatalf("input %s segments = %d, want %d", state.Input, len(state.Segments), contract.segments)
				}
				if contract.version != "2.31.2" {
					for _, segment := range state.Segments {
						if strings.HasPrefix(segment.Name, "grep-0") {
							t.Fatalf("2.31.2 grep transform copied into %s: %s", target.ID, segment.Name)
						}
					}
				}
			}
			if target.CapacityTargets["postMergeStepBudgetFloor"].Target != 98304 {
				t.Fatalf("step budget floor target = %v", target.CapacityTargets["postMergeStepBudgetFloor"])
			}
		})
	}
}

func TestAdmitPlanAndApplyFixedVector(t *testing.T) {
	fixture := syntheticFixtureData(t, 0x10, nil)
	reg := fixture.registry
	adm, refusal := Admit(fixture.image, reg)
	if refusal != nil {
		t.Fatalf("admission refused: %+v", refusal)
	}
	if adm.Target.ID != "synthetic" || adm.State.Input != "original" {
		t.Fatalf("admission matched %+v", adm)
	}
	plan, err := BuildPlan(fixture.image, adm)
	if err != nil {
		t.Fatal(err)
	}
	if plan.BytesChanged != 6 {
		t.Fatalf("bytes changed = %d, want 6", plan.BytesChanged)
	}
	if plan.AfterSHA != adm.State.OutputSHA {
		t.Fatalf("plan output %s does not match the registered output", plan.AfterSHA)
	}
	if got := plan.Output(); !bytes.Equal(got, fixture.patched) {
		t.Fatal("planned output differs from the expected patched image")
	}
	if adm.State.Fingerprint() == "" {
		t.Fatal("empty recipe fingerprint")
	}
}

func TestAdmitRefusesForeignStates(t *testing.T) {
	fixture := syntheticFixtureData(t, 0x10, nil)
	reg := fixture.registry
	if _, refusal := Admit(syntheticImage(0x99), reg); refusal == nil || refusal.Kind != RefusalSizeMismatch {
		t.Fatalf("same-size unknown image refusal = %+v", refusal)
	}
	if _, refusal := Admit(bytes.Repeat([]byte{0}, 32), reg); refusal == nil || refusal.Kind != RefusalUnknownInput {
		t.Fatalf("foreign-size image refusal = %+v", refusal)
	}
	if _, refusal := Admit(fixture.patched, reg); refusal == nil || refusal.Kind != RefusalUnmanagedOutput {
		t.Fatalf("output image refusal = %+v", refusal)
	}
	short := bytes.Clone(fixture.image[:syntheticImageSize-1])
	if _, refusal := Admit(short, reg); refusal == nil || refusal.Kind != RefusalUnknownInput {
		t.Fatalf("short image refusal = %+v", refusal)
	}
	brokenPE := syntheticFixtureData(t, 0x10, func(image []byte) {
		copy(image[0x40:0x44], []byte("PX\x00\x00"))
	})
	if _, refusal := Admit(brokenPE.image, brokenPE.registry); refusal == nil || refusal.Kind != RefusalPEInvalid {
		t.Fatalf("broken PE refusal = %+v", refusal)
	}
}

func TestPatchDryRunWritesNothing(t *testing.T) {
	fixture := syntheticFixtureData(t, 0x10, nil)
	root := fixtureRoot(t, fixture.registryJS)
	home := dataHome(t)
	binary := filepath.Join(root, "language_server.exe")
	if err := os.WriteFile(binary, fixture.image, 0600); err != nil {
		t.Fatal(err)
	}
	result, code, err := Run(root, nil, []string{"patch", "--binary", binary})
	if err != nil || code != 0 {
		t.Fatalf("dry run failed: %v (%d)", err, code)
	}
	if result.(map[string]any)["applied"] != false || result.(map[string]any)["dry_run"] != true {
		t.Fatalf("dry run result = %+v", result)
	}
	if result.(map[string]any)["binary_sha256_after"] != admOutputSHA(t, fixture) {
		t.Fatalf("dry run output hash = %v", result.(map[string]any)["binary_sha256_after"])
	}
	if _, err = os.Stat(filepath.Join(home, "backups")); !os.IsNotExist(err) {
		t.Fatalf("dry run created tool state: %v", err)
	}
	if content, err := os.ReadFile(binary); err != nil || !bytes.Equal(content, fixture.image) {
		t.Fatal("dry run modified the binary")
	}
}

func admOutputSHA(t *testing.T, fixture syntheticFixture) string {
	t.Helper()
	reg := fixture.registry
	adm, refusal := Admit(fixture.image, reg)
	if refusal != nil {
		t.Fatalf("admission refused: %+v", refusal)
	}
	return adm.State.OutputSHA
}

func TestPatchApplyRestoreRoundTrip(t *testing.T) {
	fixture := syntheticFixtureData(t, 0x10, nil)
	root := fixtureRoot(t, fixture.registryJS)
	home := dataHome(t)
	binary := filepath.Join(root, "language_server.exe")
	if err := os.WriteFile(binary, fixture.image, 0600); err != nil {
		t.Fatal(err)
	}
	backups := filepath.Join(home, "backups")
	result, code, err := Run(root, nil, []string{"patch", "--binary", binary, "--apply"})
	if err != nil || code != 0 {
		t.Fatalf("apply failed: %v (%d)", err, code)
	}
	applied := result.(map[string]any)
	if applied["applied"] != true {
		t.Fatalf("apply result = %+v", applied)
	}
	record := applied["record"].(map[string]any)
	if content, err := os.ReadFile(binary); err != nil || !bytes.Equal(content, fixture.patched) {
		t.Fatal("applied binary differs from the registered output")
	}
	for _, key := range []string{"backup_sibling", "repo_backup"} {
		path := record[key].(string)
		if sha, err := fsx.Hash(path); err != nil || sha != fsx.SHA256(fixture.image) {
			t.Fatalf("%s backup %s = %s, %v", key, path, sha, err)
		}
	}
	if _, err = os.Stat(filepath.Join(backups, "tool-output-state.json")); err != nil {
		t.Fatalf("state manifest missing: %v", err)
	}
	if _, err = os.Stat(filepath.Join(backups, "limit-operation.lock")); !os.IsNotExist(err) {
		t.Fatalf("operation lock was not released: %v", err)
	}
	// Re-apply is an explicit no-op over the tool's own recorded output.
	result, code, err = Run(root, nil, []string{"patch", "--binary", binary, "--apply"})
	if err != nil || code != 0 {
		t.Fatalf("re-apply failed: %v (%d)", err, code)
	}
	if result.(map[string]any)["already_applied"] != true {
		t.Fatalf("re-apply result = %+v", result)
	}
	// Restore returns exactly the operation input.
	result, code, err = Run(root, nil, []string{"restore", "--binary", binary})
	if err != nil || code != 0 {
		t.Fatalf("restore failed: %v (%d)", err, code)
	}
	if result.(map[string]any)["restored"] != true {
		t.Fatalf("restore result = %+v", result)
	}
	if content, err := os.ReadFile(binary); err != nil || !bytes.Equal(content, fixture.image) {
		t.Fatal("restored binary differs from the operation input")
	}
	for _, path := range []string{record["backup_sibling"].(string), record["repo_backup"].(string), binary + ".orig"} {
		if _, err = os.Stat(path); err != nil {
			t.Fatalf("backup was removed: %s (%v)", path, err)
		}
	}
	// Restoring a registered input without a patch is an explicit no-op.
	result, code, err = Run(root, nil, []string{"restore", "--binary", binary})
	if err != nil || code != 0 {
		t.Fatalf("second restore failed: %v (%d)", err, code)
	}
	if result.(map[string]any)["not_applied"] != true {
		t.Fatalf("second restore result = %+v", result)
	}
}

func TestPatchRefusesUnknownInputAndLimitConflict(t *testing.T) {
	fixture := syntheticFixtureData(t, 0x10, nil)
	root := fixtureRoot(t, fixture.registryJS)
	dataHome(t)
	binary := filepath.Join(root, "language_server.exe")
	if err := os.WriteFile(binary, syntheticImage(0x42), 0600); err != nil {
		t.Fatal(err)
	}
	_, code, err := Run(root, nil, []string{"patch", "--binary", binary, "--apply"})
	if code == 0 || err == nil || !strings.Contains(err.Error(), "matches no registered input") {
		t.Fatalf("unknown input refusal = %v (%d)", err, code)
	}
	if content, err := os.ReadFile(binary); err != nil || !bytes.Equal(content, syntheticImage(0x42)) {
		t.Fatal("refused patch modified the binary")
	}
	// A binary that matches the registered output but carries limit's patch
	// record reports PATCH_CONFLICT and is never auto-restored.
	if err = os.WriteFile(binary, fixture.patched, 0600); err != nil {
		t.Fatal(err)
	}
	backups, err := layout_dataHomeBackups(t)
	if err != nil {
		t.Fatal(err)
	}
	limitState := map[string]any{"schema": 1, "records": []map[string]any{{
		"action":               "patch",
		"binary_path":          binary,
		"binary_sha256_after":  fsx.SHA256(fixture.patched),
		"binary_sha256_before": fsx.SHA256(fixture.image),
	}}}
	if err = os.MkdirAll(backups, 0700); err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(limitState)
	if err = os.WriteFile(filepath.Join(backups, "model-limit-state.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	_, code, err = Run(root, nil, []string{"patch", "--binary", binary, "--apply"})
	if code == 0 || err == nil || !strings.Contains(err.Error(), "PATCH_CONFLICT") {
		t.Fatalf("limit conflict refusal = %v (%d)", err, code)
	}
	if content, err := os.ReadFile(binary); err != nil || !bytes.Equal(content, fixture.patched) {
		t.Fatal("conflict refusal modified the binary")
	}
}

func layout_dataHomeBackups(t *testing.T) (string, error) {
	t.Helper()
	return filepath.Join(os.Getenv("AGYCTL_HOME"), "backups"), nil
}

func TestRestoreRefusesDriftedBinary(t *testing.T) {
	fixture := syntheticFixtureData(t, 0x10, nil)
	root := fixtureRoot(t, fixture.registryJS)
	dataHome(t)
	binary := filepath.Join(root, "language_server.exe")
	if err := os.WriteFile(binary, fixture.image, 0600); err != nil {
		t.Fatal(err)
	}
	if _, code, err := Run(root, nil, []string{"patch", "--binary", binary, "--apply"}); err != nil || code != 0 {
		t.Fatalf("apply failed: %v (%d)", err, code)
	}
	newer := append(bytes.Clone(fixture.patched), []byte("app update")...)
	if err := os.WriteFile(binary, newer, 0600); err != nil {
		t.Fatal(err)
	}
	_, code, err := Run(root, nil, []string{"restore", "--binary", binary})
	if code == 0 || err == nil || !strings.Contains(err.Error(), "changed since the last tool-output patch") {
		t.Fatalf("drift refusal = %v (%d)", err, code)
	}
	if content, err := os.ReadFile(binary); err != nil || !bytes.Equal(content, newer) {
		t.Fatal("refused restore modified the binary")
	}
}

func TestRestoreRefusesUnrecordedOutput(t *testing.T) {
	fixture := syntheticFixtureData(t, 0x10, nil)
	root := fixtureRoot(t, fixture.registryJS)
	dataHome(t)
	binary := filepath.Join(root, "language_server.exe")
	if err := os.WriteFile(binary, fixture.patched, 0600); err != nil {
		t.Fatal(err)
	}
	_, code, err := Run(root, nil, []string{"restore", "--binary", binary})
	if code == 0 || err == nil || !strings.Contains(err.Error(), "no transaction record") {
		t.Fatalf("unrecorded output refusal = %v (%d)", err, code)
	}
	if content, err := os.ReadFile(binary); err != nil || !bytes.Equal(content, fixture.patched) {
		t.Fatal("refused restore modified the binary")
	}
}

func TestPatchApplyResumesMatchingPrepareRecord(t *testing.T) {
	fixture := syntheticFixtureData(t, 0x10, nil)
	root := fixtureRoot(t, fixture.registryJS)
	home := dataHome(t)
	binary := filepath.Join(root, "language_server.exe")
	if err := os.WriteFile(binary, fixture.image, 0600); err != nil {
		t.Fatal(err)
	}
	s := store{directory: filepath.Join(home, "backups")}
	reg := fixture.registry
	adm, refusal := Admit(fixture.image, reg)
	if refusal != nil {
		t.Fatalf("admission refused: %+v", refusal)
	}
	plan, err := BuildPlan(fixture.image, adm)
	if err != nil {
		t.Fatal(err)
	}
	sibling, err := s.siblingBackup(binary, plan.BeforeSHA)
	if err != nil {
		t.Fatal(err)
	}
	repo, err := s.backupPath(binary, plan.BeforeSHA)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(s.directory, 0700); err != nil {
		t.Fatal(err)
	}
	if err = fsx.EnsureBackup(binary, sibling, plan.BeforeSHA); err != nil {
		t.Fatal(err)
	}
	if err = fsx.EnsureBackup(binary, repo, plan.BeforeSHA); err != nil {
		t.Fatal(err)
	}
	prepared := prepareRecord{
		Operation: "deadbeef", Target: mustNormalized(t, binary), TargetID: plan.TargetID, Input: plan.Input,
		Fingerprint: plan.Fingerprint, OriginalSHA: plan.BeforeSHA, NewSHA: plan.AfterSHA,
		BytesChanged: plan.BytesChanged, Qualification: plan.Qualification,
		Backups: []prepareBackup{{Kind: "sibling", Path: sibling, SHA256: plan.BeforeSHA}, {Kind: "repo", Path: repo, SHA256: plan.BeforeSHA}},
	}
	if err = s.writePrepare(prepared); err != nil {
		t.Fatal(err)
	}
	result, code, err := Run(root, nil, []string{"patch", "--binary", binary, "--apply"})
	if err != nil || code != 0 {
		t.Fatalf("resumed apply failed: %v (%d)", err, code)
	}
	record := result.(map[string]any)["record"].(map[string]any)
	if record["operation"] != "deadbeef" {
		t.Fatalf("resumed operation id = %v", record["operation"])
	}
	if content, err := os.ReadFile(binary); err != nil || !bytes.Equal(content, fixture.patched) {
		t.Fatal("resumed apply wrote unexpected bytes")
	}
}

func TestPatchApplyRefusesConflictingPrepareRecord(t *testing.T) {
	fixture := syntheticFixtureData(t, 0x10, nil)
	root := fixtureRoot(t, fixture.registryJS)
	home := dataHome(t)
	binary := filepath.Join(root, "language_server.exe")
	if err := os.WriteFile(binary, fixture.image, 0600); err != nil {
		t.Fatal(err)
	}
	s := store{directory: filepath.Join(home, "backups")}
	reg := fixture.registry
	adm, refusal := Admit(fixture.image, reg)
	if refusal != nil {
		t.Fatalf("admission refused: %+v", refusal)
	}
	plan, err := BuildPlan(fixture.image, adm)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(s.directory, 0700); err != nil {
		t.Fatal(err)
	}
	if err = s.writePrepare(prepareRecord{
		Operation: "other", Target: mustNormalized(t, binary), TargetID: plan.TargetID, Input: plan.Input,
		Fingerprint: "aaaaaaaa", OriginalSHA: plan.BeforeSHA, NewSHA: plan.AfterSHA,
		BytesChanged: plan.BytesChanged, Qualification: plan.Qualification,
	}); err != nil {
		t.Fatal(err)
	}
	_, code, err := Run(root, nil, []string{"patch", "--binary", binary, "--apply"})
	if code == 0 || err == nil || !strings.Contains(err.Error(), "refusing to overwrite it") {
		t.Fatalf("conflicting prepare refusal = %v (%d)", err, code)
	}
	if content, err := os.ReadFile(binary); err != nil || !bytes.Equal(content, fixture.image) {
		t.Fatal("refused patch modified the binary")
	}
	if _, err = os.Stat(filepath.Join(home, "backups", "limit-operation.lock")); !os.IsNotExist(err) {
		t.Fatalf("refused patch left an operation lock: %v", err)
	}
}

func mustNormalized(t *testing.T, path string) string {
	t.Helper()
	key, err := apptarget.Normalized(path)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

// TestCrossFeatureOperationLockSerializes pins the plan's coexistence rule:
// tool-output and limit serialize on the same limit-operation.lock, so a held
// limit operation refuses a tool-output mutation without any file changes.
func TestCrossFeatureOperationLockSerializes(t *testing.T) {
	fixture := syntheticFixtureData(t, 0x10, nil)
	root := fixtureRoot(t, fixture.registryJS)
	home := dataHome(t)
	binary := filepath.Join(root, "language_server.exe")
	if err := os.WriteFile(binary, fixture.image, 0600); err != nil {
		t.Fatal(err)
	}
	backups := filepath.Join(home, "backups")
	if err := os.MkdirAll(backups, 0700); err != nil {
		t.Fatal(err)
	}
	lock := filepath.Join(backups, "limit-operation.lock")
	owner := []byte(`{"id":"op-limit","pid":4321,"command":"limit patch"}`)
	if err := os.WriteFile(lock, owner, 0600); err != nil {
		t.Fatal(err)
	}
	_, code, err := Run(root, nil, []string{"patch", "--binary", binary, "--apply"})
	if code == 0 || err == nil || !strings.Contains(err.Error(), "limit-operation.lock") || !strings.Contains(err.Error(), "no changes were made") {
		t.Fatalf("cross-feature contention error = %v (%d)", err, code)
	}
	if content, err := os.ReadFile(binary); err != nil || !bytes.Equal(content, fixture.image) {
		t.Fatal("contended patch modified the binary")
	}
	current, err := os.ReadFile(lock)
	if err != nil || !bytes.Equal(current, owner) {
		t.Fatalf("contended patch disturbed the held lock: %s (%v)", current, err)
	}
	if _, err = os.Stat(filepath.Join(backups, "tool-output-state.json")); !os.IsNotExist(err) {
		t.Fatalf("contended patch wrote state: %v", err)
	}
}

// A limit-patched input that matches neither a registered input nor output
// still reports PATCH_CONFLICT instead of a bare unknown refusal.
func TestPatchRefusesLimitPatchedUnknownInput(t *testing.T) {
	fixture := syntheticFixtureData(t, 0x10, nil)
	root := fixtureRoot(t, fixture.registryJS)
	dataHome(t)
	binary := filepath.Join(root, "language_server.exe")
	foreign := bytes.Clone(fixture.image)
	copy(foreign[0x300:0x304], []byte("ZZZZ"))
	if err := os.WriteFile(binary, foreign, 0600); err != nil {
		t.Fatal(err)
	}
	backups := filepath.Join(os.Getenv("AGYCTL_HOME"), "backups")
	if err := os.MkdirAll(backups, 0700); err != nil {
		t.Fatal(err)
	}
	limitState := map[string]any{"schema": 1, "records": []map[string]any{{
		"action":              "patch",
		"binary_path":         binary,
		"binary_sha256_after": fsx.SHA256(foreign),
	}}}
	data, _ := json.Marshal(limitState)
	if err := os.WriteFile(filepath.Join(backups, "model-limit-state.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	_, code, err := Run(root, nil, []string{"patch", "--binary", binary, "--apply"})
	if code == 0 || err == nil || !strings.Contains(err.Error(), "PATCH_CONFLICT") {
		t.Fatalf("limit-patched unknown refusal = %v (%d)", err, code)
	}
	if content, err := os.ReadFile(binary); err != nil || !bytes.Equal(content, foreign) {
		t.Fatal("conflict refusal modified the binary")
	}
}
