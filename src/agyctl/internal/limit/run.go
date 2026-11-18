package limit

import (
	"bytes"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"time"

	"agyctl/internal/assets"
	"agyctl/internal/fsx"
	"agyctl/internal/layout"
	"agyctl/internal/lspatch"
)

type options struct {
	command, binary, ids, out         string
	modelLimits                       string
	resolveSettings, settingsExplicit bool
	limit                             int
	dryRun, apply, json, help         bool
}

var errNoInstall = errors.New("language server binary not found (use --binary)")

func parseOptions(args []string) (options, error) {
	o := options{command: "patch", ids: DefaultIDs, limit: DefaultLimit, resolveSettings: true}
	if len(args) > 0 {
		switch args[0] {
		case "status", "patch", "restore", "versions", "metadata", "verify-state":
			o.command = args[0]
			args = args[1:]
		case "--restore":
			o.command = "restore"
			args = args[1:]
		case "check-db", "--check-db":
			return o, fmt.Errorf("check-db has moved to the panel's read-only conversation diagnostics")
		}
	}
	flags := flag.NewFlagSet(o.command, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.BoolVar(&o.json, "json", false, "return JSON")
	flags.BoolVar(&o.help, "help", false, "show command help")
	flags.BoolVar(&o.help, "h", false, "show command help")
	if o.command == "status" || o.command == "patch" || o.command == "restore" || o.command == "versions" {
		flags.StringVar(&o.binary, "binary", "", "language server path")
	}
	if o.command == "patch" {
		flags.StringVar(&o.ids, "ids", DefaultIDs, "model ids/ranges")
		flags.StringVar(&o.modelLimits, "model-limits", "", "complete per-model ID=LIMIT mapping")
		flags.IntVar(&o.limit, "limit", DefaultLimit, "context token limit")
		flags.BoolVar(&o.dryRun, "dry-run", false, "do not modify input")
		flags.StringVar(&o.out, "out", "", "dry-run output path")
		flags.BoolVar(&o.apply, "apply", false, "apply in place")
		flags.BoolVar(&o.apply, "in-place", false, "apply in place")
	}
	if err := flags.Parse(args); err != nil {
		return o, err
	}
	if flags.NArg() > 0 {
		return o, fmt.Errorf("unexpected argument %q", flags.Arg(0))
	}
	hasModels, hasLegacy := false, false
	flags.Visit(func(f *flag.Flag) {
		if f.Name == "model-limits" {
			hasModels = true
		}
		if f.Name == "ids" || f.Name == "limit" {
			hasLegacy = true
		}
	})
	o.settingsExplicit = hasModels || hasLegacy
	if hasModels && hasLegacy {
		return o, fmt.Errorf("--model-limits cannot be combined with --ids or --limit")
	}
	if hasModels {
		values, err := ParseModelLimits(o.modelLimits)
		if err != nil {
			return o, err
		}
		for _, value := range values {
			if value.Limit > lspatch.MaxContextLimit {
				return o, fmt.Errorf("context limits must not exceed %d tokens", lspatch.MaxContextLimit)
			}
		}
	} else if o.command == "patch" && o.limit > lspatch.MaxContextLimit {
		return o, fmt.Errorf("context limits must not exceed %d tokens", lspatch.MaxContextLimit)
	}
	o.dryRun = o.dryRun || !o.apply
	return o, nil
}

// Run returns exactly one JSON-serializable result and never writes to stdout.
// The compat registry is parsed from the snapshot captured while the runtime
// assets were verified; a nil snapshot (only for direct library use in tests)
// falls back to reading compat/versions.json under root.
func Run(root string, snap *assets.Snapshot, args []string) (any, int, error) {
	return RunWithNative(root, snap, args, nil)
}

func RunWithNative(root string, snap *assets.Snapshot, args []string, native lspatch.Handler) (any, int, error) {
	o, err := parseOptions(args)
	if err != nil {
		return failure(o.command, err)
	}
	if o.help {
		return map[string]any{"command": o.command, "commands": []string{"status", "patch", "restore", "versions", "metadata", "verify-state"}, "default_ids": DefaultIDs, "default_limit": DefaultLimit, "patch_flags": []string{"--binary", "--ids", "--limit", "--model-limits", "--dry-run", "--out", "--apply", "--in-place", "--json"}}, 0, nil
	}
	if o.command == "metadata" {
		return map[string]any{"limitIds": DefaultIDs, "limitTokens": DefaultLimit}, 0, nil
	}
	dataRoot, err := layout.DataRoot()
	if err != nil {
		return failure(o.command, err)
	}
	s := store{directory: filepath.Join(dataRoot, "backups")}
	if o.command == "verify-state" {
		if _, err = s.load(); err != nil {
			return failure(o.command, err)
		}
		return map[string]any{"valid": true}, 0, nil
	}
	reg, err := loadRegistry(root, snap)
	if err != nil {
		return failure(o.command, err)
	}
	var candidates []layout.Target
	if o.binary != "" {
		candidates, err = layout.DefaultCandidates(root, snap)
	} else {
		candidates, err = layout.Candidates(root, snap)
	}
	if err != nil {
		return failure(o.command, err)
	}
	binary, err := resolveBinary(candidates, o.binary)
	if o.command == "versions" {
		result := map[string]any{"entries": reg.Entries, "installation": nil}
		if err != nil && !errors.Is(err, errNoInstall) && !errors.Is(err, os.ErrNotExist) {
			return failure(o.command, err)
		}
		addWarnings(result, err)
		if binary != "" {
			version, source, versionErr := readVersion(binary)
			addWarnings(result, versionErr)
			sha, err := fsx.Hash(binary)
			if err != nil {
				return failure(o.command, err)
			}
			compat, entry := reg.classify(version, channelOf(binary), sha)
			result["installation"] = map[string]any{"binary": binary, "app_version": nullable(version), "version_source": source, "binary_sha256": sha, "compat": compatResult(compat, entry)}
		}
		return result, 0, nil
	}
	if err != nil {
		return failure(o.command, err)
	}
	var result any
	if native != nil && (o.command == "status" || o.command == "patch" || o.command == "restore") {
		request := lspatch.Request{Feature: "limit", Command: o.command, Binary: binary, Apply: !o.dryRun, Out: o.out, UseCurrentLimit: !o.settingsExplicit}
		if o.command == "patch" {
			requested := o
			if !o.settingsExplicit {
				owned, err := lspatch.HasState(s.directory, binary)
				if err != nil {
					return failure(o.command, err)
				}
				if owned {
					requested.resolveSettings = false
				}
			}
			settings, _, settingsErr := s.requestedSettings(binary, PatchState{Kind: "original"}, requested)
			if settingsErr != nil {
				return failure(o.command, settingsErr)
			}
			config := lspatch.LimitConfig{Enabled: true, ModelLimits: settings.ModelLimits}
			request.Desired.Limit = &config
		}
		value, handled, nativeErr := native(request)
		if nativeErr != nil {
			return failure(o.command, nativeErr)
		}
		if handled {
			if o.command == "status" {
				if err := decorateNativeStatus(binary, value, reg, s, candidates); err != nil {
					return failure(o.command, err)
				}
			}
			return value, 0, nil
		}
	}
	switch o.command {
	case "status":
		result, err = status(binary, reg, s, candidates)
	case "patch":
		result, err = patch(binary, o, reg, s, candidates)
	case "restore":
		result, err = restore(binary, reg, s, candidates)
	default:
		err = fmt.Errorf("unknown limit command %s", o.command)
	}
	if err != nil {
		return failure(o.command, err)
	}
	return result, 0, nil
}

func failure(command string, err error) (any, int, error) {
	return map[string]any{"command": command, "error": err.Error()}, 1, err
}
func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func addWarnings(result map[string]any, diagnostics ...error) {
	warnings, _ := result["warnings"].([]string)
	for _, diagnostic := range diagnostics {
		if diagnostic != nil {
			warnings = append(warnings, diagnostic.Error())
		}
	}
	if len(warnings) > 0 {
		result["warnings"] = warnings
	}
}
func compatResult(status string, entry map[string]any) map[string]any {
	var id any
	if entry != nil {
		id = entry["id"]
	}
	return map[string]any{"status": status, "entry_id": id}
}

func resolveBinary(candidates []layout.Target, override string) (string, error) {
	if override != "" {
		stat, err := os.Stat(override)
		if err != nil {
			return "", err
		}
		if !stat.Mode().IsRegular() {
			return "", fmt.Errorf("language server is not a regular file: %s", override)
		}
		return override, nil
	}
	selected := ""
	for _, candidate := range candidates {
		stat, err := os.Stat(candidate.LanguageServer)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return "", err
		}
		if stat.Mode().IsRegular() {
			if selected != "" {
				return "", fmt.Errorf("multiple Antigravity installations found; use --binary or AGYCTL_APP_DIR")
			}
			selected = candidate.LanguageServer
		}
	}
	if selected != "" {
		return selected, nil
	}
	return "", errNoInstall
}

