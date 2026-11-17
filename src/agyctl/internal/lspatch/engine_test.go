package lspatch

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"agyctl/internal/fsx"
	"agyctl/internal/testutil"
)

func nativeFixture(t *testing.T) (Engine, string, []byte) {
	t.Helper()
	directory := testutil.TempDir(t)
	binary := filepath.Join(directory, "server.bin")
	base := make([]byte, 128)
	if err := os.WriteFile(binary, base, 0600); err != nil {
		t.Fatal(err)
	}
	ref := RecipeRef{ID: "limit-fixture", Fingerprint: fsx.SHA256([]byte("limit-fixture"))}
	spec := Spec{ID: "qualified-fixture", BaseSHA: fsx.SHA256(base), Size: len(base), LimitRef: ref,
		ToolOutput: &Contribution{Ref: RecipeRef{ID: "tool-fixture", Fingerprint: fsx.SHA256([]byte("tool-fixture"))}, Spans: []Span{{16, make([]byte, 4), []byte{'T', 0, 0, 0}}}},
		Compaction: &Contribution{Ref: RecipeRef{ID: "compaction-fixture", Fingerprint: fsx.SHA256([]byte("compaction-fixture"))}, Spans: []Span{{48, make([]byte, 4), []byte{'C', 0, 0, 0}}}},
	}
	spec.Limit = func(base []byte, config LimitConfig, reserved []Span, identity RecipeRef) (Contribution, error) {
		candidate := 16
		for _, at := range []int{16, 32, 64} {
			blocked := false
			for _, span := range reserved {
				if span.Offset < at+2 && at < span.Offset+len(span.Expected) {
					blocked = true
					break
				}
			}
			if !blocked {
				candidate = at
				break
			}
		}
		return Contribution{Ref: identity, Spans: []Span{{4, []byte{0}, []byte{'L'}}, {candidate, []byte{0, 0}, []byte{byte(config.ModelLimits[0].ID), byte(config.ModelLimits[0].Limit)}}}}, nil
	}
	return Engine{Directory: filepath.Join(directory, "state"), AssetsFingerprint: fsx.SHA256([]byte("assets-fixture")), Specs: []Spec{spec}, RequireStopped: func(string) error { return nil }}, binary, base
}

func featureDesired(feature int, enabled bool, value int) Desired {
	switch feature {
	case 0:
		config := EmptyConfig().Limit
		config.Enabled = enabled
		if enabled {
			config.ModelLimits = []ModelLimit{{ID: 1, Limit: value}}
		}
		return Desired{Limit: &config}
	case 1:
		return Desired{ToolOutput: &enabled}
	default:
		return Desired{Compaction: &enabled}
	}
}

func assertNativeBytes(t *testing.T, binary string, active int, value int) {
	t.Helper()
	want := make([]byte, 128)
	if active&1 != 0 {
		want[4], want[32], want[33] = 'L', 1, byte(value)
	}
	if active&2 != 0 {
		want[16] = 'T'
	}
	if active&4 != 0 {
		want[48] = 'C'
	}
	actual, err := os.ReadFile(binary)
	if err != nil || !bytes.Equal(actual, want) {
		t.Fatalf("active=%03b: complete native bytes differ: %x (%v)", active, actual, err)
	}
}

func applyDesired(t *testing.T, e Engine, binary string, desired Desired) map[string]any {
	t.Helper()
	plan, err := e.Plan(binary, desired)
	if err != nil {
		t.Fatal(err)
	}
	result, err := e.Apply(binary, desired, plan.Expected, "native")
	if err != nil {
		t.Fatal(err)
	}
	if result["verified"] != true {
		t.Fatalf("unverified successful apply: %v", result)
	}
	return result
}

