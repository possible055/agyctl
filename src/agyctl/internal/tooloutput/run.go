package tooloutput

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"agyctl/internal/apptarget"
	"agyctl/internal/assets"
	"agyctl/internal/fsx"
	"agyctl/internal/layout"
)

type options struct {
	command, binary string
	apply, json     bool
	help            bool
}

var errNoInstall = errors.New("language server binary not found (use --binary)")

// refusalKindAlreadyApplied marks a re-apply over this tool's own recorded
// output: an explicit no-op, never a rewrite.
const refusalKindAlreadyApplied = "already-applied"

func parseOptions(args []string) (options, error) {
	o := options{command: "patch"}
	if len(args) > 0 {
		switch args[0] {
		case "status", "patch", "restore", "versions":
			o.command = args[0]
			args = args[1:]
		}
	}
	flags := flag.NewFlagSet(o.command, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.BoolVar(&o.json, "json", false, "return JSON")
	flags.BoolVar(&o.help, "help", false, "show command help")
	flags.BoolVar(&o.help, "h", false, "show command help")
	flags.StringVar(&o.binary, "binary", "", "language server path")
	if o.command == "patch" {
		flags.BoolVar(&o.apply, "apply", false, "apply in place; without it the command only plans in memory")
	}
	if err := flags.Parse(args); err != nil {
		return o, err
	}
	if flags.NArg() > 0 {
		return o, fmt.Errorf("unexpected argument %q", flags.Arg(0))
	}
	if o.command != "versions" && o.binary == "" {
		return o, fmt.Errorf("%s requires --binary PATH; tool-output never guesses between multiple installations", o.command)
	}
	return o, nil
}

// Run returns exactly one JSON-serializable result and never writes to stdout.
// The registry is parsed from the snapshot captured while the runtime assets
// were verified; a nil snapshot (only for direct library use in tests) falls
// back to reading compat/tool-output.json under root.
func Run(root string, snap *assets.Snapshot, args []string) (any, int, error) {
	o, err := parseOptions(args)
	if err != nil {
		return failure(o.command, err)
	}
	if o.help {
		return map[string]any{
			"command":     o.command,
			"commands":    []string{"versions", "status", "patch", "restore"},
			"patch_flags": []string{"--binary", "--apply", "--json"},
			"notes":       []string{"patch without --apply plans in memory only and never writes", "restore rewrites the binary back to the recorded operation input"},
		}, 0, nil
	}
	dataRoot, err := layout.DataRoot()
	if err != nil {
		return failure(o.command, err)
	}
	s := store{directory: filepath.Join(dataRoot, "backups")}
	reg, err := LoadRegistry(root, snap)
	if err != nil {
		return failure(o.command, err)
	}
	candidates, err := layout.Candidates(root, snap)
	if err != nil && o.command != "versions" {
		return failure(o.command, err)
	}
	binary, resolveErr := resolveBinary(candidates, o.binary)
	// versions reports discovery problems too, except a plain missing
	// installation, which it reports as installation: null.
	if resolveErr != nil && !errors.Is(resolveErr, errNoInstall) {
		return failure(o.command, resolveErr)
	}
	if o.command != "versions" && binary == "" {
		return failure(o.command, resolveErr)
	}
	switch o.command {
	case "versions":
		return versions(binary, reg)
	case "status":
		return status(binary, reg, s, candidates)
	case "patch":
		var result any
		result, err = patch(binary, o, reg, s, candidates)
		if err != nil {
			return failure(o.command, err)
		}
		return result, 0, nil
	case "restore":
		var result any
		result, err = restore(binary, reg, s, candidates)
		if err != nil {
			return failure(o.command, err)
		}
		return result, 0, nil
	default:
		return failure(o.command, fmt.Errorf("unknown tool-output command %s", o.command))
	}
}

// resolveBinary prefers an explicit --binary and otherwise requires exactly
// one installed candidate; tool-output never guesses between the stable and
// development channels.
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
				return "", fmt.Errorf("multiple Antigravity installations found; use --binary; tool-output never guesses between stable and development channels")
			}
			selected = candidate.LanguageServer
		}
	}
	if selected == "" {
		return "", errNoInstall
	}
	return selected, nil
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

