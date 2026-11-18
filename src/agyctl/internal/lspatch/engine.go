package lspatch

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"

	"agyctl/internal/fsx"
	"agyctl/internal/patchlock"
)

type inspection struct {
	state         State
	spec          Spec
	base, current []byte
	pending       *prepare
	legacy        bool
	managed       bool
}

func (e Engine) spec(sha string) (Spec, error) {
	for _, spec := range e.Specs {
		if spec.BaseSHA == sha {
			return spec, nil
		}
	}
	return Spec{}, refuse("unsupported", "no registered shared native base matches this target")
}

func (e Engine) validateState(binary string, state State) (Spec, []byte, []byte, error) {
	key, _, err := targetKey(binary)
	if err != nil {
		return Spec{}, nil, nil, err
	}
	if state.Schema != 1 || state.Target != key || !validSHA(state.CurrentSHA) || state.BasePath == "" || state.Recipes == nil {
		return Spec{}, nil, nil, errors.New("invalid native active state identity")
	}
	spec, err := e.spec(state.BaseSHA)
	if err != nil {
		return spec, nil, nil, err
	}
	if state.TargetID != spec.ID {
		return spec, nil, nil, errors.New("native target registration changed")
	}
	base, err := os.ReadFile(state.BasePath)
	if err != nil {
		return spec, nil, nil, err
	}
	previousLayout, err := recordedLayout(spec, state.Layout)
	if err != nil {
		return spec, nil, nil, err
	}
	out, err := Build(base, previousLayout, state.Features, state.Recipes)
	if err != nil {
		return spec, nil, nil, err
	}
	if fsx.SHA256(out) != state.CurrentSHA {
		return spec, nil, nil, errors.New("native active state cannot reproduce its complete recorded image")
	}
	return spec, base, out, nil
}

func (e Engine) inspect(binary string) (inspection, error) {
	var v inspection
	key, _, err := targetKey(binary)
	if err != nil {
		return v, err
	}
	current, err := os.ReadFile(binary)
	if err != nil {
		return v, err
	}
	v.current = current
	if e.SelectBinary != nil {
		if err := e.SelectBinary(binary); err != nil {
			return v, err
		}
	}
	statePath, preparePath, err := statePaths(e.Directory, binary)
	if err != nil {
		return v, err
	}
	var pending prepare
	if found, err := readJSON(preparePath, &pending); err != nil {
		return v, err
	} else if found {
		v.pending = &pending
		return v, nil
	}
	if err := legacyPending(e.Directory, binary, ""); err != nil {
		return v, err
	}
	var state State
	found, err := readJSON(statePath, &state)
	if err != nil {
		return v, err
	}
	if found {
		spec, base, out, err := e.validateState(binary, state)
		if err != nil {
			return v, err
		}
		if !bytes.Equal(current, out) {
			return v, refuse("drift", "current native file differs from its complete reconstructed active image")
		}
		v.state, v.spec, v.base = state, spec, base
		v.managed = true
		return v, nil
	}
	sha := fsx.SHA256(current)
	if spec, err := e.spec(sha); err == nil {
		config := EmptyConfig()
		if _, err := Build(current, spec, config, map[string]RecipeRef{}); err != nil {
			return v, err
		}
		v.state = State{Schema: 1, Target: key, TargetID: spec.ID, BaseSHA: sha, BasePath: binary, Features: config, Recipes: map[string]RecipeRef{}, Layout: layoutRefs(spec), CurrentSHA: sha}
		v.spec, v.base = spec, current
		return v, nil
	}
	if e.Legacy != nil {
		records, err := LegacyRecords(e.Directory, binary)
		if err != nil {
			return v, err
		}
		for _, record := range records {
			if record["action"] != "patch" || record["binary_sha256_after"] != sha {
				continue
			}
			before, _ := record["binary_sha256_before"].(string)
			if _, err := e.spec(before); err != nil {
				continue
			}
			for _, field := range []string{"backup_sibling", "repo_backup"} {
				path, _ := record[field].(string)
				if path == "" {
					continue
				}
				base, err := os.ReadFile(path)
				if err != nil {
					return v, err
				}
				if fsx.SHA256(base) != before {
					return v, errors.New("legacy native backup checksum does not match the recorded original")
				}
				spec, err := e.spec(fsx.SHA256(base))
				if err != nil {
					continue
				}
				proof, err := e.Legacy(binary, current, base, spec)
				if err != nil {
					return v, err
				}
				if proof == nil {
					continue
				}
				if proof.BasePath == "" {
					return v, errors.New("legacy native proof has no verified base source")
				}
				baseSHA, err := fsx.Hash(proof.BasePath)
				if err != nil {
					return v, err
				}
				if baseSHA != spec.BaseSHA {
					return v, errors.New("legacy native proof base source changed")
				}
				proofLayout := proof.Layout
				if proofLayout == nil {
					proofLayout = layoutRefs(spec)
				}
				previousLayout, err := recordedLayout(spec, proofLayout)
				if err != nil {
					return v, err
				}
				out, err := Build(base, previousLayout, proof.Config, proof.Recipes)
				if err != nil {
					return v, err
				}
				if !bytes.Equal(current, out) {
					return v, errors.New("legacy native proof does not reproduce the complete current file")
				}
				v.state = State{Schema: 1, Target: key, TargetID: spec.ID, BaseSHA: spec.BaseSHA, BasePath: proof.BasePath, Features: proof.Config, Recipes: proof.Recipes, Layout: proofLayout, CurrentSHA: sha}
				v.spec, v.base, v.legacy = spec, base, true
				return v, nil
			}
		}
	}
	return v, refuse("unsupported", "current whole-file image is neither a registered native original nor a fully verified managed/legacy image")
}

