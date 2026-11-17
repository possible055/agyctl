package apptarget

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestSelectBuildUsesExactInstalledVersion(t *testing.T) {
	resources := filepath.Join(t.TempDir(), "resources")
	if err := os.MkdirAll(filepath.Join(resources, "app"), 0700); err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(resources, "bin", "language_server.exe")
	pkg := filepath.Join(resources, "app", "package.json")
	if err := os.WriteFile(pkg, []byte(`{"version":"2.32.1"}`), 0600); err != nil {
		t.Fatal(err)
	}
	selection, err := SelectBuild(binary, []string{"2.31.2", "2.32.1", "2.32.1", "2.32.10"})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(selection.Indices, []int{1, 2}) || selection.SelectionSource != "app-version" || selection.AppVersion != "2.32.1" {
		t.Fatalf("unexpected selection: %+v", selection)
	}
	if _, err := SelectBuild(binary, []string{"2.31.2", "2.32.10"}); err == nil || !strings.Contains(err.Error(), "no registered recipe") {
		t.Fatalf("an unknown version must not select a nearby recipe: %v", err)
	}
	if err := os.WriteFile(filepath.Join(resources, "app.asar"), []byte("truncated"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := SelectBuild(binary, []string{"2.32.1"}); err == nil || !strings.Contains(err.Error(), "cannot read") {
		t.Fatalf("a corrupt primary version source must not silently fall back: %v", err)
	}
}

func TestSelectBuildKeepsOfflineAndLegacyHashAdmission(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "resources", "bin", "language_server.exe")
	selection, err := SelectBuild(binary, []string{"2.31.2", "2.32.1"})
	if err != nil || !reflect.DeepEqual(selection.Indices, []int{0, 1}) || selection.SelectionSource != "binary-sha256" || selection.AppVersion != "" {
		t.Fatalf("offline selection must explicitly leave admission to the whole-file gate: %+v, %v", selection, err)
	}
	resources := filepath.Dir(filepath.Dir(binary))
	if err := os.MkdirAll(filepath.Join(resources, "app"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []string{`{}`, `{"version":""}`} {
		if err := os.WriteFile(filepath.Join(resources, "app", "package.json"), []byte(invalid), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := SelectBuild(binary, []string{"2.31.2", "2.32.1"}); err == nil || !strings.Contains(err.Error(), "metadata but no valid version") {
			t.Fatalf("existing metadata without a version must not become an offline source: %v", err)
		}
	}
	if err := os.WriteFile(filepath.Join(resources, "app", "package.json"), []byte(`{"version":"2.31.2"}`), 0600); err != nil {
		t.Fatal(err)
	}
	selection, err = SelectBuild(binary, []string{"", ""})
	if err != nil || !reflect.DeepEqual(selection.Indices, []int{0, 1}) || selection.SelectionSource != "binary-sha256" {
		t.Fatalf("legacy unversioned registries must keep their exact-hash contract: %+v, %v", selection, err)
	}
}