func verificationLevels(target *Target) map[string]any {
	live := "unverified"
	if target.Qualification == "supported" {
		live = "verified"
	}
	return map[string]any{
		"static":   "verified " + target.VerifiedAt + " (registered whole-file SHA-256 and byte segments)",
		"offline":  "verified (the registry recipe reproduces the registered output hash)",
		"live_app": live + " (capacity targets await live App qualification while qualification is " + target.Qualification + ")",
	}
}

func targetSummary(target *Target) map[string]any {
	return map[string]any{"target_id": target.ID, "product": target.Product, "channel": target.Channel, "platform": target.Platform, "arch": target.Arch, "binary_name": target.BinaryName, "binary_size": target.BinarySize, "member": target.Member, "qualification": target.Qualification, "verified_at": target.VerifiedAt, "capacity_targets": target.CapacityTargets, "out_of_scope": target.OutOfScope, "notes": target.Notes, "evidence": target.Evidence}
}

func versions(binary string, reg Registry) (any, int, error) {
	targets := make([]map[string]any, 0, len(reg.Targets))
	for ti := range reg.Targets {
		target := &reg.Targets[ti]
		inputs := make([]map[string]any, 0, len(target.Inputs))
		for ii := range target.Inputs {
			state := &target.Inputs[ii]
			inputs = append(inputs, map[string]any{"input": state.Input, "binary_sha256": state.BinarySHA, "output_sha256": state.OutputSHA, "recipe_fingerprint": state.Fingerprint(), "segments": len(state.Segments)})
		}
		entry := targetSummary(target)
		entry["inputs"] = inputs
		entry["verification"] = verificationLevels(target)
		targets = append(targets, entry)
	}
	result := map[string]any{"targets": targets, "installation": nil}
	if binary == "" {
		return result, 0, nil
	}
	sha, err := fsx.Hash(binary)
	if err != nil {
		return failure("versions", err)
	}
	version, source, versionErr := apptarget.ReadVersion(binary)
	matched := ""
	for ti := range reg.Targets {
		for ii := range reg.Targets[ti].Inputs {
			switch sha {
			case reg.Targets[ti].Inputs[ii].BinarySHA:
				matched = reg.Targets[ti].ID + "/" + reg.Targets[ti].Inputs[ii].Input
			case reg.Targets[ti].Inputs[ii].OutputSHA:
				matched = reg.Targets[ti].ID + "/output"
			}
		}
	}
	result["installation"] = map[string]any{"binary": binary, "app_version": nullable(version), "version_source": source, "binary_sha256": sha, "matched": nullable(matched)}
	addWarnings(result, versionErr)
	return result, 0, nil
}

// fileState classifies the installed binary for status output. A disk patch
// does not mean the running app loaded it or that the model received the new
// capacity; status reports the disk state only.
func fileState(data []byte, reg Registry, s store, binary string) (string, map[string]any, error) {
	sha := fsx.SHA256(data)
	adm, refusal := Admit(data, reg)
	if adm != nil {
		return "registered-input", map[string]any{"target_id": adm.Target.ID, "input": adm.State.Input, "output_sha256": adm.State.OutputSHA}, nil
	}
	record, err := s.last(binary)
	if err != nil {
		return "", nil, err
	}
	if record != nil && stringField(record, "action") == "patch" && stringField(record, "binary_sha256_after") == sha {
		return "managed-output", map[string]any{"record_operation": stringField(record, "operation"), "restore_source": stringField(record, "backup_sibling")}, nil
	}
	if refusal.Kind == RefusalUnmanagedOutput || refusal.Kind == RefusalUnknownInput || refusal.Kind == RefusalSizeMismatch {
		limitSHA, err := s.LimitPatchOutput(binary, sha)
		if err != nil {
			return "", nil, err
		}
		if limitSHA != "" {
			return "limit-patched", map[string]any{"detail": "the binary matches limit's last patch output; tool-output refuses to patch over or restore across it"}, nil
		}
		if refusal.Kind == RefusalUnmanagedOutput {
			return "recognized-output", map[string]any{"detail": refusal.Detail}, nil
		}
	}
	return "unknown", map[string]any{"refusal_kind": refusal.Kind, "detail": refusal.Detail}, nil
}