func (e Engine) expected(state State) Expected {
	return Expected{state.BaseSHA, state.CurrentSHA, state.Generation, e.AssetsFingerprint}
}

func recipeUpdateRequired(spec Spec, state State) bool {
	return !reflect.DeepEqual(state.Recipes, recipeRefs(spec, state.Features)) || !reflect.DeepEqual(state.Layout, layoutRefs(spec))
}

func (e Engine) report(binary string, v inspection) map[string]any {
	fileState := "managed"
	if v.legacy {
		fileState = "legacy"
	} else if v.state.Generation == 0 {
		fileState = "original"
	}
	features := v.state.Features
	if features.Compaction && features.CompactionPrompt == nil && v.spec.BuildCompaction != nil && v.state.Recipes["compaction"] == v.spec.Compaction.Ref {
		features.CompactionPrompt = &CompactionPrompt{Mode: "native"}
	}
	result := map[string]any{"binary": binary, "target_id": v.spec.ID, "identity_gate": "whole-file-sha256", "verified": true, "file_state": fileState, "base_sha256": v.state.BaseSHA, "base_binary_path": v.state.BasePath, "current_sha256": v.state.CurrentSHA, "binary_sha256": v.state.CurrentSHA, "generation": v.state.Generation, "assets_fingerprint": e.AssetsFingerprint, "features": features, "recipes": v.state.Recipes, "layout_recipes": v.state.Layout, "disk_patch_equals_loaded": false,
		"recipe_update_required": recipeUpdateRequired(v.spec, v.state),
		"available":              map[string]bool{"limit": v.spec.Limit != nil, "tool_output": v.spec.ToolOutput != nil, "compaction": v.spec.Compaction != nil}}
	if v.spec.BuildCompaction != nil {
		result["compaction_prompt_max_bytes"] = v.spec.CompactionPromptMaxBytes
		result["compaction_retention_budget_bytes"] = CompactionRetentionBudgetBytes
	}
	return result
}

