package assets

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Snapshot holds the immutable bytes of the runtime assets captured while the
// asset scopes were captured. Parsers of trusted compat data must
// read from a snapshot instead of reopening asset paths, so a write between
// verification and parsing cannot replace verified bytes.
type Snapshot struct {
	digest string
	files  map[string][]byte
}

// Digest is the digest of the verified runtime manifest or explicit development inputs.
func (s *Snapshot) Digest() string { return s.digest }

// Fingerprint identifies only the captured files, so unrelated optional features
// do not become dependencies of a selected management operation.
func (s *Snapshot) Fingerprint() string {
	records := make([]string, 0, len(s.files))
	for name, data := range s.files {
		sum := sha256.Sum256(data)
		records = append(records, name+"\x00"+hex.EncodeToString(sum[:])+"\n")
	}
	sort.Strings(records)
	sum := sha256.Sum256([]byte(strings.Join(records, "")))
	return hex.EncodeToString(sum[:])
}

// Read returns the captured bytes of an asset addressed by its slash-separated
// path relative to the asset root. An asset missing from the snapshot is an
// ErrNotExist error, never a reread of the file from disk.
func (s *Snapshot) Read(relPath string) ([]byte, error) {
	if data, ok := s.files[relPath]; ok {
		return bytes.Clone(data), nil
	}
	return nil, fmt.Errorf("verified asset %s is missing from the captured runtime snapshot: %w", relPath, os.ErrNotExist)
}

// ReadFile returns the captured bytes of an asset. A nil snapshot falls
// back to reading the file under root; the fallback exists only for direct
// library use in tests, and production callers must always pass the snapshot
// captured by verifyRuntime. A non-nil snapshot never falls back: an asset it
// does not contain is reported as ErrNotExist.
func ReadFile(snap *Snapshot, root, relPath string) ([]byte, error) {
	if snap == nil {
		return os.ReadFile(filepath.Join(root, filepath.FromSlash(relPath)))
	}
	return snap.Read(relPath)
}
