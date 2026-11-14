package patchtest_test

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"agyctl/internal/limit"
	"agyctl/internal/testutil"
)

func TestByteGateAndPatchIntegrity(t *testing.T) {
	root := filepath.Join("..", "..", "..", "..", "..")
	originals, err := limit.Originals(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, "src", "agyctl", "testdata", "limit", "original.bin"))
	if err != nil {
		t.Fatal(err)
	}
	ids, err := limit.ParseIDs(limit.DefaultIDs)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := limit.PlanPatch(data, ids, limit.DefaultLimit)
	if err != nil {
		t.Fatal(err)
	}
	for _, offset := range []int{4, 70, 127} {
		patched := limit.ApplyPatch(data, plan)
		patched[plan.FuncOff+offset] ^= 1
		state, err := limit.DetectState(patched, originals)
		if err != nil {
			t.Fatal(err)
		}
		if state.Kind != "unknown" {
			t.Fatalf("tampered offset %d classified %s", offset, state.Kind)
		}
	}
	foreign := bytes.Clone(data)
	foreign[plan.FuncOff+60] ^= 0xff
	state, err := limit.DetectState(foreign, originals)
	if err != nil {
		t.Fatal(err)
	}
	if state.Kind != "unknown" {
		t.Fatalf("foreign body classified %s", state.Kind)
	}
	directory := testutil.TempDir(t)
	t.Setenv("AGYCTL_HOME", filepath.Join(directory, "state"))
	binary := filepath.Join(directory, "language_server.exe")
	args := []string{"patch", "--binary", binary, "--ids", limit.DefaultIDs, "--limit", strconv.Itoa(limit.DefaultLimit), "--dry-run"}
	if err = os.WriteFile(binary, foreign, 0600); err != nil {
		t.Fatal(err)
	}
	_, _, err = limit.Run(root, nil, args)
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
	_, _, err = limit.Run(root, nil, append(args, "--out", backup))
	if !errors.Is(err, os.ErrExist) {
		t.Fatalf("existing dry-run output error = %v", err)
	}
	if actual, err := os.ReadFile(backup); err != nil || string(actual) != "preserved backup" {
		t.Fatal("dry-run overwrote existing backup")
	}
	withoutCave := bytes.Clone(data)
	copy(withoutCave[plan.TableOff-8:plan.TableOff+16], make([]byte, 24))
	_, err = limit.PlanPatch(withoutCave, ids, limit.DefaultLimit)
	if err == nil || err.Error() != "no int3 padding cave found near the function" {
		t.Fatalf("missing cave error = %v", err)
	}
}
