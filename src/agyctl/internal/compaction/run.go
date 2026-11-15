package compaction

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
	o := options{command: "status"}
	if len(args) > 0 {
		switch args[0] {
		case "status", "patch", "restore":
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
	if o.binary == "" && !o.help {
		return o, fmt.Errorf("%s requires --binary PATH; compaction never guesses between multiple installations", o.command)
	}
	return o, nil
}

// Run returns exactly one JSON-serializable result and never writes to stdout.
// The registry is parsed from the snapshot captured while the runtime assets
// were verified; a nil snapshot (only for direct library use in tests) falls
// back to reading compat/compaction.json under root.
func Run(root string, snap *assets.Snapshot, args []string) (any, int, error) {
	o, err := parseOptions(args)
	if err != nil {
		return failure(o.command, err)
	}
	if o.help {
		return map[string]any{
			"command":     o.command,
			"commands":    []string{"status", "patch", "restore"},
			"patch_flags": []string{"--binary", "--apply", "--json"},
			"notes":       []string{"patch without --apply plans in memory only and never writes", "restore rewrites the binary back to the recorded operation input", "the effective status is unknown without live evidence; disk state never proves the loaded configuration"},
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
	if err != nil {
		return failure(o.command, err)
	}
	binary, resolveErr := resolveBinary(candidates, o.binary)
	if resolveErr != nil {
		return failure(o.command, resolveErr)
	}
	switch o.command {
	case "status":
		return status(binary, reg, s, candidates)
	case "patch":
		var result any
		result, err = patch(binary, o, reg, s, candidates)
		if err != nil {
			return failedResult(o.command, result, err)
		}
		return result, 0, nil
	case "restore":
		var result any
		result, err = restore(binary, reg, s, candidates)
		if err != nil {
			return failedResult(o.command, result, err)
		}
		return result, 0, nil
	default:
		return failure(o.command, fmt.Errorf("unknown compaction command %s", o.command))
	}
}

// resolveBinary requires an explicit --binary; compaction never guesses
// between the stable and development channels.
func resolveBinary(candidates []layout.Target, override string) (string, error) {
	if override == "" {
		return "", errNoInstall
	}
	stat, err := os.Stat(override)
	if err != nil {
		return "", err
	}
	if !stat.Mode().IsRegular() {
		return "", fmt.Errorf("language server is not a regular file: %s", override)
	}
	return override, nil
}

func failure(command string, err error) (any, int, error) {
	return failedResult(command, nil, err)
}

type operationRefusal struct {
	kind string
	err  error
}

func (r *operationRefusal) Error() string { return r.err.Error() }
func (r *operationRefusal) Unwrap() error { return r.err }

func failedResult(command string, result any, err error) (any, int, error) {
	m, ok := result.(map[string]any)
	if !ok || m == nil {
		m = map[string]any{}
	}
	m["command"], m["error"], m["code"] = command, err.Error(), 1
	if m["refusal"] == nil {
		kind := "operation-failed"
		var refusal *operationRefusal
		if errors.As(err, &refusal) {
			kind = refusal.kind
		}
		m["refusal"] = &Refusal{Kind: kind, Detail: err.Error()}
	}
	return m, 1, err
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

func qualificationLevels(target *Target) map[string]any {
	live := "unverified"
	if target.Qualification == "supported" {
		live = "verified"
	}
	return map[string]any{
		"static":   "verified " + target.VerifiedAt + " (registered whole-file SHA-256 and byte segments)",
		"offline":  "verified (the registry recipe reproduces the registered output hash)",
		"live_app": live + " (live qualification is pending; see docs/compaction-patch.md; qualification is " + target.Qualification + ")",
	}
}

func targetSummary(target *Target) map[string]any {
	return map[string]any{"target_id": target.ID, "product": target.Product, "channel": target.Channel, "platform": target.Platform, "arch": target.Arch, "binary_name": target.BinaryName, "binary_size": target.BinarySize, "member": target.Member, "qualification": target.Qualification, "verified_at": target.VerifiedAt, "value_targets": target.ValueTargets, "out_of_scope": target.OutOfScope, "notes": target.Notes, "evidence": target.Evidence}
}

// fileState classifies the installed binary for status output. A disk patch
// does not mean the running app loaded it or that the model received the new
// prompt or retention values; the effective state is unknown without live
// evidence.
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
			return "limit-patched", map[string]any{"detail": "the binary matches limit's last patch output; compaction refuses to patch over or restore across it"}, nil
		}
		toolOutputSHA, err := s.ToolOutputPatchOutput(binary, sha)
		if err != nil {
			return "", nil, err
		}
		if toolOutputSHA != "" {
			return "tool-output-patched", map[string]any{"detail": "the binary matches tool-output's last patch output but no registered compaction input; register or verify this exact input before patching"}, nil
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
	result := map[string]any{"binary": binary, "channel": apptarget.ChannelOf(binary), "app_version": nullable(version), "version_source": source, "binary_sha256": sha, "file_state": state, "state_detail": detail, "effective_state": "unknown", "disk_patch_equals_loaded": false}
	addWarnings(result, versionErr)
	record, err := s.last(binary)
	if err != nil {
		return failure("status", err)
	}
	result["sibling_backup"] = backupReport(record, "backup_sibling")
	result["repo_backup"] = backupReport(record, "repo_backup")
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
		result["prepare_record"] = map[string]any{"action": prepared.action(), "operation": prepared.Operation, "created_at": prepared.CreatedAt, "target_id": prepared.TargetID, "input": prepared.Input, "recipe_fingerprint": prepared.Fingerprint, "binary_sha256_before": prepared.OriginalSHA, "binary_sha256_after": prepared.NewSHA, "bytes_changed": prepared.BytesChanged, "backups": backups}
	}
	return result, 0, nil
}

func backupReport(record map[string]any, field string) map[string]any {
	path := ""
	if stringField(record, "action") == "patch" {
		path = stringField(record, field)
	}
	result := map[string]any{"path": nullable(path), "exists": false, "verified": false}
	if path == "" {
		return result
	}
	stat, err := os.Stat(path)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			result["error"] = err.Error()
		}
		return result
	}
	if !stat.Mode().IsRegular() {
		result["error"] = "backup is not a regular file"
		return result
	}
	result["exists"] = true
	sha, err := fsx.Hash(path)
	if err != nil {
		result["error"] = err.Error()
		return result
	}
	expected := stringField(record, "binary_sha256_before")
	result["sha256"] = sha
	result["verified"] = isSHA256(expected) && sha == expected && stringField(record, field+"_sha256") == expected
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
			return zero, nil, &Refusal{Kind: RefusalPatchConflict, Detail: "the binary matches limit's last patch output and is not a registered compaction input — refusing to patch over another feature's patch; remove it with 'agyctl limit restore' first"}, nil
		}
	}
	return zero, nil, refusal, nil
}

