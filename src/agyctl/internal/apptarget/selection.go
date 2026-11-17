package apptarget

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

type BuildSelection struct {
	AppVersion      string `json:"app_version,omitempty"`
	VersionSource   string `json:"version_source"`
	SelectionSource string `json:"selection_source"`
	Indices         []int  `json:"-"`
}

// SelectBuild narrows versioned recipes before their independent byte gates.
// Standalone offline binaries and legacy unversioned registries still require
// exact whole-file admission; neither path guesses a nearby version.
func SelectBuild(binary string, versions []string) (BuildSelection, error) {
	version, source, err := ReadVersion(binary)
	selection := BuildSelection{AppVersion: version, VersionSource: source, SelectionSource: "binary-sha256"}
	if err != nil {
		return selection, fmt.Errorf("cannot read the selected installation's version: %w", err)
	}
	if version == "" {
		resources := filepath.Dir(filepath.Dir(binary))
		for _, metadata := range []string{filepath.Join(resources, "app.asar"), filepath.Join(resources, "app", "package.json")} {
			if _, err := os.Lstat(metadata); err == nil {
				return selection, fmt.Errorf("the selected installation has app metadata but no valid version: %s", metadata)
			} else if !errors.Is(err, os.ErrNotExist) {
				return selection, fmt.Errorf("cannot verify the selected installation's app metadata: %w", err)
			}
		}
	}
	versioned := false
	for _, declared := range versions {
		versioned = versioned || declared != ""
	}
	for i, declared := range versions {
		if version == "" || !versioned || declared == version {
			selection.Indices = append(selection.Indices, i)
		}
	}
	if version != "" && versioned {
		selection.SelectionSource = "app-version"
	}
	if len(selection.Indices) == 0 {
		return selection, fmt.Errorf("no registered recipe for Antigravity %s; refusing without selecting another version", version)
	}
	return selection, nil
}