func (e Engine) Status(binary string) (map[string]any, error) {
	v, err := e.inspect(binary)
	if err != nil {
		var refusal *Refusal
		if !errors.As(err, &refusal) {
			return nil, err
		}
		kind := refusal.Kind
		return map[string]any{"binary": binary, "verified": false, "file_state": kind, "features": nil, "current_sha256": fsx.SHA256(v.current), "binary_sha256": fsx.SHA256(v.current), "base_sha256": nil, "base_binary_path": nil, "generation": nil, "assets_fingerprint": e.AssetsFingerprint, "detail": err.Error()}, nil
	}
	if v.pending != nil {
		return map[string]any{"binary": binary, "verified": false, "file_state": "pending", "features": nil, "current_sha256": fsx.SHA256(v.current), "binary_sha256": fsx.SHA256(v.current), "base_sha256": v.pending.Before.BaseSHA, "base_binary_path": v.pending.Before.BasePath, "generation": v.pending.Before.Generation, "assets_fingerprint": e.AssetsFingerprint, "prepare_record": v.pending}, nil
	}
	return e.report(binary, v), nil
}

type Plan struct {
	Expected     Expected `json:"expected"`
	Desired      Config   `json:"desired"`
	AfterSHA     string   `json:"after_sha256"`
	BytesChanged int      `json:"bytes_changed"`
	output       []byte
	Proof        map[string]any `json:"-"`
}

func (e Engine) plan(v inspection, desired Desired) (Plan, error) {
	if v.pending != nil {
		return Plan{}, errors.New("pending: resolve the prepared native transaction before planning another operation")
	}
	config, err := desired.Merge(v.state.Features)
	if err != nil {
		return Plan{}, err
	}
	output, err := Build(v.base, v.spec, config, recipeRefs(v.spec, config))
	if err != nil {
		return Plan{}, err
	}
	changed := 0
	for i := range output {
		if output[i] != v.current[i] {
			changed++
		}
	}
	return Plan{Expected: e.expected(v.state), Desired: config, AfterSHA: fsx.SHA256(output), BytesChanged: changed, output: output}, nil
}

func (e Engine) Plan(binary string, desired Desired) (Plan, error) {
	v, err := e.inspect(binary)
	if err != nil {
		return Plan{}, err
	}
	plan, err := e.plan(v, desired)
	if err != nil {
		return Plan{}, err
	}
	plan.Proof = e.report(binary, v)
	return plan, nil
}

func (e Engine) backupPath(binary, sha string) (string, error) {
	_, id, err := targetKey(binary)
	if err != nil {
		return "", err
	}
	return filepath.Join(e.Directory, "native-"+id+"-"+sha+filepath.Ext(binary)), nil
}

func (e Engine) stopped(binary string) error {
	if e.RequireStopped == nil {
		return errors.New("native process inspection is unavailable; refusing mutation")
	}
	return e.RequireStopped(binary)
}

