package limit

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"time"

	"agyctl/internal/fsx"
)

// The prepare record makes an interrupted patch inspectable: it is written
// atomically after both verified backups exist and before the target binary
// is replaced. An authorized patch --apply may complete or consume it;
// status only describes it and never writes.
type prepareRecord struct {
	SettingsSource string          `json:"settings_source,omitempty"`
	Schema         int             `json:"schema"`
	Operation      string          `json:"operation"`
	Target         string          `json:"target"`
	OriginalSHA    string          `json:"original_sha256"`
	NewSHA         string          `json:"new_sha256"`
	Backups        []prepareBackup `json:"backups"`
	IDs            []int           `json:"ids"`
	Limit          int             `json:"limit"`
	ModelLimits    []ModelLimit    `json:"model_limits,omitempty"`
	Encoding       string          `json:"encoding,omitempty"`
	AppVersion     string          `json:"app_version,omitempty"`
	Compat         string          `json:"compat,omitempty"`
	FuncVA         string          `json:"func_va,omitempty"`
	CreatedAt      string          `json:"created_at"`
	Status         string          `json:"status"`
}

type prepareBackup struct {
	Kind   string `json:"kind"`
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

func (s store) preparePath(binary string) (string, error) {
	key, err := normalized(binary)
	if err != nil {
		return "", err
	}
	return filepath.Join(s.directory, fmt.Sprintf("limit-prepare-%s.json", fsx.SHA256([]byte(key))[:16])), nil
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
		return nil, fmt.Errorf("invalid prepare record %s: %w", path, err)
	}
	if record.Schema != 1 || record.Status != "prepared" || record.OriginalSHA == "" || record.NewSHA == "" || record.Target == "" {
		return nil, fmt.Errorf("invalid prepare record %s", path)
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
			return errors.Join(cause, fmt.Errorf("the original binary was restored but the prepare record could not be cleared: %w", err))
		}
	}
	return cause
}

func checkPreparedSettings(prepared *prepareRecord, binary, sha, shaAfter string, settings patchSettings) error {
	key, err := normalized(binary)
	if err != nil {
		return err
	}
	if prepared.Target != key {
		return fmt.Errorf("the prepared record targets %s, not the current binary — inspect it with 'limit status' and resolve it explicitly", prepared.Target)
	}
	if prepared.OriginalSHA != sha {
		return fmt.Errorf("the prepared record expects original hash %s but the installed binary is %s — inspect it with 'limit status' and resolve the prepared record explicitly", prepared.OriginalSHA, sha)
	}
	values := prepared.ModelLimits
	if len(values) == 0 {
		values = uniformLimits(prepared.IDs, prepared.Limit)
	}
	if err := validateSettings(patchSettings{Encoding: prepared.Encoding, ModelLimits: values, IDs: prepared.IDs, Limit: prepared.Limit}); err != nil {
		return fmt.Errorf("invalid prepared settings: %w", err)
	}
	if prepared.NewSHA != shaAfter || !reflect.DeepEqual(values, settings.ModelLimits) || prepared.Encoding != settings.Encoding {
		return fmt.Errorf("a prepared record holds different settings for this target (ids %v, limit %d) — apply those recorded settings or restore first; refusing to overwrite it", prepared.IDs, prepared.Limit)
	}
	return nil
}

func (s store) completePrepareRecord(binary, installedSHA string, prepared *prepareRecord, result map[string]any) error {
	if installedSHA != prepared.NewSHA {
		return fmt.Errorf("the prepared record expects patched hash %s but the installed binary is %s — refusing to complete it", prepared.NewSHA, installedSHA)
	}
	op, err := s.beginOperation("patch", prepared.Operation)
	if err != nil {
		return err
	}
	defer func() {
		if releaseErr := op.release(); releaseErr != nil {
			err = errors.Join(err, releaseErr)
		}
	}()
	for _, backup := range prepared.Backups {
		sha, hashErr := fsx.Hash(backup.Path)
		if hashErr != nil {
			return fmt.Errorf("the prepared record's %s backup %s is unreadable — refusing to complete the record: %w", backup.Kind, backup.Path, hashErr)
		}
		if sha != backup.SHA256 {
			return fmt.Errorf("the prepared record's %s backup %s changed since preparation — refusing to complete the record", backup.Kind, backup.Path)
		}
	}
	last, err := s.last(binary)
	if err != nil {
		return err
	}
	if last == nil || stringField(last, "action") != "patch" || stringField(last, "binary_sha256_after") != prepared.NewSHA {
		sibling, repo := "", ""
		for _, backup := range prepared.Backups {
			switch backup.Kind {
			case "sibling":
				sibling = backup.Path
			case "repo":
				repo = backup.Path
			}
		}
		path, err := resolved(binary)
		if err != nil {
			return err
		}
		record := map[string]any{"action": "patch", "at": time.Now().Format(time.RFC3339), "binary_path": path, "binary_sha256_before": prepared.OriginalSHA, "binary_sha256_after": prepared.NewSHA, "backup_sibling": sibling, "backup_sibling_sha256": prepared.OriginalSHA, "repo_backup": repo, "repo_backup_sha256": prepared.OriginalSHA, "app_version": nullable(prepared.AppVersion), "compat": prepared.Compat, "ids": prepared.IDs, "limit": prepared.Limit, "model_limits": prepared.ModelLimits, "encoding": prepared.Encoding, "settings_source": prepared.SettingsSource, "func": Func, "func_va": prepared.FuncVA, "operation": op.id}
		if err = s.append(record); err != nil {
			return err
		}
		result["record"] = record
	}
	if err = s.clearPrepare(binary); err != nil {
		return fmt.Errorf("the prepared record was completed but could not be cleared: %w", err)
	}
	result["prepare_record_completed"] = true
	return nil
}

func prepareReport(s store, binary, installedSHA string, prepared *prepareRecord) (map[string]any, error) {
	backups := []map[string]any{}
	for _, backup := range prepared.Backups {
		report, err := backupReport(backup.Path, backup.SHA256)
		if err != nil {
			return nil, err
		}
		report["kind"] = backup.Kind
		backups = append(backups, report)
	}
	last, err := s.last(binary)
	if err != nil {
		return nil, err
	}
	var recovery, action string
	switch {
	case last != nil && stringField(last, "action") == "patch" && stringField(last, "binary_sha256_after") == prepared.NewSHA:
		recovery, action = "recorded", "the patch is already recorded; an authorized 'limit patch --apply' or 'limit restore' consumes this leftover record"
	case installedSHA == prepared.NewSHA:
		recovery, action = "applied-not-recorded", "run 'agyctl limit patch --apply' with the recorded ids and limit to finish the bookkeeping, or 'limit restore' to recover the original binary"
	case installedSHA == prepared.OriginalSHA:
		recovery, action = "prepared-not-applied", "run 'agyctl limit patch --apply' with the recorded ids and limit to apply it, or 'limit restore' to discard the preparation"
	default:
		recovery, action = "target-drift", "the target binary matches neither the recorded original nor prepared hash — inspect it manually before any authorized action"
	}
	return map[string]any{"operation": prepared.Operation, "created_at": prepared.CreatedAt, "status": prepared.Status, "original_sha256": prepared.OriginalSHA, "new_sha256": prepared.NewSHA, "ids": prepared.IDs, "limit": prepared.Limit, "model_limits": prepared.ModelLimits, "encoding": prepared.Encoding, "settings_source": prepared.SettingsSource, "backups": backups, "recovery": recovery, "recovery_action": action}, nil
}
