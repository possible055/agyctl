package compaction

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"agyctl/internal/apptarget"
	"agyctl/internal/fsx"
	"agyctl/internal/layout"
)

func recordedByteCount(record map[string]any) (int, error) {
	data, err := json.Marshal(record["bytes_changed"])
	if err != nil {
		return 0, err
	}
	var count int
	if string(data) == "null" || json.Unmarshal(data, &count) != nil || count <= 0 {
		return 0, errors.New("the recorded changed-byte count is invalid — refusing")
	}
	return count, nil
}

type preparedTransaction struct {
	prepare  *prepareRecord
	plan     Plan
	original []byte
	sibling  string
	repo     string
	source   string
	recorded map[string]any
}

// The caller holds the shared operation lock. Recovery validates the entire
// transaction before writing bookkeeping or bytes, even when only cleanup is
// needed. Missing action is the original schema-1 patch direction.
func recoverPrepared(binary string, reg Registry, s store, command string, candidates []layout.Target) (map[string]any, error) {
	p, err := s.loadPrepare(binary)
	if err != nil {
		return nil, &operationRefusal{kind: "prepare-invalid", err: err}
	}
	if p == nil {
		return nil, nil
	}
	current, err := os.ReadFile(binary)
	if err != nil {
		return nil, err
	}
	v, err := validatePrepared(binary, current, p, reg, s)
	if err != nil {
		return nil, &operationRefusal{kind: "prepare-invalid", err: err}
	}
	sha := fsx.SHA256(current)
	if p.action() == "restore" {
		if command != "restore" {
			return nil, &operationRefusal{kind: "prepare-invalid", err: errors.New("an interrupted compaction restore is pending — resume it with 'compaction restore' before patching")}
		}
		return finishRestore(binary, current, v, s, candidates)
	}
	if command == "restore" && sha == p.OriginalSHA {
		if err = verifyInstalled(binary, sha); err != nil {
			return nil, err
		}
		if err = s.clearPrepare(binary); err != nil {
			return nil, err
		}
		return map[string]any{"binary": binary, "restored": false, "not_applied": true, "binary_sha256": sha, "prepare_record_completed": true}, nil
	}
	wroteBinary := false
	if sha == p.OriginalSHA {
		if err = requireStopped(binary, candidates); err != nil {
			return nil, err
		}
		if _, err = fsx.ReplaceVerified(binary, v.plan.Output(), sha); err != nil {
			return nil, err
		}
		wroteBinary = true
	}
	entry := v.recorded
	if err = verifyInstalled(binary, p.NewSHA); err != nil {
		return nil, err
	}
	if entry == nil {
		entry, err = preparedPatchEntry(binary, v)
		if err != nil {
			return nil, err
		}
		if err = s.append(entry); err != nil {
			return nil, err
		}
	}
	if err = s.clearPrepare(binary); err != nil {
		return nil, fmt.Errorf("the patch was recorded but its prepare record could not be cleared: %w", err)
	}
	if command == "restore" {
		// The interrupted patch now has its ownership record. The ordinary
		// restore path writes a fresh direction-aware prepare before replacing.
		return nil, nil
	}
	return map[string]any{"binary": binary, "dry_run": false, "applied": wroteBinary, "already_applied": !wroteBinary, "binary_sha256_before": p.OriginalSHA, "binary_sha256_after": p.NewSHA, "disk_patch_equals_loaded": false, "prepare_record_completed": true, "record": entry}, nil
}

