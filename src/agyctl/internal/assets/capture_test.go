package assets

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"agyctl/internal/testutil"
)

func TestCaptureReadsSelectedScopesOnce(t *testing.T) {
	root := testutil.TempDir(t)
	if err := os.MkdirAll(filepath.Join(root, "compat"), 0755); err != nil {
		t.Fatal(err)
	}
	layout := filepath.Join(root, "compat", "install-layout.json")
	if err := os.WriteFile(layout, []byte(`{"schema":1}`), 0600); err != nil {
		t.Fatal(err)
	}
	snapshot, err := Capture(root, "layout")
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(layout, []byte(`{"schema":2}`), 0600); err != nil {
		t.Fatal(err)
	}
	data, err := snapshot.Read("compat/install-layout.json")
	if err != nil || string(data) != `{"schema":1}` {
		t.Fatalf("snapshot followed the file: %q %v", data, err)
	}
	if _, err = snapshot.Read("compat/versions.json"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("an asset outside the selected scopes must not be read from disk: %v", err)
	}
}

func TestCaptureRefusesUnknownMissingAndLinkedAssets(t *testing.T) {
	root := testutil.TempDir(t)
	if _, err := Capture(root, "nonexistent"); err == nil || !strings.Contains(err.Error(), "unavailable") {
		t.Fatalf("unknown scope: %v", err)
	}
	if _, err := Capture(root, "layout"); err == nil {
		t.Fatal("a missing asset must fail")
	}
	if err := os.MkdirAll(filepath.Join(root, "compat"), 0755); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "elsewhere.json")
	if err := os.WriteFile(target, []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(root, "compat", "install-layout.json")); err != nil {
		t.Skipf("symbolic links unavailable: %v", err)
	}
	if _, err := Capture(root, "layout"); err == nil || !strings.Contains(err.Error(), "link") {
		t.Fatalf("a linked asset must be refused: %v", err)
	}
}