// Apply holds the common operation lock through proof, backups, prepare,
// replacement and the active-state commit. Recovery accepts only the two exact
// prepared images and the same owner, desired state and reviewed expectation.
func (e Engine) Apply(binary string, desired Desired, expected Expected, owner string) (result map[string]any, err error) {
	if !validSHA(expected.BaseSHA) || !validSHA(expected.CurrentSHA) || !validSHA(expected.AssetsFingerprint) {
		return nil, errors.New("invalid native expected proof")
	}
	op, err := patchlock.BeginOperation(e.Directory, "native "+owner, "")
	if err != nil {
		return nil, err
	}
	defer func() { err = errors.Join(err, op.Release()) }()
	if err := legacyPending(e.Directory, binary, ""); err != nil {
		return nil, err
	}
	v, err := e.inspect(binary)
	if err != nil {
		return nil, err
	}
	if v.pending != nil {
		return e.recover(binary, desired, expected, owner, v)
	}
	if expected != e.expected(v.state) {
		return nil, errors.New("stale-plan: native base/current hash, generation or runtime assets changed")
	}
	plan, err := e.plan(v, desired)
	if err != nil {
		return nil, err
	}
	if v.managed && !v.legacy && plan.BytesChanged == 0 && reflect.DeepEqual(plan.Desired, v.state.Features) && !recipeUpdateRequired(v.spec, v.state) {
		result := e.report(binary, v)
		result["applied"], result["bytes_changed"] = false, 0
		result["binary_sha256_before"], result["binary_sha256_after"] = v.state.CurrentSHA, v.state.CurrentSHA
		return result, nil
	}
	if err := e.stopped(binary); err != nil {
		return nil, err
	}
	statePath, preparePath, err := statePaths(e.Directory, binary)
	if err != nil {
		return nil, err
	}
	basePath, err := e.backupPath(binary, v.state.BaseSHA)
	if err != nil {
		return nil, err
	}
	if err := fsx.EnsureBackup(v.state.BasePath, basePath, v.state.BaseSHA); err != nil {
		return nil, err
	}
	startPath, err := e.backupPath(binary, v.state.CurrentSHA)
	if err != nil {
		return nil, err
	}
	if err := fsx.EnsureBackup(binary, startPath, v.state.CurrentSHA); err != nil {
		return nil, err
	}
	before := v.state
	before.BasePath = basePath
	after := before
	after.Features = plan.Desired
	after.Recipes = recipeRefs(v.spec, plan.Desired)
	after.Layout = layoutRefs(v.spec)
	after.CurrentSHA = plan.AfterSHA
	if after.Generation == ^uint64(0) {
		return nil, errors.New("native generation exhausted")
	}
	after.Generation++
	pending := prepare{Schema: 1, Operation: op.ID(), Owner: owner, Before: before, After: after, Expected: expected, StartBackup: startPath}
	if err := writeJSON(e.Directory, preparePath, pending); err != nil {
		return nil, err
	}
	if plan.AfterSHA != before.CurrentSHA {
		if _, err := fsx.ReplaceVerified(binary, plan.output, before.CurrentSHA); err != nil {
			return nil, err
		}
	}
	if err := writeJSON(e.Directory, statePath, after); err != nil {
		return nil, err
	}
	if err := os.Remove(preparePath); err != nil {
		return nil, fmt.Errorf("native image and active state committed but prepare cleanup failed: %w", err)
	}
	v.state, v.current, v.legacy = after, plan.output, false
	result = e.report(binary, v)
	result["applied"] = plan.BytesChanged != 0 || recipeUpdateRequired(v.spec, before)
	result["bytes_changed"] = plan.BytesChanged
	result["binary_sha256_before"], result["binary_sha256_after"] = before.CurrentSHA, after.CurrentSHA
	return result, nil
}