func validatePrepared(binary string, current []byte, p *prepareRecord, reg Registry, s store) (*preparedTransaction, error) {
	key, err := apptarget.Normalized(binary)
	if err != nil {
		return nil, err
	}
	if p.Target != key || strings.TrimSpace(p.Operation) == "" || strings.TrimSpace(p.Operation) != p.Operation {
		return nil, errors.New("the prepared compaction target or operation identity is invalid — refusing")
	}
	if p.action() != "patch" && p.action() != "restore" {
		return nil, fmt.Errorf("unknown prepared compaction action %q — refusing", p.Action)
	}
	if !isSHA256(p.OriginalSHA) || !isSHA256(p.NewSHA) || p.OriginalSHA == p.NewSHA {
		return nil, errors.New("the prepared compaction input/output hashes are invalid — refusing")
	}
	sha := fsx.SHA256(current)
	if sha != p.OriginalSHA && sha != p.NewSHA {
		return nil, errors.New("the binary changed outside the prepared compaction transaction — refusing to overwrite drift")
	}
	var target *Target
	var input *InputState
	for ti := range reg.Targets {
		if reg.Targets[ti].ID != p.TargetID {
			continue
		}
		for ii := range reg.Targets[ti].Inputs {
			candidate := &reg.Targets[ti].Inputs[ii]
			if candidate.Input == p.Input && candidate.Fingerprint() == p.Fingerprint && candidate.BinarySHA == p.OriginalSHA && candidate.OutputSHA == p.NewSHA {
				target, input = &reg.Targets[ti], candidate
			}
		}
	}
	if input == nil {
		return nil, errors.New("the prepared compaction recipe identity, fingerprint or input/output hashes no longer match the registry — refusing")
	}
	v := &preparedTransaction{prepare: p}
	seen := map[string]bool{}
	seenPaths := map[string]bool{}
	for _, backup := range p.Backups {
		if seen[backup.Kind] || backup.SHA256 != p.OriginalSHA || backup.Path == "" {
			return nil, errors.New("the prepared compaction backup evidence is duplicated or has an invalid input hash — refusing")
		}
		seen[backup.Kind] = true
		backupKey, err := apptarget.Normalized(backup.Path)
		if err != nil {
			return nil, err
		}
		if backupKey == key || seenPaths[backupKey] {
			return nil, errors.New("the prepared backup paths are not distinct from the target and each other — refusing")
		}
		seenPaths[backupKey] = true
		switch backup.Kind {
		case "sibling":
			plain, err := apptarget.Normalized(binary + ".orig")
			if err != nil {
				return nil, err
			}
			qualified, err := apptarget.Normalized(binary + ".orig." + p.OriginalSHA)
			if err != nil {
				return nil, err
			}
			if backupKey != plain && backupKey != qualified {
				return nil, errors.New("the prepared sibling backup path does not belong to this target — refusing")
			}
			v.sibling = backup.Path
		case "repo":
			expected, err := s.backupPath(binary, p.OriginalSHA)
			if err != nil {
				return nil, err
			}
			expectedKey, err := apptarget.Normalized(expected)
			if err != nil {
				return nil, err
			}
			if backupKey != expectedKey {
				return nil, errors.New("the prepared tool-home backup path does not belong to this target — refusing")
			}
			v.repo = backup.Path
		default:
			return nil, fmt.Errorf("unknown prepared compaction backup kind %q — refusing", backup.Kind)
		}
		original, err := os.ReadFile(backup.Path)
		if err != nil || fsx.SHA256(original) != p.OriginalSHA {
			return nil, fmt.Errorf("the prepared %s backup does not verify against the registered input — refusing: %w", backup.Kind, errors.Join(err, errors.New("backup verification failed")))
		}
		if v.source == "" {
			v.source, v.original = backup.Path, original
		}
	}
	if v.source == "" || (p.action() == "patch" && (!seen["sibling"] || !seen["repo"])) {
		return nil, errors.New("the prepared compaction transaction lacks required verified backup evidence — refusing")
	}
	if int64(len(v.original)) != target.BinarySize {
		return nil, errors.New("the prepared input backup has the wrong registered size — refusing")
	}
	admission, refusal := admitTarget(v.original, target, input)
	if refusal != nil {
		return nil, refusal.error()
	}
	v.plan, err = BuildPlan(v.original, admission)
	if err != nil {
		return nil, err
	}
	if v.plan.BytesChanged != p.BytesChanged {
		return nil, errors.New("the prepared changed-byte count does not match the registered segments — refusing")
	}
	if err = validatePreparedHistory(v, s); err != nil {
		return nil, err
	}
	if v.recorded != nil {
		expected := p.NewSHA
		if p.action() == "restore" {
			expected = p.OriginalSHA
		}
		if sha != expected {
			return nil, errors.New("the completed prepared operation no longer matches the installed bytes — refusing drift")
		}
	}
	return v, nil
}

func validatePreparedHistory(v *preparedTransaction, s store) error {
	p := v.prepare
	m, err := s.load()
	if err != nil {
		return err
	}
	var history []map[string]any
	for _, record := range m.Records {
		path := stringField(record, "binary_path")
		if path == "" {
			if stringField(record, "operation") == p.Operation {
				return errors.New("the prepared operation conflicts with a malformed manifest record — refusing")
			}
			continue
		}
		key, err := apptarget.Normalized(path)
		if err != nil {
			return err
		}
		if stringField(record, "operation") == p.Operation {
			if key != p.Target || stringField(record, "action") != p.action() || v.recorded != nil || !sameRecipeRecord(record, p) {
				return errors.New("the prepared operation conflicts with its manifest identity — refusing")
			}
			if p.action() == "patch" {
				if !samePatchRecord(record, p) {
					return errors.New("the prepared patch hashes conflict with its manifest record — refusing")
				}
			} else if stringField(record, "binary_sha256") != p.OriginalSHA {
				return errors.New("the prepared restore hash conflicts with its manifest record — refusing")
			}
			v.recorded = record
		}
		if key == p.Target {
			history = append(history, record)
		}
	}
	if v.recorded != nil {
		if len(history) == 0 || stringField(history[len(history)-1], "operation") != p.Operation {
			return errors.New("a newer compaction transaction superseded the prepare record — refusing")
		}
		if p.action() == "patch" {
			return matchPreparedBackups(v.recorded, p)
		}
		history = history[:len(history)-1]
	}
	if p.action() == "restore" {
		if len(history) == 0 || !samePatchRecord(history[len(history)-1], p) {
			return errors.New("the prepared restore has no matching preceding patch ownership record — refusing")
		}
		return matchPreparedBackups(history[len(history)-1], p)
	}
	if len(history) != 0 && stringField(history[len(history)-1], "action") == "patch" {
		return errors.New("the prepared patch conflicts with another recorded patch operation — refusing")
	}
	return nil
}

