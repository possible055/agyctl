package lspatch

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"agyctl/internal/apptarget"
	"agyctl/internal/fsx"
	"agyctl/internal/patchlock"
)

type State struct {
	Schema     int                  `json:"schema"`
	Target     string               `json:"target"`
	TargetID   string               `json:"target_id"`
	BaseSHA    string               `json:"base_sha256"`
	BasePath   string               `json:"base_binary_path"`
	Features   Config               `json:"features"`
	Recipes    map[string]RecipeRef `json:"recipes"`
	Layout     map[string]RecipeRef `json:"layout_recipes"`
	Generation uint64               `json:"generation"`
	CurrentSHA string               `json:"current_sha256"`
}

type prepare struct {
	Schema      int      `json:"schema"`
	Operation   string   `json:"operation"`
	Owner       string   `json:"owner"`
	Before      State    `json:"before"`
	After       State    `json:"after"`
	Expected    Expected `json:"expected"`
	StartBackup string   `json:"operation_start_backup"`
}

func targetKey(binary string) (string, string, error) {
	key, err := apptarget.Normalized(binary)
	if err != nil {
		return "", "", err
	}
	return key, fsx.SHA256([]byte(key))[:16], nil
}

func statePaths(directory, binary string) (string, string, error) {
	_, id, err := targetKey(binary)
	return filepath.Join(directory, "native-state-"+id+".json"), filepath.Join(directory, "native-prepare-"+id+".json"), err
}

func HasState(directory, binary string) (bool, error) {
	state, pending, err := statePaths(directory, binary)
	if err != nil {
		return false, err
	}
	for _, path := range []string{state, pending} {
		_, err := os.Lstat(path)
		if err == nil {
			return true, nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return false, err
		}
	}
	return false, nil
}

func readJSON(path string, value any) (bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !info.Mode().IsRegular() {
		return false, fmt.Errorf("native state must be a regular file: %s", path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}
	if err := StrictJSON(data, value); err != nil {
		return false, fmt.Errorf("invalid native state %s: %w", path, err)
	}
	return true, nil
}

func writeJSON(directory, path string, value any) (err error) {
	lock, err := patchlock.AcquireStoreLock(directory)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, lock.Release()) }()
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return fsx.AtomicWrite(path, append(data, '\n'), 0600)
}

