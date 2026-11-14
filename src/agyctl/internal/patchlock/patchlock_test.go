package patchlock

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"agyctl/internal/testutil"
)

func TestOperationLockLifecycle(t *testing.T) {
	directory := testutil.TempDir(t)
	op, err := BeginOperation(directory, "test patch", "")
	if err != nil {
		t.Fatal(err)
	}
	if op.ID() == "" {
		t.Fatal("empty operation id")
	}
	path := filepath.Join(directory, OperationLockName)
	if _, err = os.Stat(path); err != nil {
		t.Fatalf("lock file missing while held: %v", err)
	}
	if err = op.Release(); err != nil {
		t.Fatalf("release: %v", err)
	}
	if _, err = os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("lock file was not removed: %v", err)
	}
}

func TestOperationLockRefusesContention(t *testing.T) {
	directory := testutil.TempDir(t)
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, OperationLockName)
	owner := []byte(`{"id":"op-other","pid":4321,"command":"limit patch"}`)
	if err := os.WriteFile(path, owner, 0600); err != nil {
		t.Fatal(err)
	}
	op, err := BeginOperation(directory, "test patch", "")
	if err == nil || !strings.Contains(err.Error(), OperationLockName) || !strings.Contains(err.Error(), "no changes were made") {
		t.Fatalf("contention error = %v", err)
	}
	if op != nil {
		t.Fatalf("contention returned an operation: %+v", op)
	}
	current, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(current, owner) {
		t.Fatalf("contended begin disturbed the held lock: %s (%v)", current, err)
	}
}

func TestOperationLockResumesRecordedID(t *testing.T) {
	directory := testutil.TempDir(t)
	op, err := BeginOperation(directory, "test patch", "feedface")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = op.Release() }()
	if op.ID() != "feedface" {
		t.Fatalf("resumed id = %s", op.ID())
	}
}

func TestStoreLockLifecycleAndContention(t *testing.T) {
	directory := testutil.TempDir(t)
	lock, err := AcquireStoreLock(directory)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, StoreLockName)
	if _, err = os.Stat(path); err != nil {
		t.Fatalf("store lock missing while held: %v", err)
	}
	held := testutil.TempDir(t)
	if err = os.MkdirAll(held, 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(held, StoreLockName), []byte("{}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	_, err = AcquireStoreLock(held)
	if err == nil || !strings.Contains(err.Error(), "store lock") || !strings.Contains(err.Error(), "no records were written") {
		t.Fatalf("contention error = %v", err)
	}
	if elapsed := time.Since(start); elapsed < StoreLockWait-2*time.Second {
		t.Fatalf("contention gave up early after %s", elapsed)
	}
	if err = lock.Release(); err != nil {
		t.Fatalf("release: %v", err)
	}
	if _, err = os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("store lock was not removed: %v", err)
	}
}
