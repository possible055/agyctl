package limit

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"agyctl/internal/assets"
	"agyctl/internal/fsx"
	"agyctl/internal/layout"
	"agyctl/internal/testutil"
	"agyctl/internal/winproc"
)

func fixtures(t *testing.T) (registry, []byte) {
	t.Helper()
	reg, err := loadRegistry(filepath.Join("..", "..", "..", ".."), nil)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "limit", "original.bin"))
	if err != nil {
		t.Fatal(err)
	}
	return reg, data
}

func elfFixture(t *testing.T) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "limit", "original-elf.bin"))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

type goldenImage struct {
	OriginalSHA string     `json:"original_sha256"`
	PatchedSHA  string     `json:"patched_sha256"`
	Plan        Plan       `json:"plan"`
	State       PatchState `json:"state"`
}

type goldenFile struct {
	Assembly []struct {
		IDs      []int  `json:"ids"`
		Limit    int    `json:"limit"`
		FuncVA   uint64 `json:"func_va"`
		TableVA  uint64 `json:"table_va"`
		BodyHex  string `json:"body_hex"`
		TableHex string `json:"table_hex"`
	} `json:"assembly"`
	Synthetic    goldenImage `json:"synthetic"`
	SyntheticELF goldenImage `json:"synthetic_elf"`
	Real         goldenImage `json:"real"`
}

func readGolden(t *testing.T) goldenFile {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "limit", "golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var golden goldenFile
	if err = json.Unmarshal(data, &golden); err != nil {
		t.Fatal(err)
	}
	return golden
}

func TestFixedVectorAssemblyAndImageContract(t *testing.T) {
	golden := readGolden(t)
	for i, entry := range golden.Assembly {
		body, err := Assemble(entry.IDs, entry.Limit, entry.FuncVA, entry.TableVA)
		if err != nil {
			t.Fatal(err)
		}
		if hex.EncodeToString(body) != entry.BodyHex {
			t.Fatalf("assembly case %d differs from FixedVector golden", i)
		}
		_, _, table, err := buildTable(entry.IDs)
		if err != nil {
			t.Fatal(err)
		}
		if hex.EncodeToString(table) != entry.TableHex {
			t.Fatalf("bitset case %d differs from FixedVector golden", i)
		}
	}
	reg, data := fixtures(t)
	checkImageGolden(t, data, reg, golden.Synthetic)
}

func checkImageGolden(t *testing.T, data []byte, reg registry, golden goldenImage) {
	t.Helper()
	if actual := fsx.SHA256(data); actual != golden.OriginalSHA {
		t.Fatalf("original SHA = %s, want %s", actual, golden.OriginalSHA)
	}
	state, err := DetectState(data, reg.originals)
	if err != nil {
		t.Fatal(err)
	}
	if state.Kind != "original" {
		t.Fatalf("state = %s, want original", state.Kind)
	}
	ids, err := ParseIDs(DefaultIDs)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := PlanPatch(data, ids, DefaultLimit)
	if err != nil {
		t.Fatal(err)
	}
	actualPlan, _ := json.Marshal(plan)
	expectedPlan, _ := json.Marshal(golden.Plan)
	if !bytes.Equal(actualPlan, expectedPlan) {
		t.Fatalf("plan = %s, want %s", actualPlan, expectedPlan)
	}
	patched := ApplyPatch(data, plan)
	if actual := fsx.SHA256(patched); actual != golden.PatchedSHA {
		t.Fatalf("patched SHA = %s, want %s", actual, golden.PatchedSHA)
	}
	state, err = DetectState(patched, reg.originals)
	if err != nil {
		t.Fatal(err)
	}
	if state.Kind != "patched" || !reflect.DeepEqual(state.IDs, ids) || state.Limit != DefaultLimit || state.TableOff != plan.TableOff {
		t.Fatalf("decoded patch = %+v", state)
	}
}

func TestELFSyntheticGolden(t *testing.T) {
	golden := readGolden(t)
	reg, _ := fixtures(t)
	checkImageGolden(t, elfFixture(t), reg, golden.SyntheticELF)
}

func TestELFTextBaseEvidenceIsEnforced(t *testing.T) {
	reg, _ := fixtures(t)
	data := elfFixture(t)
	if state, err := DetectState(data, reg.originals); err != nil || state.Kind != "original" || state.Format != "elf" || state.Arch != "x86-64" {
		t.Fatalf("ELF fixture state = %s format %s arch %s (%v)", state.Kind, state.Format, state.Arch, err)
	}
	ids, err := ParseIDs(DefaultIDs)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = PlanPatch(data, ids, DefaultLimit); err != nil {
		t.Fatal(err)
	}
	// moduledata field 176 (text) lives at 0x250B0, field 184 (etext) at
	// 0x250B8; the first RELA entry holds r_info at 0x25108 and its addend at
	// 0x25110; the pclntab header textStart is at 0x15018.
	for _, mutation := range []struct {
		name    string
		offset  int
		message string
	}{
		{name: "header text base disagrees with moduledata", offset: 0x15018, message: "text bases disagree"},
		{name: "moduledata text base disagrees with header", offset: 0x250B0, message: "text bases disagree"},
		{name: "moduledata does not reference the pclntab", offset: 0x25110, message: "does not reference this Go pclntab"},
		{name: "unsupported moduledata relocation", offset: 0x25108, message: "unsupported ELF Go moduledata relocation"},
		{name: "text range outside .text", offset: 0x250B8, message: "outside .text"},
	} {
		t.Run(mutation.name, func(t *testing.T) {
			mutated := bytes.Clone(data)
			mutated[mutation.offset] ^= 0x80
			_, err := PlanPatch(mutated, ids, DefaultLimit)
			if err == nil || !strings.Contains(err.Error(), mutation.message) {
				t.Fatalf("mutated ELF plan error = %v, want %q", err, mutation.message)
			}
		})
	}
	// A zeroed pcHeader textStart falls back to the intact moduledata.
	fallback := bytes.Clone(data)
	for i := 0x15018; i < 0x15020; i++ {
		fallback[i] = 0
	}
	if _, err = PlanPatch(fallback, ids, DefaultLimit); err != nil {
		t.Fatalf("moduledata-only text base must keep planning: %v", err)
	}
}

