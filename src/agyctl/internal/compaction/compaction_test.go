package compaction

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
// The recipe changes 4 prompt bytes at 0x100 and 2 capacity bytes at 0x200.
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
		{"name": "summary-prompt", "role": "prompt", "va": "0x0", "offset": 0x100, "expected_hex": "41414141", "new_hex": "42424242"},
		{"name": "max-user-requests-imm32", "role": "capacity", "va": "0x0", "offset": 0x200, "expected_hex": "4343", "new_hex": "4444"},
	}
	return syntheticFixture{
		registry: Registry{Schema: 1, Feature: "compaction", Targets: []Target{{
			ID: "synthetic", Product: "Synthetic", Channel: "antigravity", Platform: "win32-x64", Arch: "x86-64",
			BinaryName: "language_server.exe", BinarySize: syntheticImageSize, Member: "resources/bin/language_server.exe",
			Qualification: "candidate", VerifiedAt: "2026-11-15",
			ValueTargets: map[string]ValueTarget{
				"max_user_requests":      {SourceValue: 10, Target: 30, Layer: "imm32 initializer"},
				"max_user_request_bytes": {SourceValue: 1024, Target: 2048, Layer: "imm32 initializer"},
			},
			Notes: "synthetic fixture",
			Inputs: []InputState{{
				Input: "original", BinarySHA: fsx.SHA256(image), OutputSHA: fsx.SHA256(patched), Segments: []Segment{
					{Name: "summary-prompt", Role: "prompt", Offset: 0x100, ExpectedHex: "41414141", NewHex: "42424242"},
					{Name: "max-user-requests-imm32", Role: "capacity", Offset: 0x200, ExpectedHex: "4343", NewHex: "4444"},
				},
			}},
		}}},
		image:   image,
		patched: patched,
		registryJS: mustJSON(t, map[string]any{
			"schema": 1, "feature": "compaction",
			"targets": []map[string]any{{
				"id": "synthetic", "product": "Synthetic", "channel": "antigravity", "platform": "win32-x64", "arch": "x86-64",
				"binary_name": "language_server.exe", "binary_size": syntheticImageSize, "member": "resources/bin/language_server.exe",
				"qualification": "candidate", "verified_at": "2026-11-15",
				"value_targets": map[string]any{
					"max_user_requests":      map[string]any{"source_value": 10, "target": 30, "layer": "imm32 initializer"},
					"max_user_request_bytes": map[string]any{"source_value": 1024, "target": 2048, "layer": "imm32 initializer"},
				},
				"notes":  "synthetic fixture",
				"inputs": []map[string]any{{"input": "original", "binary_sha256": fsx.SHA256(image), "output_sha256": fsx.SHA256(patched), "segments": segments}},
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
	if err = os.WriteFile(filepath.Join(root, "compat", "compaction.json"), registryJS, 0600); err != nil {
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
		"missing value targets": func(document map[string]any) {
			document["targets"].([]any)[0].(map[string]any)["value_targets"] = map[string]any{}
		},
		"wrong feature name": func(document map[string]any) {
			document["feature"] = "tool-output"
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

// TestRealRegistryLoadsAndSelfChecks pins the tracked 2.31.2 registry to its
// documented shape; deeper byte verification against the real binaries needs
// the recorded installers and is deliberately out of scope here.
func TestRealRegistryLoadsAndSelfChecks(t *testing.T) {
	root := filepath.Join("..", "..", "..", "..")
	reg, err := LoadRegistry(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(reg.Targets) != 1 {
		t.Fatalf("expected exactly one registered target, got %d", len(reg.Targets))
	}
	target := reg.Targets[0]
	if target.Qualification != "candidate" {
		t.Fatalf("qualification = %s, candidate until live qualification", target.Qualification)
	}
	if len(target.Inputs) != 2 {
		t.Fatalf("expected two registered input states, got %d", len(target.Inputs))
	}
	outputs := map[string]bool{}
	for _, state := range target.Inputs {
		outputs[state.OutputSHA] = true
		if state.BinarySHA == state.OutputSHA {
			t.Fatalf("input %s claims identity transform", state.Input)
		}
		if len(state.Segments) != 13 {
			t.Fatalf("input %s declares %d segments, want 13", state.Input, len(state.Segments))
		}
		promptSegments := 0
		for _, segment := range state.Segments {
			switch segment.Role {
			case "prompt":
				promptSegments++
			case "capacity":
			default:
				t.Fatalf("input %s segment %s has unknown role %s", state.Input, segment.Name, segment.Role)
			}
		}
		if promptSegments != 3 {
			t.Fatalf("input %s declares %d prompt segments, want 3", state.Input, promptSegments)
		}
	}
	if len(outputs) != 2 {
		t.Fatalf("the two inputs must produce distinct outputs, got %v", outputs)
	}
	if target.ValueTargets["max_user_requests"].Target != 30 {
		t.Fatalf("max_user_requests target = %v", target.ValueTargets["max_user_requests"])
	}
	if target.ValueTargets["max_user_request_bytes"].Target != 2048 {
		t.Fatalf("max_user_request_bytes target = %v", target.ValueTargets["max_user_request_bytes"])
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
	if _, err = os.Stat(filepath.Join(backups, stateFileName)); err != nil {
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
	// Status over the managed output reports the disk state only.
	result, code, err = Run(root, nil, []string{"status", "--binary", binary})
	if err != nil || code != 0 {
		t.Fatalf("status failed: %v (%d)", err, code)
	}
	statusResult := result.(map[string]any)
	if statusResult["file_state"] != "managed-output" || statusResult["effective_state"] != "unknown" {
		t.Fatalf("status result = %+v", statusResult)
	}
	for _, key := range []string{"sibling_backup", "repo_backup"} {
		backup := statusResult[key].(map[string]any)
		if backup["exists"] != true || backup["verified"] != true {
			t.Fatalf("verified backup unavailable in status: %s = %+v", key, backup)
		}
	}
	if err = os.WriteFile(record["backup_sibling"].(string), []byte("corrupted fixture backup"), 0600); err != nil {
		t.Fatal(err)
	}
	result, code, err = Run(root, nil, []string{"status", "--binary", binary})
	if err != nil || code != 0 {
		t.Fatalf("status over corrupted fixture backup failed: %v (%d)", err, code)
	}
	statusResult = result.(map[string]any)
	if statusResult["sibling_backup"].(map[string]any)["verified"] != false || statusResult["repo_backup"].(map[string]any)["verified"] != true {
		t.Fatalf("status did not distinguish corrupted and verified backups: %+v", statusResult)
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
	result, code, err := Run(root, nil, []string{"patch", "--binary", binary, "--apply"})
	if code == 0 || err == nil || !strings.Contains(err.Error(), "matches no registered input") {
		t.Fatalf("unknown input refusal = %v (%d)", err, code)
	}
	if refusal := result.(map[string]any)["refusal"].(*Refusal); refusal.Kind != RefusalSizeMismatch {
		t.Fatalf("unknown input lost its structured refusal: %+v", result)
	}
	if content, err := os.ReadFile(binary); err != nil || !bytes.Equal(content, syntheticImage(0x42)) {
		t.Fatal("refused patch modified the binary")
	}
	// A binary that matches the registered output but carries limit's patch
	// record reports PATCH_CONFLICT and is never auto-restored.
	if err = os.WriteFile(binary, fixture.patched, 0600); err != nil {
		t.Fatal(err)
	}
	backups := filepath.Join(os.Getenv("AGYCTL_HOME"), "backups")
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
	result, code, err = Run(root, nil, []string{"patch", "--binary", binary, "--apply"})
	if code == 0 || err == nil || !strings.Contains(err.Error(), "PATCH_CONFLICT") {
		t.Fatalf("limit conflict refusal = %v (%d)", err, code)
	}
	if refusal := result.(map[string]any)["refusal"].(*Refusal); refusal.Kind != RefusalPatchConflict {
		t.Fatalf("limit conflict lost its structured refusal: %+v", result)
	}
	if content, err := os.ReadFile(binary); err != nil || !bytes.Equal(content, fixture.patched) {
		t.Fatal("conflict refusal modified the binary")
	}
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
	// An external edit after the patch is never overwritten by restore.
	drifted := bytes.Clone(fixture.patched)
	drifted[0x300] ^= 0xff
	if err := os.WriteFile(binary, drifted, 0600); err != nil {
		t.Fatal(err)
	}
	_, code, err := Run(root, nil, []string{"restore", "--binary", binary})
	if code == 0 || err == nil || !strings.Contains(err.Error(), "changed since the last compaction patch") {
		t.Fatalf("drift refusal = %v (%d)", err, code)
	}
	if content, err := os.ReadFile(binary); err != nil || !bytes.Equal(content, drifted) {
		t.Fatal("refused restore modified the binary")
	}
}

func TestRestoreRefusesMissingBackup(t *testing.T) {
	fixture := syntheticFixtureData(t, 0x10, nil)
	root := fixtureRoot(t, fixture.registryJS)
	dataHome(t)
	binary := filepath.Join(root, "language_server.exe")
	if err := os.WriteFile(binary, fixture.image, 0600); err != nil {
		t.Fatal(err)
	}
	result, code, err := Run(root, nil, []string{"patch", "--binary", binary, "--apply"})
	if err != nil || code != 0 {
		t.Fatalf("apply failed: %v (%d)", err, code)
	}
	record := result.(map[string]any)["record"].(map[string]any)
	// Removing the recorded backups must make restore refuse instead of
	// guessing; a single surviving backup is still enough to restore.
	if err = os.Remove(record["backup_sibling"].(string)); err != nil {
		t.Fatal(err)
	}
	if err = os.Remove(record["repo_backup"].(string)); err != nil {
		t.Fatal(err)
	}
	if err = os.Remove(binary + ".orig"); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	_, code, err = Run(root, nil, []string{"restore", "--binary", binary})
	if code == 0 || err == nil || !strings.Contains(err.Error(), "no verified backup") {
		t.Fatalf("missing backup refusal = %v (%d)", err, code)
	}
}

func TestStatusReportsUnknownEffectiveState(t *testing.T) {
	fixture := syntheticFixtureData(t, 0x10, nil)
	root := fixtureRoot(t, fixture.registryJS)
	dataHome(t)
	binary := filepath.Join(root, "language_server.exe")
	if err := os.WriteFile(binary, fixture.image, 0600); err != nil {
		t.Fatal(err)
	}
	result, code, err := Run(root, nil, []string{"status", "--binary", binary})
	if err != nil || code != 0 {
		t.Fatalf("status failed: %v (%d)", err, code)
	}
	statusResult := result.(map[string]any)
	if statusResult["file_state"] != "registered-input" || statusResult["effective_state"] != "unknown" {
		t.Fatalf("status result = %+v", statusResult)
	}
}

func interruptedTransaction(t *testing.T, action, disk string, recorded bool) (string, string, store, map[string]any) {
	t.Helper()
	fixture := syntheticFixtureData(t, 0x10, nil)
	root := fixtureRoot(t, fixture.registryJS)
	s := store{directory: filepath.Join(dataHome(t), "backups")}
	binary := filepath.Join(root, "language_server.exe")
	if err := os.MkdirAll(s.directory, 0700); err != nil {
		t.Fatal(err)
	}
	image := fixture.image
	if disk == "output" {
		image = fixture.patched
	}
	if err := os.WriteFile(binary, image, 0600); err != nil {
		t.Fatal(err)
	}
	before, after := fsx.SHA256(fixture.image), fsx.SHA256(fixture.patched)
	repo, err := s.backupPath(binary, before)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{binary + ".orig", repo} {
		if err = os.WriteFile(path, fixture.image, 0600); err != nil {
			t.Fatal(err)
		}
	}
	reg, err := LoadRegistry(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	target, err := apptarget.Normalized(binary)
	if err != nil {
		t.Fatal(err)
	}
	prepared := map[string]any{
		"schema": 1, "status": "prepared", "operation": "interrupted-transaction", "target": target,
		"target_id": "synthetic", "input": "original", "recipe_fingerprint": reg.Targets[0].Inputs[0].Fingerprint(),
		"binary_sha256_before": before, "binary_sha256_after": after, "bytes_changed": 6,
		"qualification": "candidate", "created_at": "2026-11-15T00:00:00Z",
		"backups": []map[string]any{{"kind": "sibling", "path": binary + ".orig", "sha256": before}, {"kind": "repo", "path": repo, "sha256": before}},
	}
	if action != "" {
		prepared["action"] = action
	}
	patchRecord := map[string]any{
		"action": "patch", "binary_path": binary, "operation": "interrupted-transaction",
		"binary_sha256_before": before, "binary_sha256_after": after,
		"target_id": "synthetic", "input": "original", "recipe_fingerprint": prepared["recipe_fingerprint"],
		"backup_sibling": binary + ".orig", "backup_sibling_sha256": before, "repo_backup": repo, "repo_backup_sha256": before,
		"qualification": "candidate", "bytes_changed": 6,
	}
	if action == "restore" {
		patchRecord["operation"] = "original-patch"
		if err = s.append(patchRecord); err != nil {
			t.Fatal(err)
		}
		if recorded {
			if err = s.append(map[string]any{"action": "restore", "binary_path": binary, "operation": "interrupted-transaction", "binary_sha256": before, "target_id": "synthetic", "input": "original", "recipe_fingerprint": prepared["recipe_fingerprint"]}); err != nil {
				t.Fatal(err)
			}
		}
	} else if recorded {
		if err = s.append(patchRecord); err != nil {
			t.Fatal(err)
		}
	}
	writeInterruptedPrepare(t, s, binary, prepared)
	return root, binary, s, prepared
}

func writeInterruptedPrepare(t *testing.T, s store, binary string, prepared map[string]any) {
	t.Helper()
	path, err := s.preparePath(binary)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, mustJSON(t, prepared), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestInterruptedCompactionRecovery(t *testing.T) {
	for _, tc := range []struct {
		name, action, disk, command string
		recorded                    bool
		records                     int
	}{
		{"legacy apply before replace", "", "input", "patch", false, 1},
		{"legacy apply after replace", "", "output", "patch", false, 1},
		{"apply after append", "patch", "output", "patch", true, 1},
		{"cancel apply before replace", "patch", "input", "restore", false, 0},
		{"undo interrupted apply", "patch", "output", "restore", false, 2},
		{"restore before replace", "restore", "output", "restore", false, 2},
		{"restore after replace", "restore", "input", "restore", false, 2},
		{"restore after append", "restore", "input", "restore", true, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root, binary, s, _ := interruptedTransaction(t, tc.action, tc.disk, tc.recorded)
			args := []string{tc.command, "--binary", binary}
			if tc.command == "patch" {
				args = append(args, "--apply")
			}
			for attempt := 0; attempt < 2; attempt++ {
				result, code, err := Run(root, nil, args)
				if err != nil || code != 0 {
					t.Fatalf("recovery attempt %d: result=%+v code=%d err=%v", attempt, result, code, err)
				}
				fixture := syntheticFixtureData(t, 0x10, nil)
				want := fixture.patched
				if tc.command == "restore" {
					want = fixture.image
				}
				if got, err := os.ReadFile(binary); err != nil || !bytes.Equal(got, want) {
					t.Fatalf("recovery bytes mismatch: %v", err)
				}
				m, err := s.load()
				if err != nil || len(m.Records) != tc.records {
					t.Fatalf("recovery records=%+v err=%v, want %d records", m.Records, err, tc.records)
				}
				if prepared, err := s.loadPrepare(binary); err != nil || prepared != nil {
					t.Fatalf("completed prepare retained: %+v, %v", prepared, err)
				}
			}
		})
	}
}

func TestInterruptedCompactionRefusesUnverifiedEvidence(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*testing.T, string, store, map[string]any)
	}{
		{"foreign target", func(_ *testing.T, _ string, _ store, p map[string]any) { p["target"] = "foreign" }},
		{"missing operation", func(_ *testing.T, _ string, _ store, p map[string]any) { p["operation"] = "" }},
		{"foreign action", func(_ *testing.T, _ string, _ store, p map[string]any) { p["action"] = "other-feature" }},
		{"changed recipe", func(_ *testing.T, _ string, _ store, p map[string]any) {
			p["recipe_fingerprint"] = strings.Repeat("0", 64)
		}},
		{"wrong output", func(_ *testing.T, _ string, _ store, p map[string]any) {
			p["binary_sha256_after"] = strings.Repeat("0", 64)
		}},
		{"missing repo evidence", func(_ *testing.T, _ string, _ store, p map[string]any) {
			p["backups"] = p["backups"].([]map[string]any)[:1]
		}},
		{"wrong backup hash", func(_ *testing.T, _ string, _ store, p map[string]any) {
			p["backups"].([]map[string]any)[0]["sha256"] = strings.Repeat("0", 64)
		}},
		{"foreign backup path", func(_ *testing.T, binary string, _ store, p map[string]any) {
			p["backups"].([]map[string]any)[1]["path"] = binary + ".orig"
		}},
		{"corrupt backup", func(t *testing.T, _ string, _ store, p map[string]any) {
			if err := os.WriteFile(p["backups"].([]map[string]any)[1]["path"].(string), []byte("corrupt"), 0600); err != nil {
				t.Fatal(err)
			}
		}},
		{"foreign drift", func(t *testing.T, binary string, _ store, _ map[string]any) {
			if err := os.WriteFile(binary, syntheticImage(0x42), 0600); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root, binary, s, prepared := interruptedTransaction(t, "patch", "output", false)
			tc.mutate(t, binary, s, prepared)
			writeInterruptedPrepare(t, s, binary, prepared)
			path, err := s.preparePath(binary)
			if err != nil {
				t.Fatal(err)
			}
			beforePrepare, _ := os.ReadFile(path)
			beforeBinary, _ := os.ReadFile(binary)
			for _, command := range []string{"patch", "restore"} {
				args := []string{command, "--binary", binary}
				if command == "patch" {
					args = append(args, "--apply")
				}
				result, code, runErr := Run(root, nil, args)
				if code != 1 || runErr == nil {
					t.Fatalf("unverified recovery accepted: result=%+v code=%d err=%v", result, code, runErr)
				}
				refusal, ok := result.(map[string]any)["refusal"].(*Refusal)
				if !ok || refusal.Kind != "prepare-invalid" || result.(map[string]any)["error"] != runErr.Error() {
					t.Fatalf("missing structured recovery refusal: %+v, %v", result, runErr)
				}
				if got, _ := os.ReadFile(path); !bytes.Equal(got, beforePrepare) {
					t.Fatal("refused recovery changed prepare")
				}
				if got, _ := os.ReadFile(binary); !bytes.Equal(got, beforeBinary) {
					t.Fatal("refused recovery changed binary")
				}
				if _, statErr := os.Stat(s.path()); !os.IsNotExist(statErr) {
					t.Fatalf("refused recovery created manifest: %v", statErr)
				}
			}
		})
	}
}

func TestInterruptedCompactionRejectsConflictingHistory(t *testing.T) {
	for _, tc := range []struct {
		name, action, disk string
		recorded           bool
		mutate             func(map[string]any, *manifest)
	}{
		{"patch operation mismatch", "patch", "output", true, func(p map[string]any, _ *manifest) { p["operation"] = "different-operation" }},
		{"restore recipe mismatch", "restore", "input", false, func(_ map[string]any, m *manifest) { m.Records[0]["recipe_fingerprint"] = strings.Repeat("0", 64) }},
		{"completed restore hash mismatch", "restore", "input", true, func(_ map[string]any, m *manifest) { m.Records[1]["binary_sha256"] = strings.Repeat("0", 64) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root, binary, s, prepared := interruptedTransaction(t, tc.action, tc.disk, tc.recorded)
			m, err := s.load()
			if err != nil {
				t.Fatal(err)
			}
			tc.mutate(prepared, &m)
			beforeManifest := mustJSON(t, m)
			if err = os.WriteFile(s.path(), beforeManifest, 0600); err != nil {
				t.Fatal(err)
			}
			writeInterruptedPrepare(t, s, binary, prepared)
			result, code, runErr := Run(root, nil, []string{"restore", "--binary", binary})
			if code != 1 || runErr == nil || result.(map[string]any)["refusal"].(*Refusal).Kind != "prepare-invalid" {
				t.Fatalf("history mismatch was not refused: %+v, %d, %v", result, code, runErr)
			}
			if after, err := os.ReadFile(s.path()); err != nil || !bytes.Equal(after, beforeManifest) {
				t.Fatalf("refusal changed manifest: %v", err)
			}
			if p, err := s.loadPrepare(binary); err != nil || p == nil {
				t.Fatalf("refusal lost prepare: %+v, %v", p, err)
			}
		})
	}
}

func TestInterruptedCompactionReadOnlyDoesNotRecover(t *testing.T) {
	root, binary, s, _ := interruptedTransaction(t, "patch", "output", false)
	path, err := s.preparePath(binary)
	if err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, command := range []string{"status", "patch"} {
		result, code, runErr := Run(root, nil, []string{command, "--binary", binary})
		if command == "status" && (code != 0 || runErr != nil || result.(map[string]any)["file_state"] != "recognized-output") {
			t.Fatalf("status = %+v, %d, %v", result, code, runErr)
		}
		if command == "patch" && (code != 1 || runErr == nil) {
			t.Fatalf("preview must refuse unmanaged output: %+v, %d, %v", result, code, runErr)
		}
		if got, _ := os.ReadFile(path); !bytes.Equal(got, before) {
			t.Fatal("read-only operation changed prepare")
		}
		if _, err := os.Stat(s.path()); !os.IsNotExist(err) {
			t.Fatalf("read-only operation created manifest: %v", err)
		}
	}
}

func TestInterruptedRestoreRequiresExplicitRestore(t *testing.T) {
	root, binary, s, _ := interruptedTransaction(t, "restore", "input", false)
	beforeManifest, err := os.ReadFile(s.path())
	if err != nil {
		t.Fatal(err)
	}
	result, code, err := Run(root, nil, []string{"patch", "--binary", binary, "--apply"})
	if code != 1 || err == nil || !strings.Contains(err.Error(), "resume it with 'compaction restore'") {
		t.Fatalf("patch did not reject interrupted restore: %+v, %d, %v", result, code, err)
	}
	if after, err := os.ReadFile(s.path()); err != nil || !bytes.Equal(after, beforeManifest) {
		t.Fatalf("patch changed pending restore history: %v", err)
	}
	if p, err := s.loadPrepare(binary); err != nil || p == nil || p.action() != "restore" {
		t.Fatalf("patch changed pending restore: %+v, %v", p, err)
	}
}
