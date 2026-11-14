package limit

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"

	"agyctl/internal/apptarget"
	"agyctl/internal/assets"
	"agyctl/internal/fsx"
	"agyctl/internal/patchlock"
)

type manifest struct {
	Schema  int              `json:"schema"`
	Records []map[string]any `json:"records"`
}

type store struct{ directory string }

func (s store) path() string { return filepath.Join(s.directory, "model-limit-state.json") }

func (s store) load() (manifest, error) {
	data, err := os.ReadFile(s.path())
	if errors.Is(err, os.ErrNotExist) {
		return manifest{Schema: 1, Records: []map[string]any{}}, nil
	}
	if err != nil {
		return manifest{}, err
	}
	var m manifest
	if err = json.Unmarshal(data, &m); err != nil {
		return m, fmt.Errorf("invalid model-limit-state.json: %w", err)
	}
	if m.Schema != 1 || m.Records == nil {
		return m, fmt.Errorf("invalid model-limit-state.json schema or records")
	}
	for _, record := range m.Records {
		if record == nil {
			return m, fmt.Errorf("invalid null patch-state record")
		}
	}
	return m, nil
}

func (s store) append(record map[string]any) (err error) {
	lock, err := patchlock.AcquireStoreLock(s.directory)
	if err != nil {
		return err
	}
	defer func() {
		if releaseErr := lock.Release(); releaseErr != nil {
			err = errors.Join(err, releaseErr)
		}
	}()
	m, err := s.load()
	if err != nil {
		return err
	}
	m.Records = append(m.Records, record)
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	if err = os.MkdirAll(s.directory, 0700); err != nil {
		return err
	}
	return fsx.AtomicWrite(s.path(), append(data, '\n'), 0600)
}

func normalized(path string) (string, error) { return apptarget.Normalized(path) }

func resolved(path string) (string, error) { return apptarget.Resolved(path) }

func (s store) last(binary string) (map[string]any, error) {
	key, err := normalized(binary)
	if err != nil {
		return nil, err
	}
	m, err := s.load()
	if err != nil {
		return nil, err
	}
	for i := len(m.Records) - 1; i >= 0; i-- {
		path, ok := m.Records[i]["binary_path"].(string)
		if !ok {
			continue
		}
		candidate, err := normalized(path)
		if err != nil {
			return nil, err
		}
		if candidate == key {
			return m.Records[i], nil
		}
	}
	return nil, nil
}

func (s store) backupPath(binary, sha string) (string, error) {
	key, err := normalized(binary)
	if err != nil {
		return "", err
	}
	identity := fsx.SHA256([]byte(key))[:16]
	name := filepath.Base(binary)
	extension := filepath.Ext(name)
	stem := strings.TrimSuffix(name, extension)
	return filepath.Join(s.directory, fmt.Sprintf("%s-%s-%s%s", stem, identity, sha, extension)), nil
}

type registry struct {
	Schema    int              `json:"schema"`
	Entries   []map[string]any `json:"entries"`
	originals [][]byte
}

// loadRegistry parses compat/versions.json from the verified asset snapshot.
// A nil snapshot (only for direct library use in tests) falls back to reading
// the file under root; a non-nil snapshot must contain the file and never
// rereads it from disk.
func loadRegistry(root string, snap *assets.Snapshot) (registry, error) {
	var reg registry
	data, err := assets.ReadFile(snap, root, "compat/versions.json")
	if err != nil {
		return reg, err
	}
	if err = json.Unmarshal(data, &reg); err != nil {
		return reg, err
	}
	if reg.Schema != 1 || len(reg.Entries) == 0 {
		return reg, fmt.Errorf("invalid compatibility registry schema or entries")
	}
	for _, entry := range reg.Entries {
		body, err := hex.DecodeString(stringField(entry, "orig_body_hex"))
		if err != nil {
			return reg, fmt.Errorf("invalid original bytes in registry: %w", err)
		}
		// The assemblers support exactly one admitted original size per
		// architecture: the entry must declare that size as a positive integer
		// matching the recorded bytes, so JSON drift fails loudly instead of
		// silently reusing a constant or truncating a fractional size.
		arch := stringField(entry, "arch")
		size, ok := funcSizes[arch]
		if !ok {
			return reg, fmt.Errorf("registry entry %s declares unsupported architecture %q", stringField(entry, "id"), arch)
		}
		raw, ok := entry["func_size"].(float64)
		if !ok || raw <= 0 || raw != math.Trunc(raw) || int(raw) != len(body) || int(raw) != size {
			return reg, fmt.Errorf(
				"registry entry %s must declare func_size as a positive integer equal to the recorded body length and the supported %s function size %#x",
				stringField(entry, "id"), arch, size)
		}
		if fsx.SHA256(body) != stringField(entry, "orig_body_sha256") {
			return reg, fmt.Errorf("original byte signature is inconsistent for registry entry %s", stringField(entry, "id"))
		}
		reg.originals = append(reg.originals, body)
	}
	return reg, nil
}

// Originals returns the recorded original function bodies that the byte gate
// admits, so other commands screen against the same registry.
func Originals(root string, snap *assets.Snapshot) ([][]byte, error) {
	reg, err := loadRegistry(root, snap)
	if err != nil {
		return nil, err
	}
	return reg.originals, nil
}

func stringField(record map[string]any, key string) string {
	value, _ := record[key].(string)
	return value
}

// classify reports compatibility for the informational compat output. Trust
// follows byte signatures only: an exact binary-sha match is "verified-exact";
// a version/channel match is the advisory "version-match" (the bytes differ
// from every recorded build, which is itself diagnostic); anything else is
// "unverified". The patch gate never consumes these labels.
func (reg registry) classify(version, channel, sha string) (string, map[string]any) {
	if sha != "" {
		for _, entry := range reg.Entries {
			if stringField(entry, "binary_sha256") == sha {
				return "verified-exact", entry
			}
		}
	}
	if version != "" {
		for _, entry := range reg.Entries {
			matchChannel := channel == "" || stringField(entry, "channel") == "" || stringField(entry, "channel") == channel
			if stringField(entry, "app_version") == version && matchChannel {
				return "version-match", entry
			}
		}
	}
	return "unverified", nil
}