func (e Engine) recover(binary string, desired Desired, expected Expected, owner string, v inspection) (map[string]any, error) {
	p := v.pending
	if p.Schema != 1 || p.Operation == "" || p.Owner != owner || p.Expected != expected || expected.AssetsFingerprint != e.AssetsFingerprint || p.Before.Generation == ^uint64(0) || p.After.Generation != p.Before.Generation+1 || p.Before.BaseSHA != p.After.BaseSHA || p.Before.BasePath != p.After.BasePath || p.Before.TargetID != p.After.TargetID {
		return nil, errors.New("pending: native transaction identity, owner or reviewed expectation does not match; refusing recovery")
	}
	if e.expected(p.Before) != expected {
		return nil, errors.New("pending: prepared before-state proof is inconsistent")
	}
	config, err := desired.Merge(p.Before.Features)
	if err != nil {
		return nil, err
	}
	if !reflect.DeepEqual(config, p.After.Features) {
		return nil, errors.New("pending: a different desired native state cannot bypass an unfinished transaction")
	}
	registered, err := e.spec(p.After.BaseSHA)
	if err != nil {
		return nil, err
	}
	if !reflect.DeepEqual(p.After.Recipes, recipeRefs(registered, p.After.Features)) {
		return nil, errors.New("pending: after-state recipes are not the canonical desired native layout")
	}
	if !reflect.DeepEqual(p.After.Layout, layoutRefs(registered)) {
		return nil, errors.New("pending: prepared after-state does not use the registered fixed native layout")
	}
	_, _, before, err := e.validateState(binary, p.Before)
	if err != nil {
		return nil, err
	}
	spec, base, after, err := e.validateState(binary, p.After)
	if err != nil {
		return nil, err
	}
	startPath, err := e.backupPath(binary, p.Before.CurrentSHA)
	if err != nil {
		return nil, err
	}
	if startPath != p.StartBackup {
		return nil, errors.New("pending: operation-start backup path does not belong to this native transaction")
	}
	backup, err := os.ReadFile(startPath)
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(backup, before) {
		return nil, errors.New("pending: operation-start backup does not reproduce the complete before image")
	}
	if !bytes.Equal(v.current, before) && !bytes.Equal(v.current, after) {
		return nil, errors.New("drift: current native file matches neither prepared before nor after image")
	}
	statePath, preparePath, err := statePaths(e.Directory, binary)
	if err != nil {
		return nil, err
	}
	var recorded State
	found, err := readJSON(statePath, &recorded)
	if err != nil {
		return nil, err
	}
	if found && !reflect.DeepEqual(recorded, p.Before) && !reflect.DeepEqual(recorded, p.After) {
		return nil, errors.New("pending: active native state changed outside the prepared transaction")
	}
	if !found && p.Before.Generation != 0 {
		return nil, errors.New("pending: established native active state is missing")
	}
	if err := e.stopped(binary); err != nil {
		return nil, err
	}
	wrote := !bytes.Equal(v.current, after)
	if wrote {
		if _, err := fsx.ReplaceVerified(binary, after, p.Before.CurrentSHA); err != nil {
			return nil, err
		}
	}
	if err := writeJSON(e.Directory, statePath, p.After); err != nil {
		return nil, err
	}
	if err := os.Remove(preparePath); err != nil {
		return nil, err
	}
	v.state, v.spec, v.base, v.current, v.pending = p.After, spec, base, after, nil
	result := e.report(binary, v)
	result["applied"], result["prepare_record_completed"] = wrote || recipeUpdateRequired(spec, p.Before), true
	result["binary_sha256_before"], result["binary_sha256_after"] = p.Before.CurrentSHA, p.After.CurrentSHA
	return result, nil
}

func (e Engine) Handle(request Request) (map[string]any, bool, error) {
	if request.Command == "status" {
		result, err := e.Status(request.Binary)
		return result, true, err
	}
	if request.Apply || request.Command == "restore" {
		resume, err := StandaloneRecoveryAllowed(e.Directory, request.Binary, request.Feature)
		if err != nil {
			return nil, true, err
		}
		if resume {
			return nil, false, nil
		}
	}
	v, err := e.inspect(request.Binary)
	if err != nil {
		return nil, true, err
	}
	desired := request.Desired
	current := v.state.Features
	if v.pending != nil {
		current = v.pending.Before.Features
	}
	if request.UseCurrentLimit && current.Limit.Enabled {
		desired.Limit = &current.Limit
	}
	if request.Command == "restore" {
		disabled := false
		switch request.Feature {
		case "limit":
			value := EmptyConfig().Limit
			desired.Limit = &value
		case "tool-output":
			desired.ToolOutput = &disabled
		case "compaction":
			desired.Compaction = &disabled
		}
	}
	if !request.Apply && request.Command != "restore" {
		plan, err := e.plan(v, desired)
		if err != nil {
			return nil, true, err
		}
		result := map[string]any{"binary": request.Binary, "dry_run": true, "applied": false, "expected": plan.Expected, "desired": plan.Desired, "bytes_changed": plan.BytesChanged, "binary_sha256_before": plan.Expected.CurrentSHA, "binary_sha256_after": plan.AfterSHA}
		if request.Out != "" {
			f, err := os.OpenFile(request.Out, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
			if err != nil {
				return nil, true, err
			}
			_, writeErr := f.Write(plan.output)
			if err := errors.Join(writeErr, f.Close()); err != nil {
				return nil, true, err
			}
			result["out"] = request.Out
		}
		return result, true, nil
	}
	expected := e.expected(v.state)
	if v.pending != nil {
		expected = v.pending.Expected
	}
	result, err := e.Apply(request.Binary, desired, expected, request.Feature)
	if result != nil && request.Command == "restore" {
		result["restored"] = result["applied"]
	}
	return result, true, err
}
