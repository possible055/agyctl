package limit

import (
	"bytes"
	"encoding/hex"
	"errors"

	"agyctl/internal/assets"
	"agyctl/internal/fsx"
	"agyctl/internal/layout"
	"agyctl/internal/lspatch"
)

func NativeReference(root string, snapshot *assets.Snapshot) (lspatch.RecipeRef, error) {
	_, err := Originals(root, snapshot)
	if err != nil {
		return lspatch.RecipeRef{}, err
	}
	body, err := AssembleModelLimits(0, 20)
	if err != nil {
		return lspatch.RecipeRef{}, err
	}
	return lspatch.RecipeRef{ID: "linked-v2-reserved-v1", Fingerprint: lspatch.Fingerprint(Func, modelEncoding, "guarded-int3-reserved-v1", hex.EncodeToString(body))}, nil
}

// NativeReferenceForBase selects the planner from the exact registered original,
// while the legacy reference remains reproducible across registry additions.
func NativeReferenceForBase(root string, snapshot *assets.Snapshot, baseSHA string) (lspatch.RecipeRef, error) {
	reg, err := loadRegistry(root, snapshot)
	if err != nil {
		return lspatch.RecipeRef{}, err
	}
	for i, entry := range reg.Entries {
		if stringField(entry, "binary_sha256") != baseSHA {
			continue
		}
		if len(reg.originals[i]) == summaryFuncSize {
			body, err := assembleSummaryLimitsForOriginal(reg.originals[i], 0, 0x34)
			if err != nil {
				return lspatch.RecipeRef{}, err
			}
			return lspatch.RecipeRef{ID: "linked-v3-summary-reserved-v1", Fingerprint: lspatch.Fingerprint(Func, summaryEncoding, fsx.SHA256(reg.originals[i]), "guarded-int3-reserved-v1", hex.EncodeToString(body))}, nil
		}
		return NativeReference(root, snapshot)
	}
	return lspatch.RecipeRef{}, errors.New("native limit original is not registered")
}

func legacyNativeRef(canonical lspatch.RecipeRef, encoding string) lspatch.RecipeRef {
	id := "legacy-bitset-v1"
	if encoding == modelEncoding {
		id = "legacy-linked-v2"
	}
	return lspatch.RecipeRef{ID: id, Fingerprint: lspatch.Fingerprint(id, canonical.ID, canonical.Fingerprint)}
}

func NativeLegacyReferences(canonical lspatch.RecipeRef) []lspatch.RecipeRef {
	if canonical.ID != "linked-v2-reserved-v1" {
		return nil
	}
	return []lspatch.RecipeRef{legacyNativeRef(canonical, ""), legacyNativeRef(canonical, modelEncoding)}
}

func NativeContribution(root string, snapshot *assets.Snapshot, base []byte, config lspatch.LimitConfig, reserved []lspatch.Span, ref lspatch.RecipeRef) (lspatch.Contribution, error) {
	originals, err := Originals(root, snapshot)
	if err != nil {
		return lspatch.Contribution{}, err
	}
	state, err := DetectState(base, originals)
	if err != nil {
		return lspatch.Contribution{}, err
	}
	if state.Kind != "original" {
		return lspatch.Contribution{}, errors.New("native limit base function matches no recorded original byte signature")
	}
	canonical, err := NativeReference(root, snapshot)
	im, parseErr := parseImage(base)
	if parseErr != nil {
		return lspatch.Contribution{}, parseErr
	}
	if im.entries[im.index+1]-im.entries[im.index] == summaryFuncSize {
		canonical, err = NativeReferenceForBase(root, snapshot, fsx.SHA256(base))
	}
	if err != nil {
		return lspatch.Contribution{}, err
	}
	var plan Plan
	switch ref {
	case canonical:
		plan, err = PlanModelPatchReserved(base, config.ModelLimits, reserved)
	case legacyNativeRef(canonical, modelEncoding):
		plan, err = PlanModelPatch(base, config.ModelLimits)
	case legacyNativeRef(canonical, ""):
		ids := make([]int, len(config.ModelLimits))
		target := config.ModelLimits[0].Limit
		for i, value := range config.ModelLimits {
			ids[i] = value.ID
			if value.Limit != target {
				return lspatch.Contribution{}, errors.New("legacy native limit mapping is not uniform")
			}
		}
		plan, err = PlanPatch(base, ids, target)
	default:
		return lspatch.Contribution{}, errors.New("native limit planner identity or fingerprint changed")
	}
	if err != nil {
		return lspatch.Contribution{}, err
	}
	spans := []lspatch.Span{{Offset: plan.FuncOff, Expected: bytes.Clone(base[plan.FuncOff : plan.FuncOff+len(plan.Body)]), Replacement: plan.Body}}
	if len(plan.Nodes) > 0 {
		for _, node := range plan.Nodes {
			spans = append(spans, lspatch.Span{Offset: node.Offset - 8, Expected: bytes.Clone(base[node.Offset-8 : node.Offset]), Replacement: bytes.Clone(base[node.Offset-8 : node.Offset])}, lspatch.Span{Offset: node.Offset, Expected: bytes.Clone(base[node.Offset : node.Offset+len(node.Data)]), Replacement: node.Data})
		}
	} else {
		spans = append(spans, lspatch.Span{Offset: plan.TableOff - 8, Expected: bytes.Clone(base[plan.TableOff-8 : plan.TableOff]), Replacement: bytes.Clone(base[plan.TableOff-8 : plan.TableOff])}, lspatch.Span{Offset: plan.TableOff, Expected: bytes.Clone(base[plan.TableOff : plan.TableOff+len(plan.Table)]), Replacement: plan.Table})
	}
	return lspatch.Contribution{Ref: ref, Spans: spans}, nil
}