func TestNativeSubsetsOrdersAndIndependentRestore(t *testing.T) {
	for subset := 0; subset < 8; subset++ {
		t.Run(fmt.Sprintf("subset-%03b", subset), func(t *testing.T) {
			e, binary, _ := nativeFixture(t)
			config := EmptyConfig()
			if subset&1 != 0 {
				config.Limit = *featureDesired(0, true, 2).Limit
			}
			config.ToolOutput = subset&2 != 0
			config.Compaction = subset&4 != 0
			applyDesired(t, e, binary, Desired{Limit: &config.Limit, ToolOutput: &config.ToolOutput, Compaction: &config.Compaction})
			assertNativeBytes(t, binary, subset, 2)
		})
	}
	for _, order := range [][3]int{{0, 1, 2}, {0, 2, 1}, {1, 0, 2}, {1, 2, 0}, {2, 0, 1}, {2, 1, 0}} {
		t.Run(fmt.Sprint(order), func(t *testing.T) {
			e, binary, base := nativeFixture(t)
			active := 0
			for _, feature := range order {
				name := []string{"limit", "tool-output", "compaction"}[feature]
				result, handled, err := e.Handle(Request{Feature: name, Command: "patch", Binary: binary, Apply: true, Desired: featureDesired(feature, true, 2)})
				if err != nil || !handled || result["verified"] != true {
					t.Fatalf("single-feature patch: %v %v %v", result, handled, err)
				}
				active |= 1 << feature
				assertNativeBytes(t, binary, active, 2)
			}
			applyDesired(t, e, binary, featureDesired(0, true, 3))
			assertNativeBytes(t, binary, 7, 3)
			for _, feature := range order {
				name := []string{"limit", "tool-output", "compaction"}[feature]
				_, handled, err := e.Handle(Request{Feature: name, Command: "restore", Binary: binary})
				if err != nil || !handled {
					t.Fatalf("single-feature restore: %v %v", handled, err)
				}
				active &^= 1 << feature
				assertNativeBytes(t, binary, active, 3)
			}
			status, err := e.Status(binary)
			if err != nil || status["verified"] != true || status["generation"] != uint64(7) || status["current_sha256"] != fsx.SHA256(base) {
				t.Fatalf("restored status: %v %v", status, err)
			}
			backup, err := os.ReadFile(status["base_binary_path"].(string))
			if err != nil || !bytes.Equal(backup, base) {
				t.Fatalf("original backup lost: %v", err)
			}
		})
	}
}

func TestNativeWholeImageAndReviewedPlanGates(t *testing.T) {
	e, binary, _ := nativeFixture(t)
	desired := featureDesired(0, true, 2)
	plan, err := e.Plan(binary, desired)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(e.Directory); !os.IsNotExist(err) {
		t.Fatalf("plan wrote state: %v", err)
	}
	applyDesired(t, e, binary, featureDesired(1, true, 0))
	statePath, _, err := statePaths(e.Directory, binary)
	if err != nil {
		t.Fatal(err)
	}
	stateBefore, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	infoBefore, err := os.Stat(statePath)
	if err != nil {
		t.Fatal(err)
	}
	entriesBefore, err := os.ReadDir(e.Directory)
	if err != nil {
		t.Fatal(err)
	}
	noOp := applyDesired(t, e, binary, Desired{})
	stateAfter, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	infoAfter, err := os.Stat(statePath)
	if err != nil {
		t.Fatal(err)
	}
	entriesAfter, err := os.ReadDir(e.Directory)
	if err != nil {
		t.Fatal(err)
	}
	if noOp["applied"] != false || noOp["bytes_changed"] != 0 || noOp["generation"] != uint64(1) || !bytes.Equal(stateBefore, stateAfter) || !infoBefore.ModTime().Equal(infoAfter.ModTime()) || len(entriesBefore) != len(entriesAfter) {
		t.Fatalf("managed no-op changed state, generation or backups: %v", noOp)
	}
	if _, err := e.Apply(binary, desired, plan.Expected, "native"); err == nil || !strings.Contains(err.Error(), "stale-plan") {
		t.Fatalf("accepted stale plan: %v", err)
	}
	assertNativeBytes(t, binary, 2, 0)
	plan, err = e.Plan(binary, desired)
	if err != nil {
		t.Fatal(err)
	}
	e.AssetsFingerprint = fsx.SHA256([]byte("changed-assets"))
	if _, err := e.Apply(binary, desired, plan.Expected, "native"); err == nil || !strings.Contains(err.Error(), "stale-plan") {
		t.Fatalf("accepted changed asset snapshot: %v", err)
	}
	data, err := os.ReadFile(binary)
	if err != nil {
		t.Fatal(err)
	}
	data[127] = 1
	if err := os.WriteFile(binary, data, 0600); err != nil {
		t.Fatal(err)
	}
	status, err := e.Status(binary)
	if err != nil || status["verified"] != false || status["file_state"] != "drift" || status["features"] != nil {
		t.Fatalf("drift was represented as active: %v %v", status, err)
	}
	if _, err := e.Plan(binary, desired); err == nil || !strings.Contains(err.Error(), "complete reconstructed") {
		t.Fatalf("accepted outside-span drift: %v", err)
	}
	if err := GuardStandalone(e.Directory, binary, "compaction"); err == nil || !strings.Contains(err.Error(), "native-managed") {
		t.Fatalf("standalone bypass: %v", err)
	}
}