func backupReport(path, expected string) (map[string]any, error) {
	result := map[string]any{"path": nullable(path), "exists": false, "verified": false}
	if path == "" {
		return result, nil
	}
	stat, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return result, nil
	}
	if err != nil {
		return nil, err
	}
	exists := stat.Mode().IsRegular()
	result["exists"] = exists
	if exists && expected != "" {
		sha, err := fsx.Hash(path)
		if err != nil {
			return nil, err
		}
		result["verified"] = sha == expected
	}
	return result, nil
}

func status(binary string, reg registry, s store, candidates []layout.Target) (any, error) {
	data, err := os.ReadFile(binary)
	if err != nil {
		return nil, err
	}
	sha := fsx.SHA256(data)
	version, source, versionErr := readVersion(binary)
	compat, entry := reg.classify(version, channelOf(binary), sha)
	pstate, err := DetectState(data, reg.originals)
	if err != nil {
		return nil, err
	}
	sibling, repo, siblingSHA, repoSHA := "", "", "", ""
	if pstate.Kind == "original" {
		sibling = binary + ".orig"
		repo, err = s.backupPath(binary, sha)
		if err != nil {
			return nil, err
		}
		siblingSHA = sha
		repoSHA = sha
	} else {
		record, err := s.last(binary)
		if err != nil {
			return nil, err
		}
		if record != nil && stringField(record, "action") == "patch" && stringField(record, "binary_sha256_after") == sha {
			originalSHA := stringField(record, "binary_sha256_before")
			if stringField(record, "backup_sibling") != "" && stringField(record, "backup_sibling_sha256") == originalSHA {
				sibling = stringField(record, "backup_sibling")
				siblingSHA = originalSHA
			}
			if stringField(record, "repo_backup") != "" && stringField(record, "repo_backup_sha256") == originalSHA {
				repo = stringField(record, "repo_backup")
				repoSHA = originalSHA
			}
		}
	}
	siblingReport, err := backupReport(sibling, siblingSHA)
	if err != nil {
		return nil, err
	}
	repoReport, err := backupReport(repo, repoSHA)
	if err != nil {
		return nil, err
	}
	running, probeErr := appRunning(binary, candidates)
	var ids, limit any
	if pstate.Kind == "patched" {
		ids = pstate.IDs
		limit = pstate.Limit
	}
	result := map[string]any{"binary": binary, "channel": channelOf(binary), "app_version": nullable(version), "version_source": source, "binary_sha256": sha, "compat": compatResult(compat, entry), "patch_state": map[string]any{"kind": pstate.Kind, "func_va": fmt.Sprintf("%#x", pstate.FuncVA), "format": pstate.Format, "arch": pstate.Arch, "ids": ids, "limit": limit, "model_limits": pstate.ModelLimits, "encoding": pstate.Encoding}, "language_server_running": running, "sibling_backup": siblingReport, "repo_backup": repoReport}
	prepared, err := s.loadPrepare(binary)
	if err != nil {
		return nil, err
	}
	if prepared != nil {
		report, err := prepareReport(s, binary, sha, prepared)
		if err != nil {
			return nil, err
		}
		result["prepare_record"] = report
	}
	record, err := s.last(binary)
	if err != nil {
		return nil, err
	}
	saved, settingsState, settingsErr := savedSettingsReport(record, pstate)
	addWarnings(result, settingsErr)
	result["saved_settings"] = saved
	result["settings_state"] = settingsState
	addWarnings(result, versionErr, probeErr)
	return result, nil
}