func NativeLegacy(root string, snapshot *assets.Snapshot, directory, binary string, current, base []byte, spec lspatch.Spec) (*lspatch.Legacy, error) {
	s := store{directory: directory}
	record, err := s.last(binary)
	if err != nil {
		return nil, err
	}
	if record == nil || stringField(record, "action") != "patch" || stringField(record, "binary_sha256_after") != fsx.SHA256(current) {
		return nil, nil
	}
	if stringField(record, "binary_sha256_before") != spec.BaseSHA {
		return nil, nil
	}
	basePath, err := lspatch.VerifyLegacyBackups(binary, record, spec.BaseSHA, fsx.SHA256(current))
	if err != nil {
		return nil, err
	}
	settings, err := settingsFromRecord(record)
	if err != nil {
		return nil, err
	}
	plan, err := planSettings(base, settings)
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(ApplyPatch(base, plan), current) {
		return nil, errors.New("legacy limit record and backups do not reproduce the complete current file")
	}
	ref, err := NativeReference(root, snapshot)
	if err != nil {
		return nil, err
	}
	ref = legacyNativeRef(ref, settings.Encoding)
	config := lspatch.EmptyConfig()
	config.Limit = lspatch.LimitConfig{Enabled: true, ModelLimits: settings.ModelLimits}
	return &lspatch.Legacy{Config: config, Recipes: map[string]lspatch.RecipeRef{"limit": ref}, BasePath: basePath}, nil
}

func decorateNativeStatus(binary string, result map[string]any, reg registry, s store, candidates []layout.Target) error {
	state := PatchState{Kind: "unknown"}
	if config, ok := result["features"].(lspatch.Config); ok && result["verified"] == true {
		state.Kind = "original"
		if config.Limit.Enabled {
			state.Kind = "patched"
			state.ModelLimits = config.Limit.ModelLimits
			state.Encoding = modelEncoding
			if refs, ok := result["recipes"].(map[string]lspatch.RecipeRef); ok && refs["limit"].ID == "linked-v3-summary-reserved-v1" {
				state.Encoding = summaryEncoding
			}
		}
	}
	result["patch_state"] = map[string]any{"kind": state.Kind, "ids": state.IDs, "limit": state.Limit, "model_limits": state.ModelLimits, "encoding": state.Encoding}
	result["model_limits"] = state.ModelLimits
	running, probeErr := appRunning(binary, candidates)
	result["language_server_running"] = running
	version, source, versionErr := readVersion(binary)
	result["app_version"], result["version_source"], result["channel"] = nullable(version), source, channelOf(binary)
	sha, _ := result["current_sha256"].(string)
	compat, entry := reg.classify(version, channelOf(binary), sha)
	result["compat"] = compatResult(compat, entry)
	record, err := s.last(binary)
	if err != nil {
		return err
	}
	saved, settingsState, settingsErr := savedSettingsReport(record, state)
	if state.Kind == "patched" {
		saved = patchSettings{Encoding: state.Encoding, ModelLimits: state.ModelLimits}
		settingsState = "applied"
	}
	result["saved_settings"], result["settings_state"] = saved, settingsState
	if settings, ok := saved.(patchSettings); ok {
		result["saved_model_limits"] = settings.ModelLimits
	} else {
		result["saved_model_limits"] = nil
	}
	basePath, _ := result["base_binary_path"].(string)
	baseSHA, _ := result["base_sha256"].(string)
	backup, err := backupReport(basePath, baseSHA)
	if err != nil {
		return err
	}
	result["repo_backup"] = backup
	result["sibling_backup"] = map[string]any{"path": nil, "exists": false, "verified": false}
	addWarnings(result, probeErr, versionErr, settingsErr)
	return nil
}