func TestNativeMissingRecipeAndGuardConflicts(t *testing.T) {
	e, binary, base := nativeFixture(t)
	e.Specs[0].Compaction = nil
	if _, err := e.Plan(binary, featureDesired(2, true, 0)); err == nil || !strings.Contains(err.Error(), "unsupported: compaction") {
		t.Fatalf("missing recipe was admitted: %v", err)
	}
	if _, err := os.Stat(e.Directory); !os.IsNotExist(err) {
		t.Fatalf("unsupported plan wrote state: %v", err)
	}
	config := EmptyConfig()
	config.Limit = *featureDesired(0, true, 2).Limit
	spec := e.Specs[0]
	spec.Compaction = &Contribution{Ref: RecipeRef{ID: "guard", Fingerprint: fsx.SHA256([]byte("guard"))}, Spans: []Span{{32, []byte{0}, []byte{0}}}}
	out, err := Build(base, spec, config, recipeRefs(spec, config))
	if err != nil || out[64] != 1 || out[65] != 2 || out[32] != 0 {
		t.Fatalf("disabled recipe guard was not reserved: %x %v", out, err)
	}
	planner := spec.Limit
	spec.Limit = func(base []byte, config LimitConfig, _ []Span, ref RecipeRef) (Contribution, error) {
		return planner(base, config, nil, ref)
	}
	if _, err := Build(base, spec, config, recipeRefs(spec, config)); err == nil || !strings.Contains(err.Error(), "reserved recipe") {
		t.Fatalf("coordinator accepted a planner that overwrites a disabled recipe guard: %v", err)
	}
	drift := bytes.Clone(base)
	drift[127] = 1
	if _, err := Build(drift, e.Specs[0], EmptyConfig(), map[string]RecipeRef{}); err == nil || !strings.Contains(err.Error(), "whole-file original") {
		t.Fatalf("base admitted by spans only: %v", err)
	}
}

func TestNativeNewRecipeCanReplanAnExistingQualifiedLayout(t *testing.T) {
	e, binary, _ := nativeFixture(t)
	e.Specs[0].Compaction = nil
	applyDesired(t, e, binary, featureDesired(0, true, 2))
	assertNativeBytes(t, binary, 1, 2)
	e.Specs[0].Compaction = &Contribution{Ref: RecipeRef{ID: "new-compaction", Fingerprint: fsx.SHA256([]byte("new-compaction"))}, Spans: []Span{{32, []byte{0, 0}, []byte{'C', 0}}}}
	e.AssetsFingerprint = fsx.SHA256([]byte("new-qualified-assets"))
	status, err := e.Status(binary)
	if err != nil || status["verified"] != true {
		t.Fatalf("new inactive recipe invalidated a fully reproducible previous layout: %v %v", status, err)
	}
	applyDesired(t, e, binary, featureDesired(2, true, 0))
	want := make([]byte, 128)
	want[4], want[32], want[64], want[65] = 'L', 'C', 1, 2
	current, err := os.ReadFile(binary)
	if err != nil || !bytes.Equal(current, want) {
		t.Fatalf("new layout did not preserve parameters and relocate all limit nodes: %x %v", current, err)
	}
	if _, err := e.Status(binary); err != nil {
		t.Fatalf("new layout cannot reconstruct: %v", err)
	}
}