func patch(binary string, o options, reg registry, s store, candidates []layout.Target) (result map[string]any, err error) {
	data, err := os.ReadFile(binary)
	if err != nil {
		return nil, err
	}
	sha := fsx.SHA256(data)
	version, _, versionErr := readVersion(binary)
	compat, entry := reg.classify(version, channelOf(binary), sha)
	pstate, err := DetectState(data, reg.originals)
	if err != nil {
		return nil, err
	}
	settings, settingsSource, err := s.requestedSettings(binary, pstate, o)
	if err != nil {
		return nil, err
	}
	settings.Source = settingsSource
	ids := settings.IDs
	o.limit = settings.Limit
	result = map[string]any{"binary": binary, "ids": ids, "limit": o.limit, "model_limits": settings.ModelLimits, "settings_source": settingsSource, "dry_run": o.dryRun, "applied": false, "binary_sha256_before": sha, "compat": compatResult(compat, entry)}
	addWarnings(result, versionErr)
	if pstate.Kind == "patched" {
		if reflect.DeepEqual(pstate.ModelLimits, settings.ModelLimits) {
			result["already_patched"] = true
			result["binary_sha256_after"] = sha
			prepared, prepErr := s.loadPrepare(binary)
			if prepErr != nil {
				return nil, prepErr
			}
			if prepared != nil && !o.dryRun {
				if err = checkPreparedSettings(prepared, binary, prepared.OriginalSHA, sha, settings); err != nil {
					return nil, err
				}
				if err = s.completePrepareRecord(binary, sha, prepared, result); err != nil {
					return nil, err
				}
			}
			return result, nil
		}
		prepared, prepErr := s.loadPrepare(binary)
		if prepErr != nil {
			return nil, prepErr
		}
		if prepared != nil && prepared.NewSHA == sha {
			return nil, fmt.Errorf("a prepared record holds different settings for the installed patch (ids %v, limit %d) — complete it with 'patch --apply' using the recorded settings, or restore first", prepared.IDs, prepared.Limit)
		}
		return nil, fmt.Errorf("already patched with different settings; run 'agyctl limit restore' first to change them")
	}
	if pstate.Kind == "size-mismatch" {
		return nil, fmt.Errorf("%s has no implemented %s function size — different build; refusing", Func, pstate.Arch)
	}
	if pstate.Kind != "original" {
		return nil, fmt.Errorf("function bytes match no recorded original in the compat registry (%d entries) — refusing", len(reg.Entries))
	}
	plan, err := planSettings(data, settings)
	if err != nil {
		return nil, err
	}
	out := ApplyPatch(data, plan)
	result["plan"] = plan
	result["binary_sha256_after"] = fsx.SHA256(out)
	changed := 0
	for i, v := range data {
		if v != out[i] {
			changed++
		}
	}
	result["bytes_changed"] = changed
	if o.dryRun {
		if o.out != "" {
			input, err := normalized(binary)
			if err != nil {
				return nil, err
			}
			output, err := normalized(o.out)
			if err != nil {
				return nil, err
			}
			if input == output {
				return nil, fmt.Errorf("dry-run output must not replace the input binary")
			}
			file, err := os.OpenFile(o.out, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
			if err != nil {
				return nil, fmt.Errorf("create dry-run output without overwriting existing data: %w", err)
			}
			_, writeErr := file.Write(out)
			closeErr := file.Close()
			if err = errors.Join(writeErr, closeErr); err != nil {
				return nil, err
			}
			result["out"] = o.out
		}
		return result, nil
	}
	running, probeErr := appRunning(binary, candidates)
	if err := requireStopped(running, probeErr); err != nil {
		return nil, err
	}
	prepared, prepErr := s.loadPrepare(binary)
	if prepErr != nil {
		return nil, prepErr
	}
	operationID := ""
	if prepared != nil {
		if err = checkPreparedSettings(prepared, binary, sha, fsx.SHA256(out), settings); err != nil {
			return nil, err
		}
		operationID = prepared.Operation
	}
	op, opErr := s.beginOperation("patch", operationID)
	if opErr != nil {
		return nil, opErr
	}
	defer func() {
		if releaseErr := op.release(); releaseErr != nil {
			err = errors.Join(err, releaseErr)
		}
	}()
	record, err := patchBinarySettings(binary, data, out, sha, version, compat, settings, plan, s, op.identifier())
	if err != nil {
		return nil, err
	}
	if warning := stringField(record, "prepare_clear_warning"); warning != "" {
		delete(record, "prepare_clear_warning")
		addWarnings(result, errors.New(warning))
	}
	result["applied"] = true
	result["record"] = record
	return result, nil
}

func patchBinary(binary string, data, out []byte, sha, version, compat string, ids []int, target int, plan Plan, s store, operation string) (map[string]any, error) {
	return patchBinarySettings(binary, data, out, sha, version, compat, patchSettings{IDs: ids, Limit: target, ModelLimits: uniformLimits(ids, target)}, plan, s, operation)
}

func patchBinarySettings(binary string, data, out []byte, sha, version, compat string, settings patchSettings, plan Plan, s store, operation string) (map[string]any, error) {
	if err := lspatch.GuardStandalone(s.directory, binary, "limit"); err != nil {
		return nil, err
	}
	ids, target := settings.IDs, settings.Limit
	prepared, err := s.loadPrepare(binary)
	if err != nil {
		return nil, err
	}
	shaAfter := fsx.SHA256(out)
	if prepared != nil {
		if err = checkPreparedSettings(prepared, binary, sha, shaAfter, settings); err != nil {
			return nil, err
		}
	}
	targetKey, err := normalized(binary)
	if err != nil {
		return nil, err
	}
	sibling := binary + ".orig"
	existing, err := fsx.Hash(sibling)
	if err == nil && existing != sha {
		sibling += "." + sha
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if err = fsx.EnsureBackup(binary, sibling, sha); err != nil {
		return nil, err
	}
	if err = os.MkdirAll(s.directory, 0700); err != nil {
		return nil, err
	}
	repo, err := s.backupPath(binary, sha)
	if err != nil {
		return nil, err
	}
	if err = fsx.EnsureBackup(binary, repo, sha); err != nil {
		return nil, err
	}
	if err = s.writePrepare(prepareRecord{Operation: operation, Target: targetKey, OriginalSHA: sha, NewSHA: shaAfter, Backups: []prepareBackup{{Kind: "sibling", Path: sibling, SHA256: sha}, {Kind: "repo", Path: repo, SHA256: sha}}, IDs: ids, Limit: target, ModelLimits: settings.ModelLimits, Encoding: settings.Encoding, SettingsSource: settings.Source, AppVersion: version, Compat: compat, FuncVA: fmt.Sprintf("%#x", plan.FuncVA)}); err != nil {
		return nil, err
	}
	shaAfter, err = fsx.ReplaceVerified(binary, out, sha)
	if err != nil {
		return nil, s.finishFailedReplacement(binary, err)
	}
	path, err := resolved(binary)
	if err != nil {
		return nil, rollback(binary, data, shaAfter, err)
	}
	record := map[string]any{"action": "patch", "at": time.Now().Format(time.RFC3339), "binary_path": path, "binary_sha256_before": sha, "binary_sha256_after": shaAfter, "backup_sibling": sibling, "backup_sibling_sha256": sha, "repo_backup": repo, "repo_backup_sha256": sha, "app_version": nullable(version), "compat": compat, "ids": ids, "limit": target, "model_limits": settings.ModelLimits, "encoding": settings.Encoding, "settings_source": settings.Source, "func": Func, "func_va": fmt.Sprintf("%#x", plan.FuncVA), "operation": operation}
	if err = s.append(record); err != nil {
		return nil, rollback(binary, data, shaAfter, err)
	}
	if err = s.clearPrepare(binary); err != nil {
		record["prepare_clear_warning"] = fmt.Sprintf("the patch was recorded but the prepare record could not be cleared: %v", err)
	}
	return record, nil
}

func rollback(binary string, data []byte, expected string, cause error) error {
	_, err := fsx.ReplaceVerified(binary, data, expected)
	if err != nil {
		return errors.Join(cause, fmt.Errorf("rollback refused or failed: %w", err))
	}
	return cause
}

func restore(binary string, reg registry, s store, candidates []layout.Target) (result any, err error) {
	running, probeErr := appRunning(binary, candidates)
	if err := requireStopped(running, probeErr); err != nil {
		return nil, err
	}
	op, opErr := s.beginOperation("restore", "")
	if opErr != nil {
		return nil, opErr
	}
	defer func() {
		if releaseErr := op.release(); releaseErr != nil {
			err = errors.Join(err, releaseErr)
		}
	}()
	result, err = restoreBinary(binary, reg, s, op.identifier())
	if err != nil {
		return nil, err
	}
	if clearErr := s.clearPrepare(binary); clearErr != nil {
		addWarnings(result.(map[string]any), fmt.Errorf("restored, but the prepare record could not be cleared: %w", clearErr))
	}
	return result, nil
}

func restoreBinary(binary string, reg registry, s store, operation string) (map[string]any, error) {
	if err := lspatch.GuardStandalone(s.directory, binary, "limit"); err != nil {
		return nil, err
	}
	current, err := os.ReadFile(binary)
	if err != nil {
		return nil, err
	}
	shaNow := fsx.SHA256(current)
	record, err := s.last(binary)
	if err != nil {
		return nil, err
	}
	source := binary + ".orig"
	expected := ""
	if record != nil && stringField(record, "action") == "patch" {
		if shaNow != stringField(record, "binary_sha256_after") {
			return nil, fmt.Errorf("installed binary changed since the last patch (app update?) — refusing to overwrite a newer binary with an older one")
		}
		source = stringField(record, "backup_sibling")
		expected = stringField(record, "binary_sha256_before")
		sha, err := fsx.Hash(source)
		if err != nil || sha != stringField(record, "backup_sibling_sha256") || sha != expected {
			return nil, fmt.Errorf("sibling backup is missing or its checksum does not match the manifest — refusing; repo backup copy: %s", stringField(record, "repo_backup"))
		}
	} else {
		original, err := os.ReadFile(source)
		if err != nil {
			return nil, fmt.Errorf("no patch record and no readable sibling backup: %w", err)
		}
		expected = fsx.SHA256(original)
		if expected == shaNow {
			return map[string]any{"binary": binary, "already_restored": true, "binary_sha256": shaNow}, nil
		}
		originalState, err := DetectState(original, reg.originals)
		if err != nil {
			return nil, err
		}
		if originalState.Kind != "original" {
			return nil, fmt.Errorf("sibling backup does not hold a recorded original function — refusing")
		}
		patched, err := DetectState(current, reg.originals)
		if err != nil {
			return nil, err
		}
		if patched.Kind != "patched" {
			return nil, fmt.Errorf("no patch record and installed binary is not a recognized patch — refusing")
		}
		plan, err := planSettings(original, settingsFromState(patched))
		if err != nil {
			return nil, err
		}
		if !bytes.Equal(ApplyPatch(original, plan), current) {
			return nil, fmt.Errorf("sibling backup cannot reproduce the installed patched binary — refusing")
		}
	}
	original, err := os.ReadFile(source)
	if err != nil {
		return nil, err
	}
	if fsx.SHA256(original) != expected {
		return nil, fmt.Errorf("backup does not match the expected original SHA-256 — refusing before write")
	}
	originalState, err := DetectState(original, reg.originals)
	if err != nil {
		return nil, err
	}
	if originalState.Kind != "original" {
		return nil, fmt.Errorf("backup does not hold a recorded original function — refusing")
	}
	sha, err := fsx.ReplaceVerified(binary, original, shaNow)
	if err != nil {
		return nil, err
	}
	path, err := resolved(binary)
	if err != nil {
		return nil, rollback(binary, current, sha, err)
	}
	var version any
	if record != nil {
		version = record["app_version"]
	}
	restoreRecord := map[string]any{"action": "restore", "at": time.Now().Format(time.RFC3339), "binary_path": path, "binary_sha256": sha, "source": source, "app_version": version, "operation": operation}
	if record != nil {
		for _, key := range []string{"ids", "limit", "model_limits", "encoding"} {
			if value, ok := record[key]; ok {
				restoreRecord[key] = value
			}
		}
	}
	if err = s.append(restoreRecord); err != nil {
		return nil, rollback(binary, current, sha, err)
	}
	return map[string]any{"binary": binary, "restored": true, "binary_sha256": sha, "source": source}, nil
}