func status(binary string, reg Registry, s store, candidates []layout.Target) (any, int, error) {
	data, err := os.ReadFile(binary)
	if err != nil {
		return failure("status", err)
	}
	sha := fsx.SHA256(data)
	version, source, versionErr := apptarget.ReadVersion(binary)
	state, detail, err := fileState(data, reg, s, binary)
	if err != nil {
		return failure("status", err)
	}
	result := map[string]any{"binary": binary, "channel": apptarget.ChannelOf(binary), "app_version": nullable(version), "version_source": source, "binary_sha256": sha, "file_state": state, "state_detail": detail, "disk_patch_equals_loaded": false}
	addWarnings(result, versionErr)
	record, err := s.last(binary)
	if err != nil {
		return failure("status", err)
	}
	sibling, repo := "", ""
	if record != nil && stringField(record, "action") == "patch" {
		sibling = stringField(record, "backup_sibling")
		repo = stringField(record, "repo_backup")
	}
	result["sibling_backup"] = backupReport(sibling)
	result["repo_backup"] = backupReport(repo)
	prepared, err := s.loadPrepare(binary)
	if err != nil {
		return failure("status", err)
	}
	if prepared != nil {
		backups := []map[string]any{}
		for _, backup := range prepared.Backups {
			backupSHA, hashErr := fsx.Hash(backup.Path)
			exists := hashErr == nil
			backups = append(backups, map[string]any{"kind": backup.Kind, "path": backup.Path, "exists": exists, "verified": exists && backupSHA == backup.SHA256})
		}
		result["prepare_record"] = map[string]any{"operation": prepared.Operation, "created_at": prepared.CreatedAt, "target_id": prepared.TargetID, "input": prepared.Input, "recipe_fingerprint": prepared.Fingerprint, "binary_sha256_before": prepared.OriginalSHA, "binary_sha256_after": prepared.NewSHA, "bytes_changed": prepared.BytesChanged, "backups": backups}
	}
	return result, 0, nil
}

func backupReport(path string) map[string]any {
	result := map[string]any{"path": nullable(path), "exists": false, "verified": false}
	if path == "" {
		return result
	}
	stat, err := os.Stat(path)
	if err != nil || !stat.Mode().IsRegular() {
		return result
	}
	result["exists"] = true
	return result
}

// planFor admits a binary and builds its plan, distinguishing this tool's own
// recorded output (explicit no-op) from foreign or mixed states, which are
// refused with dedicated kinds and never auto-restored.
func planFor(binary string, data []byte, reg Registry, s store) (Plan, *Admission, *Refusal, error) {
	var zero Plan
	adm, refusal := Admit(data, reg)
	if refusal == nil {
		plan, err := BuildPlan(data, adm)
		if err != nil {
			return zero, nil, nil, err
		}
		return plan, adm, nil, nil
	}
	sha := fsx.SHA256(data)
	record, err := s.last(binary)
	if err != nil {
		return zero, nil, nil, err
	}
	if record != nil && stringField(record, "action") == "patch" && stringField(record, "binary_sha256_after") == sha {
		return zero, nil, &Refusal{Kind: refusalKindAlreadyApplied, Detail: "the binary already matches this tool's recorded output — nothing to apply"}, nil
	}
	if refusal.Kind == RefusalUnmanagedOutput || refusal.Kind == RefusalUnknownInput || refusal.Kind == RefusalSizeMismatch {
		limitSHA, err := s.LimitPatchOutput(binary, sha)
		if err != nil {
			return zero, nil, nil, err
		}
		if limitSHA != "" {
			return zero, nil, &Refusal{Kind: RefusalPatchConflict, Detail: "the binary matches limit's last patch output and is not a registered tool-output input — refusing to patch over another feature's patch; remove it with 'agyctl limit restore' first"}, nil
		}
	}
	return zero, nil, refusal, nil
}