func TestNativeHistoricalLayoutReplansReservedLimitNodes(t *testing.T) {
	for _, enabled := range []bool{true, false} {
		t.Run(fmt.Sprintf("compaction-%t", enabled), func(t *testing.T) {
			e, binary, _ := nativeFixture(t)
			config := EmptyConfig()
			config.Limit = *featureDesired(0, true, 2).Limit
			config.ToolOutput, config.Compaction = true, enabled
			applyDesired(t, e, binary, Desired{Limit: &config.Limit, ToolOutput: &config.ToolOutput, Compaction: &config.Compaction})
			before, err := os.ReadFile(binary)
			if err != nil {
				t.Fatal(err)
			}
			old := *e.Specs[0].Compaction
			e.Specs[0].Compaction = &Contribution{Ref: RecipeRef{ID: old.Ref.ID, Fingerprint: fsx.SHA256([]byte("revised-compaction"))}, Spans: []Span{{32, []byte{0, 0}, []byte{'N', 0}}}}
			e.AssetsFingerprint = fsx.SHA256([]byte("revised-assets"))
			if _, err := e.Status(binary); err == nil || !strings.Contains(err.Error(), "recorded layout recipe") {
				t.Fatalf("unregistered historical layout was accepted: %v", err)
			}
			e.Specs[0].HistoricalCompaction = []Contribution{old}
			if enabled {
				altered := old
				altered.Spans = []Span{{48, make([]byte, 4), []byte{'X', 0, 0, 0}}}
				e.Specs[0].HistoricalCompaction = []Contribution{altered}
				if _, err := e.Status(binary); err == nil || !strings.Contains(err.Error(), "cannot reproduce its complete recorded image") {
					t.Fatalf("changed historical bytes were accepted: %v", err)
				}
				e.Specs[0].HistoricalCompaction = []Contribution{old}
			}
			result := applyDesired(t, e, binary, Desired{})
			if result["generation"] != uint64(2) || result["recipe_update_required"] != false || !reflect.DeepEqual(result["features"], config) {
				t.Fatalf("migration lost independent settings: %v", result)
			}
			want := make([]byte, 128)
			want[4], want[16], want[64], want[65] = 'L', 'T', 1, 2
			if enabled {
				want[32] = 'N'
			}
			actual, err := os.ReadFile(binary)
			if err != nil || !bytes.Equal(actual, want) {
				t.Fatalf("historical layout did not relocate limit nodes from the exact base: %x %v", actual, err)
			}
			backupPath, err := e.backupPath(binary, fsx.SHA256(before))
			if err != nil {
				t.Fatal(err)
			}
			backup, err := os.ReadFile(backupPath)
			if err != nil || !bytes.Equal(backup, before) {
				t.Fatalf("historical complete image backup was not preserved: %v", err)
			}
			applyDesired(t, e, binary, featureDesired(2, false, 0))
			want[32] = 0
			actual, err = os.ReadFile(binary)
			if err != nil || !bytes.Equal(actual, want) {
				t.Fatalf("restoring compaction altered L/T: %x %v", actual, err)
			}
		})
	}
}

func readActive(t *testing.T, e Engine, binary string) State {
	t.Helper()
	statePath, _, err := statePaths(e.Directory, binary)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	var state State
	if err := json.Unmarshal(data, &state); err != nil {
		t.Fatal(err)
	}
	return state
}