func patch(binary string, o options, reg Registry, s store, candidates []layout.Target) (result map[string]any, err error) {
	if !o.apply {
		return patchBinary(binary, o, reg, s, candidates, "")
	}
	op, err := s.beginOperation("compaction patch", "")
	if err != nil {
		return nil, err
	}
	defer func() {
		if releaseErr := op.Release(); releaseErr != nil {
			err = errors.Join(err, releaseErr)
		}
	}()
	recovered, err := recoverPrepared(binary, reg, s, "patch", candidates)
	if err != nil || recovered != nil {
		return recovered, err
	}
	return patchBinary(binary, o, reg, s, candidates, op.ID())
}

func patchBinary(binary string, o options, reg Registry, s store, candidates []layout.Target, operation string) (map[string]any, error) {
	data, err := os.ReadFile(binary)
	if err != nil {
		return nil, err
	}
	sha := fsx.SHA256(data)
	result := map[string]any{"binary": binary, "dry_run": !o.apply, "applied": false, "binary_sha256_before": sha, "disk_patch_equals_loaded": false}
	version, _, versionErr := apptarget.ReadVersion(binary)
	plan, admission, refusal, err := planFor(binary, data, reg, s)
	if err != nil {
		return result, err
	}
	if refusal != nil {
		result["refusal"] = refusal
		if refusal.Kind == refusalKindAlreadyApplied {
			result["already_applied"] = true
			result["binary_sha256_after"] = sha
			prepared, err := s.loadPrepare(binary)
			if err != nil {
				return result, err
			}
			if prepared != nil {
				result["prepare_record_pending"] = true
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
	result["value_targets"] = plan.ValueTargets
	result["bytes_changed"] = plan.BytesChanged
	result["binary_sha256_after"] = plan.AfterSHA
	result["verification"] = qualificationLevels(admission.Target)
	if !o.apply {
		return result, nil
	}
	if err = requireStopped(binary, candidates); err != nil {
		return result, err
	}
	record, err := applyPlan(binary, data, plan, version, s, operation)
	if err != nil {
		return result, err
	}
	if warning := stringField(record, "prepare_clear_warning"); warning != "" {
		delete(record, "prepare_clear_warning")
		addWarnings(result, errors.New(warning))
	}
	result["applied"] = true
	result["record"] = record
	return result, nil
}

func requireStopped(binary string, candidates []layout.Target) error {
	running, probeErr := apptarget.AppRunning(binary, candidates)
	return apptarget.RequireStopped(running, probeErr)
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
		Action: "patch", Operation: operation, Target: targetKey, TargetID: plan.TargetID, Input: plan.Input,
		Fingerprint: plan.Fingerprint, OriginalSHA: plan.BeforeSHA, NewSHA: plan.AfterSHA,
		BytesChanged: plan.BytesChanged, Qualification: plan.Qualification, Values: plan.ValueTargets, AppVersion: version,
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
	entry := map[string]any{"action": "patch", "at": time.Now().Format(time.RFC3339), "binary_path": path, "binary_sha256_before": plan.BeforeSHA, "binary_sha256_after": shaAfter, "backup_sibling": sibling, "backup_sibling_sha256": plan.BeforeSHA, "repo_backup": repo, "repo_backup_sha256": plan.BeforeSHA, "target_id": plan.TargetID, "input": plan.Input, "recipe_fingerprint": plan.Fingerprint, "qualification": plan.Qualification, "value_targets": plan.ValueTargets, "bytes_changed": plan.BytesChanged, "app_version": nullable(version), "operation": operation}
	if err = s.append(entry); err != nil {
		return nil, s.rollback(binary, data, shaAfter, err)
	}
	if err = s.clearPrepare(binary); err != nil {
		entry["prepare_clear_warning"] = fmt.Sprintf("the patch was recorded but the prepare record could not be cleared: %v", err)
	}
	return entry, nil
}

func restore(binary string, reg Registry, s store, candidates []layout.Target) (result any, err error) {
	op, opErr := s.beginOperation("compaction restore", "")
	if opErr != nil {
		return nil, opErr
	}
	defer func() {
		if releaseErr := op.Release(); releaseErr != nil {
			err = errors.Join(err, releaseErr)
		}
	}()
	recovered, err := recoverPrepared(binary, reg, s, "restore", candidates)
	if err != nil || recovered != nil {
		return recovered, err
	}
	return restoreBinary(binary, reg, s, op.ID(), candidates)
}

func restoreBinary(binary string, reg Registry, s store, operation string, candidates []layout.Target) (any, error) {
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
			return map[string]any{"binary": binary, "restored": false, "not_applied": true, "binary_sha256": shaNow, "detail": "the binary is a registered input; there is no compaction patch to restore"}, nil
		}
		if isRecognizedOutput(current, reg) {
			return nil, errors.New("the binary matches a registered compaction output but this tool holds no transaction record — refusing to guess a backup; inspect the installation manually")
		}
		return nil, errors.New("no compaction patch record for this binary and the current bytes match no registered input — refusing")
	}
	if shaNow != stringField(record, "binary_sha256_after") {
		return nil, errors.New("installed binary changed since the last compaction patch (app update, limit patch or external edit?) — refusing to overwrite a newer binary; remove another feature's patch with its own restore first")
	}
	targetID, input := stringField(record, "target_id"), stringField(record, "input")
	fingerprint := stringField(record, "recipe_fingerprint")
	if !recipeMatches(reg, targetID, input, fingerprint) {
		return nil, fmt.Errorf("the recorded recipe %s/%s (%s) is no longer registered — refusing to restore against a changed registry", targetID, input, fingerprint)
	}
	expected := stringField(record, "binary_sha256_before")
	backups := []prepareBackup{}
	for _, item := range []struct{ field, kind string }{{"backup_sibling", "sibling"}, {"repo_backup", "repo"}} {
		path := stringField(record, item.field)
		if path == "" || stringField(record, item.field+"_sha256") != expected {
			continue
		}
		sha, hashErr := fsx.Hash(path)
		if hashErr == nil && sha == expected {
			backups = append(backups, prepareBackup{Kind: item.kind, Path: path, SHA256: expected})
		}
	}
	if len(backups) == 0 {
		return nil, fmt.Errorf("no verified backup matches the recorded input hash %s — refusing; recorded backups must never be deleted or overwritten", expected)
	}
	target, err := apptarget.Normalized(binary)
	if err != nil {
		return nil, err
	}
	changed, err := recordedByteCount(record)
	if err != nil {
		return nil, err
	}
	prepared := &prepareRecord{
		Action: "restore", Operation: operation, Target: target, TargetID: targetID, Input: input,
		Fingerprint: fingerprint, OriginalSHA: expected, NewSHA: shaNow,
		BytesChanged: changed, AppVersion: stringField(record, "app_version"), Backups: backups,
	}
	validated, err := validatePrepared(binary, current, prepared, reg, s)
	if err != nil {
		return nil, &operationRefusal{kind: "restore-invalid", err: err}
	}
	if err = requireStopped(binary, candidates); err != nil {
		return nil, err
	}
	if err = s.writePrepare(*prepared); err != nil {
		return nil, err
	}
	return finishRestore(binary, current, validated, s, candidates)
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