func TestELFByteGate(t *testing.T) {
	reg, _ := fixtures(t)
	data := elfFixture(t)
	ids, err := ParseIDs(DefaultIDs)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := PlanPatch(data, ids, DefaultLimit)
	if err != nil {
		t.Fatal(err)
	}
	patched := ApplyPatch(data, plan)
	for _, offset := range []int{0, 4, 70, 127} {
		mutated := bytes.Clone(patched)
		mutated[plan.FuncOff+offset] ^= 1
		state, err := DetectState(mutated, reg.originals)
		if err != nil {
			t.Fatal(err)
		}
		if state.Kind != "unknown" {
			t.Fatalf("tampered ELF offset %d classified %s", offset, state.Kind)
		}
	}
}

func TestRealBinaryFixedVectorDifferential(t *testing.T) {
	path := os.Getenv("AGYCTL_LIMIT_TEST_BINARY")
	if path == "" {
		t.Skip("AGYCTL_LIMIT_TEST_BINARY is not set; real installed binary is read-only and never patched by this test")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	reg, _ := fixtures(t)
	golden := readGolden(t).Real
	checkImageGolden(t, data, reg, golden)
	directory := testutil.TempDir(t)
	input := filepath.Join(directory, "language_server.exe")
	output := filepath.Join(directory, "patched.exe")
	if err = os.WriteFile(input, data, 0600); err != nil {
		t.Fatal(err)
	}
	_, code, err := Run(filepath.Join("..", "..", "..", ".."), nil, []string{"patch", "--binary", input, "--dry-run", "--out", output, "--json"})
	if code != 0 || err != nil {
		t.Fatalf("copy dry-run exit=%d error=%v", code, err)
	}
	if sha, err := fsx.Hash(output); err != nil || sha != golden.PatchedSHA {
		t.Fatalf("copy dry-run SHA = %s, error=%v", sha, err)
	}
	if sha, err := fsx.Hash(input); err != nil || sha != golden.OriginalSHA {
		t.Fatalf("copy dry-run modified input: SHA=%s error=%v", sha, err)
	}
	after, err := fsx.Hash(path)
	if err != nil {
		t.Fatal(err)
	}
	if after != fsx.SHA256(data) {
		t.Fatal("real binary changed during read-only differential check")
	}
}

func TestByteGateAndPatchIntegrity(t *testing.T) {
	reg, data := fixtures(t)
	ids, err := ParseIDs(DefaultIDs)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := PlanPatch(data, ids, DefaultLimit)
	if err != nil {
		t.Fatal(err)
	}
	for _, offset := range []int{4, 70, 127} {
		patched := ApplyPatch(data, plan)
		patched[plan.FuncOff+offset] ^= 1
		state, err := DetectState(patched, reg.originals)
		if err != nil {
			t.Fatal(err)
		}
		if state.Kind != "unknown" {
			t.Fatalf("tampered offset %d classified %s", offset, state.Kind)
		}
	}
	foreign := bytes.Clone(data)
	foreign[plan.FuncOff+60] ^= 0xff
	state, err := DetectState(foreign, reg.originals)
	if err != nil {
		t.Fatal(err)
	}
	if state.Kind != "unknown" {
		t.Fatalf("foreign body classified %s", state.Kind)
	}
	binary := filepath.Join(testutil.TempDir(t), "language_server.exe")
	if err = os.WriteFile(binary, foreign, 0600); err != nil {
		t.Fatal(err)
	}
	_, err = patch(binary, options{ids: DefaultIDs, limit: DefaultLimit, dryRun: true}, reg, store{directory: testutil.TempDir(t)}, nil)
	if err == nil || !strings.Contains(err.Error(), "match no recorded original") {
		t.Fatalf("byte gate error = %v", err)
	}
	if err = os.WriteFile(binary, data, 0600); err != nil {
		t.Fatal(err)
	}
	backup := binary + ".orig"
	if err = os.WriteFile(backup, []byte("preserved backup"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err = patch(binary, options{ids: DefaultIDs, limit: DefaultLimit, dryRun: true, out: backup}, reg, store{directory: testutil.TempDir(t)}, nil)
	if !errors.Is(err, os.ErrExist) {
		t.Fatalf("existing dry-run output error = %v", err)
	}
	if actual, err := os.ReadFile(backup); err != nil || string(actual) != "preserved backup" {
		t.Fatal("dry-run overwrote existing backup")
	}
	withoutCave := bytes.Clone(data)
	copy(withoutCave[plan.TableOff-8:plan.TableOff+16], make([]byte, 24))
	_, err = PlanPatch(withoutCave, ids, DefaultLimit)
	if err == nil || err.Error() != "no int3 padding cave found near the function" {
		t.Fatalf("missing cave error = %v", err)
	}
}

func TestModelIDsAndTargets(t *testing.T) {
	ids, err := ParseIDs("1318-1320, 1400,1318")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(ids, []int{1318, 1319, 1320, 1400}) {
		t.Fatalf("parsed ids = %v", ids)
	}
	for _, entry := range []struct{ spec, message string }{{"1320-1318", "bad range"}, {"1000-1129", "128-wide window"}, {", ", "no model ids given"}} {
		_, err := ParseIDs(entry.spec)
		if err == nil || !strings.Contains(err.Error(), entry.message) {
			t.Fatalf("parse %q error = %v", entry.spec, err)
		}
	}
	for _, target := range []int{0, -1, 2147483648} {
		_, err := Assemble([]int{1318}, target, 0x1000, 0x1100)
		if err == nil || err.Error() != "bad target" {
			t.Fatalf("target %d error = %v", target, err)
		}
	}
}

func TestMutationRequiresKnownStoppedLanguageServer(t *testing.T) {
	stopped, running := false, true
	probeFailure := errors.New("process inventory denied")
	for _, entry := range []struct {
		name     string
		running  *bool
		probeErr error
		message  string
	}{
		{name: "stopped", running: &stopped},
		{name: "running", running: &running, message: "language server is running"},
		{name: "unknown", message: "language server process state is unknown"},
		{name: "failed probe", probeErr: probeFailure, message: "cannot verify language server process state"},
		{name: "failed probe with stale stopped value", running: &stopped, probeErr: probeFailure, message: "cannot verify language server process state"},
	} {
		t.Run(entry.name, func(t *testing.T) {
			err := requireStopped(entry.running, entry.probeErr)
			if entry.message == "" {
				if err != nil {
					t.Fatalf("known stopped state rejected: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), entry.message) {
				t.Fatalf("process guard error = %v, want %q", err, entry.message)
			}
			if entry.probeErr != nil && !errors.Is(err, entry.probeErr) {
				t.Fatalf("process probe error was lost: %v", err)
			}
		})
	}
}

func TestTargetForBinarySelectsOnlyItsInstallation(t *testing.T) {
	root := filepath.Join(string(filepath.Separator), "installs")
	candidates := []layout.Target{
		{LanguageServer: filepath.Join(root, "stable", "bin", "language_server.exe"), Executable: filepath.Join(root, "stable", "Antigravity.exe")},
		{LanguageServer: filepath.Join(root, "insiders", "bin", "language_server.exe"), Executable: filepath.Join(root, "insiders", "Antigravity.exe")},
	}
	for _, test := range []struct {
		name   string
		binary string
		want   winproc.Target
	}{
		{name: "stable", binary: candidates[0].LanguageServer, want: winproc.Target{BinaryPath: candidates[0].LanguageServer, ExecutablePath: candidates[0].Executable}},
		{name: "insiders", binary: candidates[1].LanguageServer, want: winproc.Target{BinaryPath: candidates[1].LanguageServer, ExecutablePath: candidates[1].Executable}},
		{name: "unmatched", binary: filepath.Join(root, "other", "language_server.exe"), want: winproc.Target{BinaryPath: filepath.Join(root, "other", "language_server.exe")}},
		{name: "not a directory prefix match", binary: candidates[0].LanguageServer + ".copy", want: winproc.Target{BinaryPath: candidates[0].LanguageServer + ".copy"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got, err := targetForBinary(test.binary, candidates); err != nil || got != test.want {
				t.Fatalf("process target = %+v, want %+v, error=%v", got, test.want, err)
			}
		})
	}
}

func TestCustomBinaryRetainsItsPairedClient(t *testing.T) {
	root, err := filepath.EvalSymlinks(testutil.TempDir(t))
	if err != nil {
		t.Fatal(err)
	}
	defaultRoot := filepath.Join(root, "default")
	selectedRoot := filepath.Join(root, "stable-2.29")
	binary := filepath.Join(selectedRoot, "resources", "bin", "language_server.exe")
	executable := filepath.Join(selectedRoot, "Antigravity.exe")
	candidates := []layout.Target{{
		Root:           defaultRoot,
		LanguageServer: filepath.Join(defaultRoot, "resources", "bin", "language_server.exe"),
		Executable:     filepath.Join(defaultRoot, "Antigravity.exe"),
	}}
	if err := os.MkdirAll(filepath.Dir(binary), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(executable, []byte("client identity fixture, never executed"), 0600); err != nil {
		t.Fatal(err)
	}
	want := winproc.Target{BinaryPath: binary, ExecutablePath: executable}
	if got, err := targetForBinary(binary, candidates); err != nil || got != want {
		t.Fatalf("custom process target = %+v, want %+v, error=%v", got, want, err)
	}
	if err := os.Remove(executable); err != nil {
		t.Fatal(err)
	}
	if _, err := targetForBinary(binary, candidates); err == nil || !strings.Contains(err.Error(), "paired client executable not found") {
		t.Fatalf("missing paired executable error = %v", err)
	}
	if err := os.WriteFile(executable, []byte("client identity fixture, never executed"), 0600); err != nil {
		t.Fatal(err)
	}
	insiders := filepath.Join(selectedRoot, "Antigravity - Insiders.exe")
	if err := os.WriteFile(insiders, []byte("client identity fixture, never executed"), 0600); err != nil {
		t.Fatal(err)
	}
	candidates = append(candidates, layout.Target{
		Root:           defaultRoot,
		LanguageServer: candidates[0].LanguageServer,
		Executable:     filepath.Join(defaultRoot, "Antigravity - Insiders.exe"),
	})
	if _, err := targetForBinary(binary, candidates); err == nil || !strings.Contains(err.Error(), "ambiguous paired client") {
		t.Fatalf("ambiguous paired executable error = %v", err)
	}
}

func TestPatchRestorePreservesBackupsAndRejectsDrift(t *testing.T) {
	reg, original := fixtures(t)
	ids, err := ParseIDs(DefaultIDs)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := PlanPatch(original, ids, DefaultLimit)
	if err != nil {
		t.Fatal(err)
	}
	directory := testutil.TempDir(t)
	binary := filepath.Join(directory, "language_server.exe")
	stale := append(bytes.Clone(original), []byte("old build")...)
	if err = os.WriteFile(binary, original, 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(binary+".orig", stale, 0600); err != nil {
		t.Fatal(err)
	}
	s := store{directory: filepath.Join(directory, "backups")}
	patched := ApplyPatch(original, plan)
	record, err := patchBinary(binary, original, patched, fsx.SHA256(original), "test", "unverified", ids, DefaultLimit, plan, s, "")
	if err != nil {
		t.Fatal(err)
	}
	backup := stringField(record, "backup_sibling")
	if backup == binary+".orig" {
		t.Fatal("stale sibling was reused")
	}
	if sha, err := fsx.Hash(backup); err != nil || sha != fsx.SHA256(original) {
		t.Fatalf("versioned sibling SHA = %s, %v", sha, err)
	}
	newer := append(bytes.Clone(patched), []byte("new build")...)
	if err = os.WriteFile(binary, newer, 0600); err != nil {
		t.Fatal(err)
	}
	_, err = restoreBinary(binary, reg, s, "")
	if err == nil || !strings.Contains(err.Error(), "changed since the last patch") {
		t.Fatalf("drift guard error = %v", err)
	}
	if actual, err := os.ReadFile(binary); err != nil || !bytes.Equal(actual, newer) {
		t.Fatal("drift guard changed installed bytes")
	}
	if err = os.WriteFile(binary, patched, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = restoreBinary(binary, reg, s, ""); err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string][]byte{binary: original, binary + ".orig": stale, backup: original, stringField(record, "repo_backup"): original} {
		actual, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(actual, want) {
			t.Fatalf("preserved file %s differs: %v", path, err)
		}
	}
}

func TestFixedVectorManifestRestoreAndUnrecordedBackup(t *testing.T) {
	reg, original := fixtures(t)
	ids, err := ParseIDs(DefaultIDs)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := PlanPatch(original, ids, DefaultLimit)
	if err != nil {
		t.Fatal(err)
	}
	for _, recorded := range []bool{true, false} {
		directory := testutil.TempDir(t)
		binary := filepath.Join(directory, "language_server.exe")
		sibling := binary + ".orig"
		s := store{directory: filepath.Join(directory, "backups")}
		if err = os.WriteFile(binary, ApplyPatch(original, plan), 0600); err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(sibling, original, 0600); err != nil {
			t.Fatal(err)
		}
		if recorded {
			data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "limit", "manifest.json"))
			if err != nil {
				t.Fatal(err)
			}
			var fixture manifest
			if err = json.Unmarshal(data, &fixture); err != nil {
				t.Fatal(err)
			}
			fixture.Records[0]["binary_path"] = binary
			fixture.Records[0]["backup_sibling"] = sibling
			fixture.Records[0]["repo_backup"] = filepath.Join(s.directory, "original.exe")
			data, err = json.Marshal(fixture)
			if err != nil {
				t.Fatal(err)
			}
			if err = os.MkdirAll(s.directory, 0700); err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(s.path(), data, 0600); err != nil {
				t.Fatal(err)
			}
		}
		if _, err = restoreBinary(binary, reg, s, ""); err != nil {
			t.Fatalf("recorded=%v: %v", recorded, err)
		}
		if actual, err := fsx.Hash(binary); err != nil || actual != fsx.SHA256(original) {
			t.Fatalf("recorded=%v original SHA = %s, %v", recorded, actual, err)
		}
	}
}

func TestLegacyZeroIDPatchAndUnrecordedRestore(t *testing.T) {
	reg, original := fixtures(t)
	directory := testutil.TempDir(t)
	binary := filepath.Join(directory, "language_server.bin")
	s := store{directory: filepath.Join(directory, "state")}
	if err := os.WriteFile(binary, original, 0600); err != nil {
		t.Fatal(err)
	}
	o, err := parseOptions([]string{"patch", "--ids", "0"})
	if err != nil {
		t.Fatal(err)
	}
	preview, err := patch(binary, o, reg, s, nil)
	want := []ModelLimit{{ID: 0, Limit: DefaultLimit}}
	if err != nil || !reflect.DeepEqual(preview["model_limits"], want) {
		t.Fatalf("legacy zero-ID preview = %v (%v)", preview, err)
	}
	plan := preview["plan"].(Plan)
	if _, err = patchBinary(binary, original, ApplyPatch(original, plan), fsx.SHA256(original), "", "unverified", []int{0}, DefaultLimit, plan, s, ""); err != nil {
		t.Fatal(err)
	}
	reported, err := status(binary, reg, s, nil)
	if err != nil {
		t.Fatal(err)
	}
	summary := reported.(map[string]any)
	if summary["settings_state"] != "applied" || !reflect.DeepEqual(summary["patch_state"].(map[string]any)["model_limits"], want) {
		t.Fatalf("legacy zero-ID status = %+v", summary)
	}
	if err = os.Remove(s.path()); err != nil {
		t.Fatal(err)
	}
	if _, err = restoreBinary(binary, reg, s, ""); err != nil {
		t.Fatal(err)
	}
	if actual, err := fsx.Hash(binary); err != nil || actual != fsx.SHA256(original) {
		t.Fatalf("legacy zero-ID restored SHA = %s (%v)", actual, err)
	}
}

func TestFixedVectorStatusJSONContract(t *testing.T) {
	reg, original := fixtures(t)
	goldenData, err := os.ReadFile(filepath.Join("..", "..", "testdata", "limit", "status.json"))
	if err != nil {
		t.Fatal(err)
	}
	var expected map[string]map[string]any
	if err = json.Unmarshal(goldenData, &expected); err != nil {
		t.Fatal(err)
	}
	ids, err := ParseIDs(DefaultIDs)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := PlanPatch(original, ids, DefaultLimit)
	if err != nil {
		t.Fatal(err)
	}
	directory := testutil.TempDir(t)
	binary := filepath.Join(directory, "resources", "bin", "language_server.exe")
	s := store{directory: filepath.Join(directory, "backups")}
	if err = os.MkdirAll(filepath.Dir(binary), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(binary, original, 0600); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"original", "patched"} {
		if kind == "patched" {
			if _, err = patchBinary(binary, original, ApplyPatch(original, plan), fsx.SHA256(original), "", "unverified", ids, DefaultLimit, plan, s, ""); err != nil {
				t.Fatal(err)
			}
		}
		before, err := s.load()
		if err != nil {
			t.Fatal(err)
		}
		result, err := status(binary, reg, s, nil)
		if err != nil {
			t.Fatal(err)
		}
		data, err := json.Marshal(result)
		if err != nil {
			t.Fatal(err)
		}
		var actual map[string]any
		if err = json.Unmarshal(data, &actual); err != nil {
			t.Fatal(err)
		}
		actual["binary"] = "$BINARY"
		actual["language_server_running"] = "$RUNNING"
		delete(actual, "warnings")
		for key, placeholder := range map[string]string{"sibling_backup": "$SIBLING", "repo_backup": "$REPO_BACKUP"} {
			report := actual[key].(map[string]any)
			if report["path"] != nil {
				report["path"] = placeholder
			}
		}
		patchState := actual["patch_state"].(map[string]any)
		if kind == "patched" {
			decoded, _ := json.Marshal(patchState["model_limits"])
			want, _ := json.Marshal(uniformLimits(ids, DefaultLimit))
			if !bytes.Equal(decoded, want) || actual["settings_state"] != "applied" || actual["saved_settings"] == nil {
				t.Fatalf("additive settings contract = %s", data)
			}
		} else if patchState["model_limits"] != nil || actual["settings_state"] != "not-configured" || actual["saved_settings"] != nil {
			t.Fatalf("original settings contract = %s", data)
		}
		delete(patchState, "model_limits")
		delete(patchState, "encoding")
		delete(actual, "saved_settings")
		delete(actual, "settings_state")
		if !reflect.DeepEqual(actual, expected[kind]) {
			t.Fatalf("%s status = %s; want %+v", kind, data, expected[kind])
		}
		after, err := s.load()
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(before, after) {
			t.Fatal("status mutated the patch manifest")
		}
	}
}

func assetRootFixture(t *testing.T, files map[string]string) string {
	t.Helper()
	root := testutil.TempDir(t)
	for _, directory := range []string{"scripts", "compat", "src/plugin", "src/capsule", "src/localization", "dist/localization"} {
		if err := os.MkdirAll(filepath.Join(root, directory), 0755); err != nil {
			t.Fatal(err)
		}
	}
	for name, content := range files {
		path := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func registryFixture(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "compat", "versions.json"))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestRegistryParsingUsesVerifiedSnapshot(t *testing.T) {
	root := assetRootFixture(t, map[string]string{"compat/versions.json": string(registryFixture(t))})
	layoutBytes, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "compat", "install-layout.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(root, "compat", "install-layout.json"), layoutBytes, 0600); err != nil {
		t.Fatal(err)
	}
	snap, err := assets.Capture(root, "limit")
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Remove(filepath.Join(root, "compat", "versions.json")); err != nil {
		t.Fatal(err)
	}
	reg, err := loadRegistry(root, snap)
	if err != nil {
		t.Fatalf("registry parsing must use the verified bytes, not a reread of the removed file: %v", err)
	}
	var want registry
	if err = json.Unmarshal(registryFixture(t), &want); err != nil {
		t.Fatal(err)
	}
	if reg.Schema != want.Schema || !reflect.DeepEqual(reg.Entries, want.Entries) {
		t.Fatal("registry parse diverged from the verified bytes")
	}
	if _, err = loadRegistry(root, nil); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("nil snapshot must fall back to reading the removed file: %v", err)
	}
	if err = os.WriteFile(filepath.Join(root, "compat", "versions.json"), []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = loadRegistry(root, snap); err != nil {
		t.Fatalf("snapshot parse must not reopen the mutated file: %v", err)
	}
	if _, err = loadRegistry(root, nil); err == nil || !strings.Contains(err.Error(), "invalid compatibility registry") {
		t.Fatalf("nil snapshot must parse the mutated file: %v", err)
	}
}

func TestRegistryFuncSizeIsStrictlyValidated(t *testing.T) {
	mutated := func(t *testing.T, change func(entry map[string]any)) string {
		t.Helper()
		var doc map[string]any
		if err := json.Unmarshal(registryFixture(t), &doc); err != nil {
			t.Fatal(err)
		}
		entries, ok := doc["entries"].([]any)
		if !ok || len(entries) == 0 {
			t.Fatal("registry fixture has no entries")
		}
		entry, ok := entries[0].(map[string]any)
		if !ok {
			t.Fatal("registry fixture entry is not an object")
		}
		change(entry)
		out, err := json.Marshal(doc)
		if err != nil {
			t.Fatal(err)
		}
		return string(out)
	}
	for _, entry := range []struct {
		name    string
		change  func(entry map[string]any)
		message string
	}{
		{name: "missing field", change: func(e map[string]any) { delete(e, "func_size") }, message: "func_size"},
		{name: "fractional size", change: func(e map[string]any) { e["func_size"] = 128.7 }, message: "func_size"},
		{name: "zero size", change: func(e map[string]any) { e["func_size"] = 0.0 }, message: "func_size"},
		{name: "negative size", change: func(e map[string]any) { e["func_size"] = -128.0 }, message: "func_size"},
		{name: "unsupported size", change: func(e map[string]any) { e["func_size"] = 64.0 }, message: "func_size"},
		{name: "unknown architecture", change: func(e map[string]any) { e["arch"] = "mips" }, message: "unsupported architecture"},
		{name: "unsupported ARM64", change: func(e map[string]any) { e["arch"] = "arm64" }, message: "unsupported architecture"},
	} {
		t.Run(entry.name, func(t *testing.T) {
			root := assetRootFixture(t, map[string]string{"compat/versions.json": mutated(t, entry.change)})
			if _, err := loadRegistry(root, nil); err == nil || !strings.Contains(err.Error(), entry.message) {
				t.Fatalf("registry with %s must be refused with a %q error: %v", entry.name, entry.message, err)
			}
		})
	}
	root := assetRootFixture(t, map[string]string{"compat/versions.json": string(registryFixture(t))})
	if _, err := loadRegistry(root, nil); err != nil {
		t.Fatalf("the recorded registry entry must keep parsing: %v", err)
	}
}

func TestManifestFailureRollsBackOnlyTrustedBytes(t *testing.T) {
	_, original := fixtures(t)
	ids, err := ParseIDs(DefaultIDs)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := PlanPatch(original, ids, DefaultLimit)
	if err != nil {
		t.Fatal(err)
	}
	directory := testutil.TempDir(t)
	binary := filepath.Join(directory, "language_server.exe")
	s := store{directory: filepath.Join(directory, "backups")}
	if err = os.WriteFile(binary, original, 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(s.path(), 0700); err != nil {
		t.Fatal(err)
	}
	patched := ApplyPatch(original, plan)
	_, err = patchBinary(binary, original, patched, fsx.SHA256(original), "", "unverified", ids, DefaultLimit, plan, s, "")
	if err == nil || !strings.Contains(err.Error(), "model-limit-state.json") {
		t.Fatalf("manifest failure error = %v", err)
	}
	if sha, err := fsx.Hash(binary); err != nil || sha != fsx.SHA256(original) {
		t.Fatalf("rollback SHA = %s, %v", sha, err)
	}
}

func prepareFixturePath(t *testing.T, s store, binary string) string {
	t.Helper()
	key, err := normalized(binary)
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Join(s.directory, fmt.Sprintf("limit-prepare-%s.json", fsx.SHA256([]byte(key))[:16]))
}

func writePrepareFixture(t *testing.T, s store, binary string, record map[string]any) {
	t.Helper()
	if err := os.MkdirAll(s.directory, 0700); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(prepareFixturePath(t, s, binary), data, 0600); err != nil {
		t.Fatal(err)
	}
}

func prepareFixtureRecord(t *testing.T, binary string, original []byte, newSHA, operation string, ids []int, limit int) ([]map[string]any, map[string]any) {
	t.Helper()
	s := store{directory: filepath.Join(filepath.Dir(binary), "backups")}
	if err := os.MkdirAll(s.directory, 0700); err != nil {
		t.Fatal(err)
	}
	originalSHA := fsx.SHA256(original)
	sibling := binary + ".orig"
	repo, err := s.backupPath(binary, originalSHA)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{sibling, repo} {
		if err = os.WriteFile(path, original, 0600); err != nil {
			t.Fatal(err)
		}
	}
	target, err := normalized(binary)
	if err != nil {
		t.Fatal(err)
	}
	backups := []map[string]any{{"kind": "sibling", "path": sibling, "sha256": originalSHA}, {"kind": "repo", "path": repo, "sha256": originalSHA}}
	record := map[string]any{"schema": 1, "operation": operation, "target": target, "original_sha256": originalSHA, "new_sha256": newSHA, "backups": backups, "ids": ids, "limit": limit, "created_at": time.Now().UTC().Format(time.RFC3339), "status": "prepared"}
	return backups, record
}

func TestStatusDescribesPrepareRecordRecoveryWithoutWriting(t *testing.T) {
	reg, original := fixtures(t)
	ids, err := ParseIDs(DefaultIDs)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := PlanPatch(original, ids, DefaultLimit)
	if err != nil {
		t.Fatal(err)
	}
	originalSHA, patched := fsx.SHA256(original), ApplyPatch(original, plan)
	patchedSHA := fsx.SHA256(patched)
	for _, entry := range []struct {
		name      string
		installed []byte
		recovery  string
		recorded  bool
	}{
		{name: "prepared not applied", installed: original, recovery: "prepared-not-applied"},
		{name: "applied not recorded", installed: patched, recovery: "applied-not-recorded"},
		{name: "already recorded", installed: patched, recovery: "recorded", recorded: true},
	} {
		t.Run(entry.name, func(t *testing.T) {
			directory := testutil.TempDir(t)
			binary := filepath.Join(directory, "language_server.exe")
			s := store{directory: filepath.Join(directory, "backups")}
			if err = os.WriteFile(binary, entry.installed, 0600); err != nil {
				t.Fatal(err)
			}
			backups, fixture := prepareFixtureRecord(t, binary, original, patchedSHA, "op-42", ids, DefaultLimit)
			writePrepareFixture(t, s, binary, fixture)
			if entry.recorded {
				if err = s.append(map[string]any{"action": "patch", "binary_path": binary, "binary_sha256_before": originalSHA, "binary_sha256_after": patchedSHA, "backup_sibling": backups[0]["path"], "backup_sibling_sha256": originalSHA, "repo_backup": backups[1]["path"], "repo_backup_sha256": originalSHA}); err != nil {
					t.Fatal(err)
				}
			}
			before, err := s.load()
			if err != nil {
				t.Fatal(err)
			}
			prepareBefore, err := os.ReadFile(prepareFixturePath(t, s, binary))
			if err != nil {
				t.Fatal(err)
			}
			result, err := status(binary, reg, s, nil)
			if err != nil {
				t.Fatal(err)
			}
			report, present := result.(map[string]any)["prepare_record"].(map[string]any)
			if !present {
				t.Fatalf("status did not describe the prepare record: %v", result)
			}
			if report["recovery"] != entry.recovery || report["recovery_action"] == "" || report["operation"] != "op-42" {
				t.Fatalf("prepare report = %v, want recovery %s", report, entry.recovery)
			}
			for _, backup := range report["backups"].([]map[string]any) {
				if backup["exists"] != true || backup["verified"] != true {
					t.Fatalf("prepared backup did not verify: %v", backup)
				}
			}
			after, err := s.load()
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(before, after) {
				t.Fatal("status mutated the state manifest while describing recovery")
			}
			prepareAfter, err := os.ReadFile(prepareFixturePath(t, s, binary))
			if err != nil || !bytes.Equal(prepareBefore, prepareAfter) {
				t.Fatalf("status mutated the prepare record: %v", err)
			}
			if sha, err := fsx.Hash(binary); err != nil || sha != fsx.SHA256(entry.installed) {
				t.Fatalf("status modified the binary: %s", sha)
			}
		})
	}
}

func TestPatchApplyCompletesInterruptedRecord(t *testing.T) {
	reg, original := fixtures(t)
	ids, err := ParseIDs(DefaultIDs)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := PlanPatch(original, ids, DefaultLimit)
	if err != nil {
		t.Fatal(err)
	}
	originalSHA, patched := fsx.SHA256(original), ApplyPatch(original, plan)
	directory := testutil.TempDir(t)
	binary := filepath.Join(directory, "language_server.exe")
	s := store{directory: filepath.Join(directory, "backups")}
	if err = os.WriteFile(binary, patched, 0600); err != nil {
		t.Fatal(err)
	}
	_, fixture := prepareFixtureRecord(t, binary, original, fsx.SHA256(patched), "op-interrupted", ids, DefaultLimit)
	writePrepareFixture(t, s, binary, fixture)
	result, err := patch(binary, options{ids: DefaultIDs, limit: DefaultLimit, apply: true}, reg, s, nil)
	if err != nil {
		t.Fatal(err)
	}
	outcome := result
	if outcome["already_patched"] != true || outcome["prepare_record_completed"] != true {
		t.Fatalf("authorized apply did not complete the interrupted record: %v", result)
	}
	m, err := s.load()
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Records) != 1 {
		t.Fatalf("state append is missing after completion: %d records", len(m.Records))
	}
	record := m.Records[0]
	if stringField(record, "action") != "patch" || stringField(record, "binary_sha256_before") != originalSHA || stringField(record, "binary_sha256_after") != fsx.SHA256(patched) || stringField(record, "operation") != "op-interrupted" {
		t.Fatalf("completed record = %v", record)
	}
	if stringField(record, "backup_sibling") == "" || stringField(record, "repo_backup") == "" {
		t.Fatalf("completed record lost backup evidence: %v", record)
	}
	if _, err = os.Stat(prepareFixturePath(t, s, binary)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("completed prepare record was not consumed: %v", err)
	}
	if sha, err := fsx.Hash(binary); err != nil || sha != fsx.SHA256(patched) {
		t.Fatalf("completion rewrote the binary: %s", sha)
	}
	for _, lock := range []string{"limit-operation.lock", "store.lock"} {
		if _, err = os.Stat(filepath.Join(s.directory, lock)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%s was not released after completion: %v", lock, err)
		}
	}
}

func TestPatchBinaryRefusesConflictingPrepareRecord(t *testing.T) {
	_, original := fixtures(t)
	ids, err := ParseIDs(DefaultIDs)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := PlanPatch(original, ids, DefaultLimit)
	if err != nil {
		t.Fatal(err)
	}
	otherPlan, err := PlanPatch(original, ids, DefaultLimit+7)
	if err != nil {
		t.Fatal(err)
	}
	originalSHA := fsx.SHA256(original)
	for _, entry := range []struct {
		name        string
		originalSHA string
		newSHA      string
		ids         []int
		limit       int
		message     string
	}{
		{name: "different settings", originalSHA: originalSHA, newSHA: fsx.SHA256(ApplyPatch(original, otherPlan)), ids: ids, limit: DefaultLimit + 7, message: "prepared record holds different settings"},
		{name: "original hash drift", originalSHA: strings.Repeat("ab", 32), newSHA: fsx.SHA256(ApplyPatch(original, plan)), ids: ids, limit: DefaultLimit, message: "prepared record expects original hash"},
	} {
		t.Run(entry.name, func(t *testing.T) {
			directory := testutil.TempDir(t)
			binary := filepath.Join(directory, "language_server.exe")
			s := store{directory: filepath.Join(directory, "backups")}
			if err = os.WriteFile(binary, original, 0600); err != nil {
				t.Fatal(err)
			}
			target, err := normalized(binary)
			if err != nil {
				t.Fatal(err)
			}
			fixture := map[string]any{"schema": 1, "operation": "op-other", "target": target, "original_sha256": entry.originalSHA, "new_sha256": entry.newSHA, "ids": entry.ids, "limit": entry.limit, "backups": []map[string]any{}, "created_at": time.Now().UTC().Format(time.RFC3339), "status": "prepared"}
			writePrepareFixture(t, s, binary, fixture)
			_, err = patchBinary(binary, original, ApplyPatch(original, plan), originalSHA, "", "unverified", ids, DefaultLimit, plan, s, "op-other")
			if err == nil || !strings.Contains(err.Error(), entry.message) {
				t.Fatalf("conflicting prepared record must refuse with an actionable error, got %v", err)
			}
			if sha, hashErr := fsx.Hash(binary); hashErr != nil || sha != originalSHA {
				t.Fatalf("refused patch modified the binary: %s", sha)
			}
			if m, loadErr := s.load(); loadErr != nil || len(m.Records) != 0 {
				t.Fatalf("refused patch recorded state: %v %v", m, loadErr)
			}
			if _, statErr := os.Stat(prepareFixturePath(t, s, binary)); statErr != nil {
				t.Fatalf("refused patch consumed the prepare record: %v", statErr)
			}
		})
	}
}

func TestPatchBinaryResumesMatchingPrepareRecord(t *testing.T) {
	_, original := fixtures(t)
	ids, err := ParseIDs(DefaultIDs)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := PlanPatch(original, ids, DefaultLimit)
	if err != nil {
		t.Fatal(err)
	}
	patched := ApplyPatch(original, plan)
	directory := testutil.TempDir(t)
	binary := filepath.Join(directory, "language_server.exe")
	s := store{directory: filepath.Join(directory, "backups")}
	if err = os.WriteFile(binary, original, 0600); err != nil {
		t.Fatal(err)
	}
	_, fixture := prepareFixtureRecord(t, binary, original, fsx.SHA256(patched), "op-prepared", ids, DefaultLimit)
	writePrepareFixture(t, s, binary, fixture)
	_, err = patchBinary(binary, original, patched, fsx.SHA256(original), "", "unverified", ids, DefaultLimit, plan, s, "op-prepared")
	if err != nil {
		t.Fatal(err)
	}
	if sha, err := fsx.Hash(binary); err != nil || sha != fsx.SHA256(patched) {
		t.Fatalf("patch did not apply: %s", sha)
	}
	m, err := s.load()
	if err != nil || len(m.Records) != 1 {
		t.Fatalf("state records = %v (%v)", m, err)
	}
	if stringField(m.Records[0], "operation") != "op-prepared" {
		t.Fatalf("state record lost operation ownership: %v", m.Records[0])
	}
	if _, err = os.Stat(filepath.Join(s.directory, "store.lock")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("store lock was not released: %v", err)
	}
	if _, err = os.Stat(prepareFixturePath(t, s, binary)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("successful patch did not consume the prepare record: %v", err)
	}
}

func TestFailedReplacementPreservesOnlyUnresolvedPrepareRecords(t *testing.T) {
	_, original := fixtures(t)
	for _, test := range []struct {
		name   string
		cause  error
		retain bool
	}{
		{name: "verified rollback", cause: fmt.Errorf("post-write mismatch: %w", fsx.ErrRolledBack)},
		{name: "rollback failed", cause: fmt.Errorf("post-write drift: %w", fsx.ErrRollbackFailed), retain: true},
		{name: "unclassified failure", cause: errors.New("replacement interrupted"), retain: true},
		{name: "ambiguous rollback failure", cause: errors.Join(fsx.ErrRolledBack, fsx.ErrRollbackFailed), retain: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			directory := testutil.TempDir(t)
			binary := filepath.Join(directory, "language_server.exe")
			s := store{directory: filepath.Join(directory, "backups")}
			if err := os.WriteFile(binary, original, 0600); err != nil {
				t.Fatal(err)
			}
			_, record := prepareFixtureRecord(t, binary, original, "patched-sha", "operation", []int{1318}, DefaultLimit)
			writePrepareFixture(t, s, binary, record)
			before, err := os.ReadFile(prepareFixturePath(t, s, binary))
			if err != nil {
				t.Fatal(err)
			}
			if err = s.finishFailedReplacement(binary, test.cause); !errors.Is(err, test.cause) {
				t.Fatalf("replacement classification lost: %v", err)
			}
			after, err := os.ReadFile(prepareFixturePath(t, s, binary))
			if test.retain {
				if err != nil || !bytes.Equal(after, before) {
					t.Fatalf("unresolved recovery record changed: %v", err)
				}
			} else if !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("verified rollback did not clear prepare record: %v", err)
			}
			if sha, err := fsx.Hash(binary); err != nil || sha != fsx.SHA256(original) {
				t.Fatalf("failure bookkeeping modified binary: hash=%s error=%v", sha, err)
			}
		})
	}
}

func TestConcurrentStateAppendsDoNotLoseRecords(t *testing.T) {
	const writers = 64
	s := store{directory: filepath.Join(testutil.TempDir(t), "backups")}
	start := make(chan struct{})
	var group sync.WaitGroup
	var failures sync.Map
	for i := 0; i < writers; i++ {
		group.Add(1)
		go func(index int) {
			defer group.Done()
			<-start
			if err := s.append(map[string]any{"action": "test", "writer": index}); err != nil {
				failures.Store(index, err)
			}
		}(i)
	}
	close(start)
	group.Wait()
	failures.Range(func(_, value any) bool {
		t.Errorf("concurrent append failed: %v", value)
		return true
	})
	m, err := s.load()
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Records) != writers {
		t.Fatalf("lost updates: %d of %d concurrent records survived", len(m.Records), writers)
	}
	seen := map[int]bool{}
	for _, record := range m.Records {
		writer, _ := record["writer"].(float64)
		if seen[int(writer)] {
			t.Fatalf("writer %d recorded twice", int(writer))
		}
		seen[int(writer)] = true
	}
}

func TestHeldStoreLockProducesContentionError(t *testing.T) {
	s := store{directory: filepath.Join(testutil.TempDir(t), "backups")}
	if err := os.MkdirAll(s.directory, 0700); err != nil {
		t.Fatal(err)
	}
	held := filepath.Join(s.directory, "store.lock")
	owner := []byte(`{"pid":4321}`)
	if err := os.WriteFile(held, owner, 0600); err != nil {
		t.Fatal(err)
	}
	err := s.append(map[string]any{"action": "test"})
	if err == nil || !strings.Contains(err.Error(), "store lock") || !strings.Contains(err.Error(), "no records were written") {
		t.Fatalf("held store lock error = %v", err)
	}
	if _, statErr := os.Stat(s.path()); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("contended append wrote state: %v", statErr)
	}
	current, err := os.ReadFile(held)
	if err != nil || !bytes.Equal(current, owner) {
		t.Fatalf("contended append disturbed the held lock: %s (%v)", current, err)
	}
}

func TestOperationLockRefusesConcurrentMutation(t *testing.T) {
	_, original := fixtures(t)
	directory := testutil.TempDir(t)
	binary := filepath.Join(directory, "language_server.exe")
	s := store{directory: filepath.Join(directory, "backups")}
	if err := os.WriteFile(binary, original, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(s.directory, 0700); err != nil {
		t.Fatal(err)
	}
	lock := filepath.Join(s.directory, "limit-operation.lock")
	owner := []byte(`{"id":"op-other","pid":4321,"command":"patch"}`)
	var err error
	if err = os.WriteFile(lock, owner, 0600); err != nil {
		t.Fatal(err)
	}
	_, err = s.beginOperation("patch", "")
	if err == nil || !strings.Contains(err.Error(), "limit-operation.lock") || !strings.Contains(err.Error(), "no changes were made") {
		t.Fatalf("operation lock contention error = %v", err)
	}
	if sha, hashErr := fsx.Hash(binary); hashErr != nil || sha != fsx.SHA256(original) {
		t.Fatalf("contended patch modified the binary: %s", sha)
	}
	if m, loadErr := s.load(); loadErr != nil || len(m.Records) != 0 {
		t.Fatalf("contended patch recorded state: %v %v", m, loadErr)
	}
	current, err := os.ReadFile(lock)
	if err != nil || !bytes.Equal(current, owner) {
		t.Fatalf("contended patch disturbed the operation lock: %s (%v)", current, err)
	}
}

func TestPreparedCompletionReleasesOperationLockOnFailure(t *testing.T) {
	_, original := fixtures(t)
	directory := testutil.TempDir(t)
	binary := filepath.Join(directory, "language_server.exe")
	s := store{directory: filepath.Join(directory, "backups")}
	var err error
	if err = os.WriteFile(binary, original, 0600); err != nil {
		t.Fatal(err)
	}
	key, err := normalized(binary)
	if err != nil {
		t.Fatal(err)
	}
	sha := fsx.SHA256(original)
	prepared := &prepareRecord{Operation: "op-incomplete", Target: key, OriginalSHA: sha, NewSHA: sha, Backups: []prepareBackup{{Kind: "repo", Path: filepath.Join(directory, "missing-original.exe"), SHA256: sha}}}
	err = s.completePrepareRecord(binary, sha, prepared, map[string]any{})
	if !errors.Is(err, os.ErrNotExist) || !strings.Contains(err.Error(), "backup") {
		t.Fatalf("missing prepared backup error = %v", err)
	}
	if sha, hashErr := fsx.Hash(binary); hashErr != nil || sha != fsx.SHA256(original) {
		t.Fatalf("failed prepare completion changed the binary: %s", sha)
	}
	for _, lock := range []string{"limit-operation.lock", "store.lock"} {
		if _, statErr := os.Stat(filepath.Join(s.directory, lock)); !errors.Is(statErr, os.ErrNotExist) {
			t.Fatalf("%s was not released after failure: %v", lock, statErr)
		}
	}
}

func TestStrictIDGrammarVectors(t *testing.T) {
	for _, row := range []struct {
		spec  string
		ids   []int
		error string
	}{
		{spec: "1318-1320,1400-1405,1417-1419", ids: []int{1318, 1319, 1320, 1400, 1401, 1402, 1403, 1404, 1405, 1417, 1418, 1419}},
		{spec: "1318-1320, 1400,1318", ids: []int{1318, 1319, 1320, 1400}},
		{spec: "1", ids: []int{1}},
		{spec: "1-2", ids: []int{1, 2}},
		{spec: "1 , 2", ids: []int{1, 2}},
		{spec: "01", ids: []int{1}},
		{spec: "5-5", ids: []int{5}},
		{spec: "0-127", ids: func() []int {
			out := []int{}
			for i := 0; i <= 127; i++ {
				out = append(out, i)
			}
			return out
		}()},
		{spec: "5-2", error: "bad range"},
		{spec: "-5", error: "invalid model id"},
		{spec: "+5", error: "invalid model id"},
		{spec: "1,,2", error: "invalid model id"},
		{spec: "1,", error: "invalid model id"},
		{spec: ",1", error: "invalid model id"},
		{spec: "1,2,", error: "invalid model id"},
		{spec: ",", error: "no model ids given"},
		{spec: " , ", error: "no model ids given"},
		{spec: "", error: "no model ids given"},
		{spec: "   ", error: "no model ids given"},
		{spec: "1x", error: "invalid model id"},
		{spec: "0x10", error: "invalid model id"},
		{spec: "1.5", error: "invalid model id"},
		{spec: "99999999999", error: "invalid model id"},
		{spec: "2147483648", error: "invalid model id"},
		{spec: "1000-1129", error: "128-wide window"},
		{spec: "0-127,200", error: "128-wide window"},
		{spec: "1 2", error: "invalid model id"},
		{spec: "1,-2", error: "invalid model id"},
	} {
		got, err := ParseIDs(row.spec)
		if row.error != "" {
			if err == nil || !strings.Contains(err.Error(), row.error) {
				t.Fatalf("spec %q: error = %v, want %q", row.spec, err, row.error)
			}
			continue
		}
		if err != nil {
			t.Fatalf("spec %q: unexpected error %v", row.spec, err)
		}
		if !reflect.DeepEqual(got, row.ids) {
			t.Fatalf("spec %q: ids = %v, want %v", row.spec, got, row.ids)
		}
	}
}