func TestNativePreparedRecoveryAndReadOnlyInspection(t *testing.T) {
	for _, boundary := range []string{"before", "after", "committed", "third-hash", "fingerprint", "backup"} {
		t.Run(boundary, func(t *testing.T) {
			e, binary, _ := nativeFixture(t)
			applyDesired(t, e, binary, featureDesired(1, true, 0))
			before := readActive(t, e, binary)
			beforeBytes, err := os.ReadFile(binary)
			if err != nil {
				t.Fatal(err)
			}
			desired := featureDesired(0, true, 2)
			plan, err := e.Plan(binary, desired)
			if err != nil {
				t.Fatal(err)
			}
			applyDesired(t, e, binary, desired)
			after := readActive(t, e, binary)
			afterBytes, err := os.ReadFile(binary)
			if err != nil {
				t.Fatal(err)
			}
			statePath, preparePath, err := statePaths(e.Directory, binary)
			if err != nil {
				t.Fatal(err)
			}
			startPath, err := e.backupPath(binary, before.CurrentSHA)
			if err != nil {
				t.Fatal(err)
			}
			pending := prepare{Schema: 1, Operation: "interrupted", Owner: "native", Before: before, After: after, Expected: plan.Expected, StartBackup: startPath}
			if boundary == "fingerprint" {
				pending.After.Recipes["limit"] = RecipeRef{ID: "limit-fixture", Fingerprint: fsx.SHA256([]byte("wrong"))}
			}
			if err := writeJSON(e.Directory, preparePath, pending); err != nil {
				t.Fatal(err)
			}
			if boundary != "committed" {
				if err := writeJSON(e.Directory, statePath, before); err != nil {
					t.Fatal(err)
				}
			}
			if boundary == "before" {
				if err := os.WriteFile(binary, beforeBytes, 0600); err != nil {
					t.Fatal(err)
				}
			}
			if boundary == "third-hash" {
				drift := bytes.Clone(afterBytes)
				drift[127] = 1
				if err := os.WriteFile(binary, drift, 0600); err != nil {
					t.Fatal(err)
				}
			}
			if boundary == "backup" {
				if err := os.WriteFile(startPath, []byte("damaged"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			preparedBytes, err := os.ReadFile(preparePath)
			if err != nil {
				t.Fatal(err)
			}
			status, err := e.Status(binary)
			if err != nil || status["file_state"] != "pending" || status["verified"] != false || status["features"] != nil {
				t.Fatalf("pending status: %v %v", status, err)
			}
			if _, err := e.Plan(binary, desired); err == nil || !strings.Contains(err.Error(), "pending") {
				t.Fatalf("planned across prepare: %v", err)
			}
			unchanged, err := os.ReadFile(preparePath)
			if err != nil || !bytes.Equal(preparedBytes, unchanged) {
				t.Fatalf("inspection changed prepare: %v", err)
			}
			if _, err := e.Apply(binary, desired, plan.Expected, "compaction"); err == nil || !strings.Contains(err.Error(), "owner") {
				t.Fatalf("another feature crossed prepare: %v", err)
			}
			result, err := e.Apply(binary, desired, plan.Expected, "native")
			if boundary == "third-hash" || boundary == "fingerprint" || boundary == "backup" {
				message := map[string]string{"third-hash": "neither prepared before nor after", "fingerprint": "canonical desired native layout", "backup": "operation-start backup"}[boundary]
				if err == nil || !strings.Contains(err.Error(), message) {
					t.Fatalf("recovery accepted %s: %v", boundary, result)
				}
				if _, err := os.Stat(preparePath); err != nil {
					t.Fatalf("failed recovery removed evidence: %v", err)
				}
				return
			}
			if err != nil || result["prepare_record_completed"] != true || result["generation"] != after.Generation {
				t.Fatalf("recovery: %v %v", result, err)
			}
			assertNativeBytes(t, binary, 3, 2)
			if _, err := os.Stat(preparePath); !os.IsNotExist(err) {
				t.Fatalf("prepare was not cleared: %v", err)
			}
		})
	}
}

func TestNativeMutationRequiresStoppedAndDoesNotCrossLegacyPrepare(t *testing.T) {
	e, binary, base := nativeFixture(t)
	desired := featureDesired(0, true, 2)
	plan, err := e.Plan(binary, desired)
	if err != nil {
		t.Fatal(err)
	}
	stoppedErr := errors.New("fixture target is running")
	e.RequireStopped = func(string) error { return stoppedErr }
	if _, err := e.Apply(binary, desired, plan.Expected, "native"); !errors.Is(err, stoppedErr) {
		t.Fatalf("process check was bypassed: %v", err)
	}
	current, err := os.ReadFile(binary)
	if err != nil || !bytes.Equal(current, base) {
		t.Fatalf("running target changed: %v", err)
	}
	_, id, err := targetKey(binary)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(e.Directory, "tool-output-prepare-"+id+".json")
	if err := os.WriteFile(path, []byte(`{"schema":1,"status":"prepared"}`), 0600); err != nil {
		t.Fatal(err)
	}
	e.RequireStopped = func(string) error { return nil }
	if _, err := e.Apply(binary, desired, plan.Expected, "native"); err == nil || !strings.Contains(err.Error(), "interrupted tool-output") {
		t.Fatalf("native crossed legacy prepare: %v", err)
	}
	status, err := e.Status(binary)
	if err != nil || status["file_state"] != "pending" || status["features"] != nil {
		t.Fatalf("legacy prepare was hidden: %v %v", status, err)
	}
	if err := GuardStandalone(e.Directory, binary, "limit"); err == nil || !strings.Contains(err.Error(), "interrupted tool-output") {
		t.Fatalf("old feature crossed foreign prepare: %v", err)
	}
	_, handled, err := e.Handle(Request{Feature: "tool-output", Command: "patch", Binary: binary, Apply: true, Desired: featureDesired(1, true, 0)})
	if err != nil || handled {
		t.Fatalf("same-owner legacy recovery was not delegated to its exact standalone gate: %v %v", handled, err)
	}
	if owned, err := HasState(e.Directory, binary); err != nil || owned {
		t.Fatalf("failed operation created native ownership: %v %v", owned, err)
	}
}

func TestNativeDesiredJSONContract(t *testing.T) {
	value, err := ParseDesired([]byte(`{"limit":{"enabled":true,"model_limits":[{"id":1,"limit":2}]},"compaction":true}`))
	if err != nil || value.ToolOutput != nil || value.Limit == nil || !value.Limit.Enabled || value.Compaction == nil || !*value.Compaction {
		t.Fatalf("partial desired: %+v %v", value, err)
	}
	for _, invalid := range []string{`null`, `{"unknown":true}`, `{"tool_output":null}`, `{"compaction":true,"compaction":false}`, `{"limit":{"enabled":false}}`, `{"limit":{"enabled":null,"model_limits":[]}}`, `{"limit":{"enabled":false,"model_limits":null}}`, `{"limit":{"enabled":false,"model_limits":[{"id":1,"limit":2}]}}`, `{"limit":{"enabled":true,"model_limits":[{"id":2,"limit":2},{"id":1,"limit":2}]}}`, `{} {}`} {
		if _, err := ParseDesired([]byte(invalid)); err == nil {
			t.Fatalf("accepted invalid desired %s", invalid)
		}
	}
	current := EmptyConfig()
	current.ToolOutput = true
	merged, err := value.Merge(current)
	if err != nil || !merged.ToolOutput || !reflect.DeepEqual(merged.Limit, *value.Limit) {
		t.Fatalf("omitted feature was not preserved: %+v %v", merged, err)
	}
	boundary, err := ParseDesired([]byte(`{"limit":{"enabled":true,"model_limits":[{"id":1,"limit":983040}]}}`))
	if err != nil {
		t.Fatal(err)
	}
	merged, err = boundary.Merge(current)
	if err != nil || merged.Limit.ModelLimits[0].Limit != 983040 {
		t.Fatalf("inclusive context upper bound: %+v %v", merged, err)
	}
	boundary.Limit.ModelLimits[0].Limit = 983041
	if _, err := boundary.Merge(current); err == nil || !strings.Contains(err.Error(), "must not exceed 983040") {
		t.Fatalf("accepted new oversized context limit: %v", err)
	}
	current.Limit = LimitConfig{Enabled: true, ModelLimits: []ModelLimit{{ID: 1, Limit: 1048576}}}
	if err := current.Validate(); err != nil {
		t.Fatalf("historical state no longer readable: %v", err)
	}
	retained, err := ParseDesired([]byte(`{"limit":{"enabled":true,"model_limits":[{"id":1,"limit":1048576}]}}`))
	if err != nil {
		t.Fatal(err)
	}
	for _, desired := range []Desired{{}, retained} {
		merged, err := desired.Merge(current)
		if err != nil || !reflect.DeepEqual(merged, current) {
			t.Fatalf("unchanged historical mapping lost: %+v %v", merged, err)
		}
	}
	retained.Limit.ModelLimits[0].ID = 2
	if _, err := retained.Merge(current); err == nil || !strings.Contains(err.Error(), "must not exceed 983040") {
		t.Fatalf("historical value reused for a different model: %v", err)
	}
	merged, err = (Desired{Limit: &LimitConfig{ModelLimits: []ModelLimit{}}}).Merge(current)
	if err != nil || merged.Limit.Enabled || len(merged.Limit.ModelLimits) != 0 {
		t.Fatalf("historical limit cannot be disabled: %+v %v", merged, err)
	}
}
