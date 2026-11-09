package assets

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

//go:embed native-scopes.json
var nativeScopesJSON []byte

// Capture reads the compat data files of the selected scopes once. Parsers read
// from the returned snapshot, so a file replaced after capture cannot change
// what a command decides on.
func Capture(root string, scopes ...string) (*Snapshot, error) {
	var nativeScopes map[string][]string
	if err := json.Unmarshal(nativeScopesJSON, &nativeScopes); err != nil {
		return nil, err
	}
	r, err := os.OpenRoot(root)
	if err != nil {
		return nil, err
	}
	defer func() { _ = r.Close() }()
	snapshot := &Snapshot{files: map[string][]byte{}}
	for _, scope := range scopes {
		names, ok := nativeScopes[scope]
		if !ok {
			return nil, fmt.Errorf("asset scope %s is unavailable", scope)
		}
		for _, name := range names {
			if _, ok := snapshot.files[name]; ok {
				continue
			}
			data, err := readRegular(r, filepath.FromSlash(name))
			if err != nil {
				return nil, fmt.Errorf("asset %s: %w", name, err)
			}
			snapshot.files[name] = data
		}
	}
	snapshot.digest = snapshot.Fingerprint()
	return snapshot, nil
}

func readRegular(root *os.Root, name string) ([]byte, error) {
	for current := name; current != "."; current = filepath.Dir(current) {
		info, err := root.Lstat(current)
		if err != nil {
			return nil, err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("asset must not be a link: %s", name)
		}
	}
	file, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("unsupported asset: %s", name)
	}
	return io.ReadAll(file)
}