func sameRecipeRecord(record map[string]any, p *prepareRecord) bool {
	return stringField(record, "target_id") == p.TargetID && stringField(record, "input") == p.Input && stringField(record, "recipe_fingerprint") == p.Fingerprint
}

func samePatchRecord(record map[string]any, p *prepareRecord) bool {
	return stringField(record, "action") == "patch" && sameRecipeRecord(record, p) && stringField(record, "binary_sha256_before") == p.OriginalSHA && stringField(record, "binary_sha256_after") == p.NewSHA
}

func matchPreparedBackups(record map[string]any, p *prepareRecord) error {
	for _, backup := range p.Backups {
		field := "backup_sibling"
		if backup.Kind == "repo" {
			field = "repo_backup"
		}
		if stringField(record, field+"_sha256") != p.OriginalSHA || stringField(record, field) == "" {
			return errors.New("the prepared backup hashes conflict with the ownership record — refusing")
		}
		left, err := apptarget.Normalized(backup.Path)
		if err != nil {
			return err
		}
		right, err := apptarget.Normalized(stringField(record, field))
		if err != nil {
			return err
		}
		if left != right {
			return errors.New("the prepared backup paths conflict with the ownership record — refusing")
		}
	}
	return nil
}

func preparedPatchEntry(binary string, v *preparedTransaction) (map[string]any, error) {
	path, err := apptarget.Resolved(binary)
	if err != nil {
		return nil, err
	}
	p, plan := v.prepare, v.plan
	return map[string]any{"action": "patch", "at": time.Now().Format(time.RFC3339), "binary_path": path, "binary_sha256_before": p.OriginalSHA, "binary_sha256_after": p.NewSHA, "backup_sibling": v.sibling, "backup_sibling_sha256": p.OriginalSHA, "repo_backup": v.repo, "repo_backup_sha256": p.OriginalSHA, "target_id": plan.TargetID, "input": plan.Input, "recipe_fingerprint": plan.Fingerprint, "qualification": plan.Qualification, "value_targets": plan.ValueTargets, "bytes_changed": plan.BytesChanged, "app_version": nullable(p.AppVersion), "operation": p.Operation}, nil
}

func finishRestore(binary string, current []byte, v *preparedTransaction, s store, candidates []layout.Target) (map[string]any, error) {
	p := v.prepare
	if fsx.SHA256(current) == p.NewSHA {
		if err := requireStopped(binary, candidates); err != nil {
			return nil, err
		}
		if _, err := fsx.ReplaceVerified(binary, v.original, p.NewSHA); err != nil {
			return nil, err
		}
	}
	if err := verifyInstalled(binary, p.OriginalSHA); err != nil {
		return nil, err
	}
	entry := v.recorded
	if entry == nil {
		path, err := apptarget.Resolved(binary)
		if err != nil {
			return nil, err
		}
		plan := v.plan
		entry = map[string]any{"action": "restore", "at": time.Now().Format(time.RFC3339), "binary_path": path, "binary_sha256": p.OriginalSHA, "source": v.source, "target_id": plan.TargetID, "input": plan.Input, "recipe_fingerprint": plan.Fingerprint, "operation": p.Operation, "app_version": nullable(p.AppVersion), "qualification": plan.Qualification, "value_targets": plan.ValueTargets}
		if err = s.append(entry); err != nil {
			return nil, err
		}
	}
	if err := s.clearPrepare(binary); err != nil {
		return nil, fmt.Errorf("the restore was recorded but its prepare record could not be cleared: %w", err)
	}
	return map[string]any{"binary": binary, "restored": true, "binary_sha256": p.OriginalSHA, "source": v.source, "record": entry, "prepare_record_completed": true}, nil
}

func verifyInstalled(binary, expected string) error {
	sha, err := fsx.Hash(binary)
	if err != nil {
		return err
	}
	if sha != expected {
		return errors.New("installed binary changed before completing the compaction transaction — refusing")
	}
	return nil
}