func legacyPending(directory, binary, allowed string) error {
	_, id, err := targetKey(binary)
	if err != nil {
		return err
	}
	for _, owner := range []string{"limit", "tool-output", "compaction"} {
		if owner == allowed {
			continue
		}
		path := filepath.Join(directory, owner+"-prepare-"+id+".json")
		_, err := os.Lstat(path)
		if err == nil {
			return refuse("pending", fmt.Sprintf("an interrupted %s transaction must be resolved before another native feature can mutate this target: %s", owner, path))
		}
		if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

// GuardStandalone prevents old whole-file writers from bypassing shared native
// ownership, including when a feature package is invoked without CLI adapters.
func GuardStandalone(directory, binary, owner string) error {
	owned, err := HasState(directory, binary)
	if err != nil {
		return err
	}
	if owned {
		return errors.New("native-managed: use the shared native backend; standalone replacement would overwrite other features")
	}
	return legacyPending(directory, binary, owner)
}

func StandaloneRecoveryAllowed(directory, binary, owner string) (bool, error) {
	owned, err := HasState(directory, binary)
	if err != nil || owned {
		return false, err
	}
	if err := legacyPending(directory, binary, owner); err != nil {
		return false, err
	}
	_, id, err := targetKey(binary)
	if err != nil {
		return false, err
	}
	_, err = os.Lstat(filepath.Join(directory, owner+"-prepare-"+id+".json"))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

// LegacyRecords reads the last historical record for each feature without
// changing it. Adapters must still verify backups, fingerprints and full bytes.
func LegacyRecords(directory, binary string) (map[string]map[string]any, error) {
	key, _, err := targetKey(binary)
	if err != nil {
		return nil, err
	}
	result := map[string]map[string]any{}
	for owner, file := range map[string]string{"limit": "model-limit-state.json", "tool_output": "tool-output-state.json", "compaction": "compaction-state.json"} {
		var manifest struct {
			Schema  int              `json:"schema"`
			Records []map[string]any `json:"records"`
		}
		found, err := readJSON(filepath.Join(directory, file), &manifest)
		if err != nil {
			return nil, err
		}
		if !found {
			continue
		}
		if manifest.Schema != 1 || manifest.Records == nil {
			return nil, fmt.Errorf("invalid legacy %s manifest", owner)
		}
		for i := len(manifest.Records) - 1; i >= 0; i-- {
			record := manifest.Records[i]
			path, _ := record["binary_path"].(string)
			if path == "" {
				continue
			}
			candidate, err := apptarget.Normalized(path)
			if err != nil {
				return nil, err
			}
			if candidate == key {
				result[owner] = record
				break
			}
		}
	}
	return result, nil
}

// VerifyLegacyFeature checks a standalone fixed-feature record, both original
// backups and the complete reconstructed image without changing any files.
func VerifyLegacyFeature(binary string, record map[string]any, current, base []byte, spec Spec, feature string) (*Legacy, error) {
	config := EmptyConfig()
	var contribution *Contribution
	label := feature
	switch feature {
	case "compaction":
		config.Compaction, contribution = true, spec.Compaction
	case "tool_output":
		config.ToolOutput, contribution = true, spec.ToolOutput
		label = "tooloutput"
	default:
		return nil, fmt.Errorf("unsupported legacy fixed feature %q", feature)
	}
	field := func(name string) string { value, _ := record[name].(string); return value }
	if record == nil || field("action") != "patch" || field("binary_sha256_before") != spec.BaseSHA {
		return nil, nil
	}
	currentSHA := fsx.SHA256(current)
	if field("binary_sha256_after") != currentSHA {
		return nil, nil
	}
	history := spec.HistoricalToolOutput
	if feature == "compaction" {
		history = spec.HistoricalCompaction
	}
	ref := RecipeRef{ID: field("target_id") + "/" + field("input"), Fingerprint: field("recipe_fingerprint")}
	matches := 0
	if contribution != nil && contribution.Ref == ref {
		matches++
	}
	for i := range history {
		if history[i].Ref == ref {
			contribution = &history[i]
			matches++
		}
	}
	if matches != 1 {
		return nil, fmt.Errorf("legacy %s recipe identity or fingerprint no longer matches the registry", label)
	}
	if feature == "compaction" {
		spec.Compaction = contribution
	} else {
		spec.ToolOutput = contribution
	}
	basePath, err := VerifyLegacyBackups(binary, record, spec.BaseSHA, currentSHA)
	if err != nil {
		return nil, err
	}
	refs := map[string]RecipeRef{feature: contribution.Ref}
	out, err := Build(base, spec, config, refs)
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(out, current) {
		return nil, fmt.Errorf("legacy %s recipe does not reproduce the complete current image", label)
	}
	return &Legacy{Config: config, Recipes: refs, Layout: layoutRefs(spec), BasePath: basePath}, nil
}

func VerifyLegacyBackups(binary string, record map[string]any, baseSHA, currentSHA string) (string, error) {
	field := func(name string) string { value, _ := record[name].(string); return value }
	if field("binary_sha256_before") != baseSHA || field("binary_sha256_after") != currentSHA {
		return "", errors.New("legacy transaction hashes do not match the native original/current image")
	}
	key, _, err := targetKey(binary)
	if err != nil {
		return "", err
	}
	seen := map[string]bool{}
	for _, prefix := range []string{"backup_sibling", "repo_backup"} {
		path := field(prefix)
		hash := field(prefix + "_sha256")
		if path == "" || hash != baseSHA {
			return "", errors.New("legacy backup identity or fingerprint is missing")
		}
		backupKey, _, err := targetKey(path)
		if err != nil {
			return "", err
		}
		if backupKey == key || seen[backupKey] {
			return "", errors.New("legacy backup paths must be distinct from the target and each other")
		}
		seen[backupKey] = true
		actual, err := fsx.Hash(path)
		if err != nil {
			return "", err
		}
		if actual != baseSHA {
			return "", fmt.Errorf("legacy %s backup checksum mismatch", prefix)
		}
	}
	return field("backup_sibling"), nil
}
