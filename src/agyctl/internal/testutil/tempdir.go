package testutil

import (
	"os"
	"runtime"
	"testing"
	"time"
)

// TempDir is a drop-in replacement for t.TempDir whose cleanup retries
// ERROR_DIR_NOT_EMPTY. External file scanners briefly hold freshly written
// files open with share-delete, so the pending deletion keeps the parent
// directory non-empty; t.TempDir only retries access denied and sharing
// violations and fails the test even when every assertion passed.
func TempDir(t *testing.T) string {
	t.Helper()
	root, err := os.MkdirTemp("", "agyctl-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		deadline := time.Now().Add(2 * time.Second)
		for {
			err := os.RemoveAll(root)
			if err == nil {
				return
			}
			if !time.Now().Before(deadline) {
				t.Errorf("temp dir cleanup: %v", err)
				return
			}
			runtime.GC()
			time.Sleep(10 * time.Millisecond)
		}
	})
	return root
}
