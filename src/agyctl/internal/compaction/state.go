package compaction

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"agyctl/internal/apptarget"
	"agyctl/internal/fsx"
	"agyctl/internal/patchlock"
)

// State lives beside the limit and tool-output features' records in the
// shared tool home so all features serialize on the same operation lock. The
// manifest file and the prepare-record prefix carry the feature name, so the
// features never write into each other's transaction files.
const (
	stateFileName       = "compaction-state.json"
	prepareTemplate     = "compaction-prepare-%s.json"
	limitStateFile      = "model-limit-state.json"
	toolOutputStateFile = "tool-output-state.json"
)

type manifest struct {
	Schema  int              `json:"schema"`
	Records []map[string]any `json:"records"`
}

type store struct{ directory string }

func (s store) path() string { return filepath.Join(s.directory, stateFileName) }

// beginOperation takes the shared mutation lock through the patchlock
// package; the compaction feature must serialize with limit and tool-output
// on the same lock file, never on a separate one.
func (s store) beginOperation(command, id string) (*patchlock.Operation, error) {
	return patchlock.BeginOperation(s.directory, command, id)
}

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
		return m, fmt.Errorf("invalid %s: %w", stateFileName, err)
	}
	if m.Schema != 1 || m.Records == nil {
		return m, fmt.Errorf("invalid %s schema or records", stateFileName)
	}
	for _, record := range m.Records {
		if record == nil {
			return m, fmt.Errorf("invalid null compaction state record")
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

func (s store) last(binary string) (map[string]any, error) {
	key, err := apptarget.Normalized(binary)
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
		candidate, err := apptarget.Normalized(path)
		if err != nil {
			return nil, err
		}
		if candidate == key {
			return m.Records[i], nil
		}
	}
	return nil, nil
}

// backupPath returns the feature-isolated tool-home backup name: it carries
// the feature name and the full input SHA, so compaction backups never
// collide with limit or tool-output backups of the same installation.
func (s store) backupPath(binary, sha string) (string, error) {
	key, err := apptarget.Normalized(binary)
	if err != nil {
		return "", err
	}
	identity := fsx.SHA256([]byte(key))[:16]
	name := filepath.Base(binary)
	extension := filepath.Ext(name)
	stem := strings.TrimSuffix(name, extension)
	return filepath.Join(s.directory, fmt.Sprintf("compaction-%s-%s-%s%s", stem, identity, sha, extension)), nil
}

// siblingBackup reuses the existing .orig sibling when it already holds this
// exact input and otherwise isolates the backup under .orig.<input-sha>. An
// existing sibling that does not match is never overwritten.
func (s store) siblingBackup(binary, sha string) (string, error) {
	sibling := binary + ".orig"
	existing, err := fsx.Hash(sibling)
	if err == nil && existing != sha {
		sibling += "." + sha
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	return sibling, nil
}

type prepareRecord struct {
	Schema        int                    `json:"schema"`
	Action        string                 `json:"action,omitempty"`
	Operation     string                 `json:"operation"`
	Target        string                 `json:"target"`
	TargetID      string                 `json:"target_id"`
	Input         string                 `json:"input"`
	Fingerprint   string                 `json:"recipe_fingerprint"`
	OriginalSHA   string                 `json:"binary_sha256_before"`
	NewSHA        string                 `json:"binary_sha256_after"`
	BytesChanged  int                    `json:"bytes_changed"`
	Qualification string                 `json:"qualification"`
	Values        map[string]ValueTarget `json:"value_targets,omitempty"`
	AppVersion    string                 `json:"app_version,omitempty"`
	Backups       []prepareBackup        `json:"backups"`
	CreatedAt     string                 `json:"created_at"`
	Status        string                 `json:"status"`
}

func (p prepareRecord) action() string {
	if p.Action == "" {
		return "patch"
	}
	return p.Action
}

type prepareBackup struct {
	Kind   string `json:"kind"`
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

func (s store) preparePath(binary string) (string, error) {
	key, err := apptarget.Normalized(binary)
	if err != nil {
		return "", err
	}
	return filepath.Join(s.directory, fmt.Sprintf(prepareTemplate, fsx.SHA256([]byte(key))[:16])), nil
}

func (s store) loadPrepare(binary string) (*prepareRecord, error) {
	path, err := s.preparePath(binary)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var record prepareRecord
	if err = json.Unmarshal(data, &record); err != nil {
		return nil, fmt.Errorf("invalid compaction prepare record %s: %w", path, err)
	}
	if record.Schema != 1 || record.Status != "prepared" || record.OriginalSHA == "" || record.NewSHA == "" || record.Target == "" {
		return nil, fmt.Errorf("invalid compaction prepare record %s", path)
	}
	return &record, nil
}

func (s store) writePrepare(record prepareRecord) error {
	path, err := s.preparePath(record.Target)
	if err != nil {
		return err
	}
	record.Schema = 1
	record.Status = "prepared"
	if record.CreatedAt == "" {
		record.CreatedAt = time.Now().UTC().Format(time.RFC3339)
	}
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(s.directory, 0700); err != nil {
		return err
	}
	return fsx.AtomicWrite(path, append(data, '\n'), 0600)
}

func (s store) clearPrepare(binary string) error {
	path, err := s.preparePath(binary)
	if err != nil {
		return err
	}
	if err = os.Remove(path); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func (s store) finishFailedReplacement(binary string, cause error) error {
	if errors.Is(cause, fsx.ErrRolledBack) && !errors.Is(cause, fsx.ErrRollbackFailed) {
		if err := s.clearPrepare(binary); err != nil {
			return errors.Join(cause, fmt.Errorf("the operation-start binary was restored but the prepare record could not be cleared: %w", err))
		}
	}
	return cause
}

func (s store) rollback(binary string, data []byte, expected string, cause error) error {
	_, err := fsx.ReplaceVerified(binary, data, expected)
	if err != nil {
		return errors.Join(cause, fmt.Errorf("rollback refused or failed: %w", err))
	}
	return cause
}

// foreignPatchOutput reports the output SHA of another feature's last patch
// record for a binary, or an empty string when that feature holds no matching
// patch record. The compaction feature only reads limit and tool-output state
// to report conflicts and drift; it never repairs or removes their patches.
func (s store) foreignPatchOutput(binary, currentSHA, stateFile string) (string, error) {
	key, err := apptarget.Normalized(binary)
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(filepath.Join(s.directory, stateFile))
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	var m manifest
	if err = json.Unmarshal(data, &m); err != nil {
		return "", fmt.Errorf("invalid %s: %w", stateFile, err)
	}
	for i := len(m.Records) - 1; i >= 0; i-- {
		record := m.Records[i]
		path, ok := record["binary_path"].(string)
		if !ok {
			continue
		}
		candidate, err := apptarget.Normalized(path)
		if err != nil {
			return "", err
		}
		if candidate != key {
			continue
		}
		action, _ := record["action"].(string)
		after, _ := record["binary_sha256_after"].(string)
		if action == "patch" && after == currentSHA {
			return after, nil
		}
		return "", nil
	}
	return "", nil
}

func (s store) LimitPatchOutput(binary, currentSHA string) (string, error) {
	return s.foreignPatchOutput(binary, currentSHA, limitStateFile)
}

func (s store) ToolOutputPatchOutput(binary, currentSHA string) (string, error) {
	return s.foreignPatchOutput(binary, currentSHA, toolOutputStateFile)
}

func stringField(record map[string]any, key string) string {
	value, _ := record[key].(string)
	return value
}