func patch(binary string, o options, reg Registry, s store, candidates []layout.Target) (result map[string]any, err error) {
	data, err := os.ReadFile(binary)
	if err != nil {
		return nil, err
	}
	sha := fsx.SHA256(data)
	result = map[string]any{"binary": binary, "dry_run": !o.apply, "applied": false, "binary_sha256_before": sha, "disk_patch_equals_loaded": false}
	version, _, versionErr := apptarget.ReadVersion(binary)
	prepared, err := s.loadPrepare(binary)
	if err != nil {
		return nil, err
	}
	plan, admission, refusal, err := planFor(binary, data, reg, s)
	if err != nil {
		return nil, err
	}
	if refusal != nil {
		result["refusal"] = refusal
		if refusal.Kind == refusalKindAlreadyApplied {
			result["already_applied"] = true
			result["binary_sha256_after"] = sha
			if prepared != nil && prepared.NewSHA == sha {
				result["prepare_record_pending"] = true
				if o.apply {
					if err = completePreparedRecord(binary, sha, s, prepared); err != nil {
						return nil, err
					}
					result["prepare_record_completed"] = true
				}
			}
			return result, nil
		}
		return result, refusal.error()
	}
	addWarnings(result, versionErr)
	result["target_id"] = plan.TargetID
	result["target_member"] = plan.TargetMember
	result["input"] = plan.Input
	result["qualification"] = plan.Qualification
	result["recipe_fingerprint"] = plan.Fingerprint
	result["capacity_targets"] = plan.CapacityTargets
	result["bytes_changed"] = plan.BytesChanged
	result["binary_sha256_after"] = plan.AfterSHA
	result["verification"] = verificationLevels(admission.Target)
	if !o.apply {
		return result, nil
	}
	// Mutating path: lock first, then re-read, re-admit and re-plan under the
	// lock so the final source fingerprint and process check precede any write.
	op, opErr := s.beginOperation("tool-output patch", preparedOperationID(prepared, plan, binary))
	if opErr != nil {
		return nil, opErr
	}
	defer func() {
		if releaseErr := op.Release(); releaseErr != nil {
			err = errors.Join(err, releaseErr)
		}
	}()
	current, err := os.ReadFile(binary)
	if err != nil {
		return nil, err
	}
	if fsx.SHA256(current) != plan.BeforeSHA {
		return nil, errors.New("the binary changed while planning — refusing")
	}
	rePlan, _, reRefusal, err := planFor(binary, current, reg, s)
	if err != nil {
		return nil, err
	}
	if reRefusal != nil {
		result["refusal"] = reRefusal
		return result, reRefusal.error()
	}
	if rePlan.Fingerprint != plan.Fingerprint || rePlan.AfterSHA != plan.AfterSHA {
		return nil, errors.New("the plan changed between reads — refusing")
	}
	plan = rePlan
	running, probeErr := apptarget.AppRunning(binary, candidates)
	if err := apptarget.RequireStopped(running, probeErr); err != nil {
		return nil, err
	}
	prepared, err = s.loadPrepare(binary)
	if err != nil {
		return nil, err
	}
	if prepared != nil {
		if _, matchErr := PreparedMatches(prepared, binary, plan); matchErr != nil {
			return nil, matchErr
		}
	}
	record, err := applyPlan(binary, current, plan, version, s, op.ID())
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

// preparedOperationID resumes the operation id of an exactly matching prepare
// record so an interrupted apply keeps one operation identity; a mismatching
// record is refused before the lock instead of overwritten.
func preparedOperationID(prepared *prepareRecord, plan Plan, binary string) string {
	if prepared == nil {
		return ""
	}
	matches, err := PreparedMatches(prepared, binary, plan)
	if err != nil || !matches {
		return ""
	}
	return prepared.Operation
}

func completePreparedRecord(binary, installedSHA string, s store, prepared *prepareRecord) error {
	if installedSHA != prepared.NewSHA {
		return fmt.Errorf("the prepared record expects patched hash %s but the installed binary is %s — refusing to complete it", prepared.NewSHA, installedSHA)
	}
	op, err := s.beginOperation("tool-output patch", prepared.Operation)
	if err != nil {
		return err
	}
	defer func() {
		if releaseErr := op.Release(); releaseErr != nil {
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
		path, err := apptarget.Resolved(binary)
		if err != nil {
			return err
		}
		entry := map[string]any{"action": "patch", "at": time.Now().Format(time.RFC3339), "binary_path": path, "binary_sha256_before": prepared.OriginalSHA, "binary_sha256_after": prepared.NewSHA, "backup_sibling": sibling, "backup_sibling_sha256": prepared.OriginalSHA, "repo_backup": repo, "repo_backup_sha256": prepared.OriginalSHA, "target_id": prepared.TargetID, "input": prepared.Input, "recipe_fingerprint": prepared.Fingerprint, "qualification": prepared.Qualification, "capacity_targets": prepared.Capacity, "bytes_changed": prepared.BytesChanged, "app_version": nullable(prepared.AppVersion), "operation": op.ID()}
		if err = s.append(entry); err != nil {
			return err
		}
	}
	if err = s.clearPrepare(binary); err != nil {
		return fmt.Errorf("the prepared record was completed but could not be cleared: %w", err)
	}
	return nil
}

func applyPlan(binary string, data []byte, plan Plan, version string, s store, operation string) (map[string]any, error) {
	targetKey, err := apptarget.Normalized(binary)
	if err != nil {
		return nil, err
	}
	sibling, err := s.siblingBackup(binary, plan.BeforeSHA)
	if err != nil {
		return nil, err
	}
	if err = fsx.EnsureBackup(binary, sibling, plan.BeforeSHA); err != nil {
		return nil, err
	}
	if err = os.MkdirAll(s.directory, 0700); err != nil {
		return nil, err
	}
	repo, err := s.backupPath(binary, plan.BeforeSHA)
	if err != nil {
		return nil, err
	}
	if err = fsx.EnsureBackup(binary, repo, plan.BeforeSHA); err != nil {
		return nil, err
	}
	prepared := prepareRecord{
		Operation: operation, Target: targetKey, TargetID: plan.TargetID, Input: plan.Input,
		Fingerprint: plan.Fingerprint, OriginalSHA: plan.BeforeSHA, NewSHA: plan.AfterSHA,
		BytesChanged: plan.BytesChanged, Qualification: plan.Qualification, Capacity: plan.CapacityTargets, AppVersion: version,
		Backups: []prepareBackup{{Kind: "sibling", Path: sibling, SHA256: plan.BeforeSHA}, {Kind: "repo", Path: repo, SHA256: plan.BeforeSHA}},
	}
	if err = s.writePrepare(prepared); err != nil {
		return nil, err
	}
	shaAfter, err := fsx.ReplaceVerified(binary, plan.Output(), plan.BeforeSHA)
	if err != nil {
		return nil, s.finishFailedReplacement(binary, err)
	}
	path, err := apptarget.Resolved(binary)
	if err != nil {
		return nil, s.rollback(binary, data, shaAfter, err)
	}
	entry := map[string]any{"action": "patch", "at": time.Now().Format(time.RFC3339), "binary_path": path, "binary_sha256_before": plan.BeforeSHA, "binary_sha256_after": shaAfter, "backup_sibling": sibling, "backup_sibling_sha256": plan.BeforeSHA, "repo_backup": repo, "repo_backup_sha256": plan.BeforeSHA, "target_id": plan.TargetID, "input": plan.Input, "recipe_fingerprint": plan.Fingerprint, "qualification": plan.Qualification, "capacity_targets": plan.CapacityTargets, "bytes_changed": plan.BytesChanged, "app_version": nullable(version), "operation": operation}
	if err = s.append(entry); err != nil {
		return nil, s.rollback(binary, data, shaAfter, err)
	}
	if err = s.clearPrepare(binary); err != nil {
		entry["prepare_clear_warning"] = fmt.Sprintf("the patch was recorded but the prepare record could not be cleared: %v", err)
	}
	return entry, nil
}

func restore(binary string, reg Registry, s store, candidates []layout.Target) (result any, err error) {
	// The process check runs before the lock like limit's restore; the whole
	// mutation stays under the shared operation lock.
	running, probeErr := apptarget.AppRunning(binary, candidates)
	if err := apptarget.RequireStopped(running, probeErr); err != nil {
		return nil, err
	}
	op, opErr := s.beginOperation("tool-output restore", "")
	if opErr != nil {
		return nil, opErr
	}
	defer func() {
		if releaseErr := op.Release(); releaseErr != nil {
			err = errors.Join(err, releaseErr)
		}
	}()
	return restoreBinary(binary, reg, s, op.ID())
}

func restoreBinary(binary string, reg Registry, s store, operation string) (any, error) {
	current, err := os.ReadFile(binary)
	if err != nil {
		return nil, err
	}
	shaNow := fsx.SHA256(current)
	record, err := s.last(binary)
	if err != nil {
		return nil, err
	}
	if record == nil || stringField(record, "action") != "patch" {
		if _, refusal := Admit(current, reg); refusal == nil {
			return map[string]any{"binary": binary, "restored": false, "not_applied": true, "binary_sha256": shaNow, "detail": "the binary is a registered input; there is no tool-output patch to restore"}, nil
		}
		if isRecognizedOutput(current, reg) {
			return nil, errors.New("the binary matches a registered tool-output output but this tool holds no transaction record — refusing to guess a backup; inspect the installation manually")
		}
		return nil, errors.New("no tool-output patch record for this binary and the current bytes match no registered input — refusing")
	}
	if shaNow != stringField(record, "binary_sha256_after") {
		return nil, errors.New("installed binary changed since the last tool-output patch (app update, limit patch or external edit?) — refusing to overwrite a newer binary; remove another feature's patch with its own restore first")
	}
	targetID, input := stringField(record, "target_id"), stringField(record, "input")
	fingerprint := stringField(record, "recipe_fingerprint")
	if !recipeMatches(reg, targetID, input, fingerprint) {
		return nil, fmt.Errorf("the recorded recipe %s/%s (%s) is no longer registered — refusing to restore against a changed registry", targetID, input, fingerprint)
	}
	expected := stringField(record, "binary_sha256_before")
	source := ""
	for _, key := range []string{"backup_sibling", "repo_backup"} {
		path := stringField(record, key)
		if path == "" || stringField(record, key+"_sha256") != expected {
			continue
		}
		sha, hashErr := fsx.Hash(path)
		if hashErr == nil && sha == expected {
			source = path
			break
		}
	}
	if source == "" {
		return nil, fmt.Errorf("no verified backup matches the recorded input hash %s — refusing; recorded backups must never be deleted or overwritten", expected)
	}
	original, err := os.ReadFile(source)
	if err != nil {
		return nil, err
	}
	if fsx.SHA256(original) != expected {
		return nil, errors.New("backup does not match the recorded input SHA-256 — refusing before write")
	}
	sha, err := fsx.ReplaceVerified(binary, original, shaNow)
	if err != nil {
		return nil, err
	}
	path, err := apptarget.Resolved(binary)
	if err != nil {
		return nil, s.rollback(binary, current, sha, err)
	}
	entry := map[string]any{"action": "restore", "at": time.Now().Format(time.RFC3339), "binary_path": path, "binary_sha256": sha, "source": source, "target_id": targetID, "input": input, "recipe_fingerprint": fingerprint, "operation": operation, "app_version": record["app_version"], "qualification": record["qualification"], "capacity_targets": record["capacity_targets"]}
	if err = s.append(entry); err != nil {
		return nil, s.rollback(binary, current, sha, err)
	}
	if err = s.clearPrepare(binary); err != nil {
		entry["prepare_clear_warning"] = fmt.Sprintf("restored, but the prepare record could not be cleared: %v", err)
	}
	return map[string]any{"binary": binary, "restored": true, "binary_sha256": sha, "source": source, "record": entry}, nil
}

func recipeMatches(reg Registry, targetID, input, fingerprint string) bool {
	for ti := range reg.Targets {
		if reg.Targets[ti].ID != targetID {
			continue
		}
		for ii := range reg.Targets[ti].Inputs {
			if reg.Targets[ti].Inputs[ii].Input == input && reg.Targets[ti].Inputs[ii].Fingerprint() == fingerprint {
				return true
			}
		}
	}
	return false
}
