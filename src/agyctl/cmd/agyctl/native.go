package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"agyctl/internal/apptarget"
	"agyctl/internal/assets"
	"agyctl/internal/compaction"
	"agyctl/internal/fsx"
	"agyctl/internal/layout"
	"agyctl/internal/limit"
	"agyctl/internal/lspatch"
	"agyctl/internal/tooloutput"
)

var nativeAppVersions = []string{"2.32.1", "2.33.0", "2.34.0"}

func nativeVersion(version string) bool {
	for _, known := range nativeAppVersions {
		if version == known {
			return true
		}
	}
	return false
}

// Scope selection is advisory only. Admission is repeated against the immutable
// union snapshot and complete reconstructed images in the native backend.
func usesNative(root string, args []string) (bool, error) {
	if args[0] == "native" {
		return true, nil
	}
	if args[0] != "limit" && args[0] != "tool-output" && args[0] != "compaction" {
		return false, nil
	}
	for _, arg := range args[1:] {
		if arg == "--help" || arg == "-h" || arg == "versions" || arg == "metadata" || arg == "verify-state" {
			return false, nil
		}
	}
	binary := ""
	for i := 1; i < len(args); i++ {
		key, value, assigned := strings.Cut(args[i], "=")
		if key == "--binary" {
			if assigned {
				binary = value
			} else if i+1 < len(args) {
				binary = args[i+1]
				i++
			}
		}
	}
	if binary == "" {
		return false, nil
	}
	home, err := layout.DataRoot()
	if err != nil {
		return false, err
	}
	if owned, err := lspatch.HasState(filepath.Join(home, "backups"), binary); owned || err != nil {
		return owned, err
	}
	version, _, err := apptarget.ReadVersion(binary)
	if err == nil && nativeVersion(version) && strings.HasSuffix(strings.ToLower(binary), ".exe") {
		return true, nil
	}
	var routing struct {
		Entries []struct {
			AppVersion string `json:"app_version"`
			BinarySHA  string `json:"binary_sha256"`
		} `json:"entries"`
		Targets []struct {
			AppVersion string `json:"app_version"`
			Inputs     []struct {
				Input     string `json:"input"`
				BinarySHA string `json:"binary_sha256"`
				OutputSHA string `json:"output_sha256"`
			} `json:"inputs"`
		} `json:"targets"`
	}
	registryFile := args[0] + ".json"
	if args[0] == "limit" {
		registryFile = "versions.json"
	}
	data, err := os.ReadFile(filepath.Join(root, "compat", registryFile))
	if err != nil {
		return false, err
	}
	if err := json.Unmarshal(data, &routing); err != nil {
		return false, err
	}
	sha, err := fsx.Hash(binary)
	if err != nil {
		return false, err
	}
	originals := map[string]bool{}
	outputs := map[string]bool{}
	for _, entry := range routing.Entries {
		if nativeVersion(entry.AppVersion) {
			originals[entry.BinarySHA] = true
		}
	}
	for _, target := range routing.Targets {
		if nativeVersion(target.AppVersion) {
			for _, input := range target.Inputs {
				if input.Input == "original" {
					originals[input.BinarySHA], outputs[input.OutputSHA] = true, true
				}
			}
		}
	}
	if originals[sha] || outputs[sha] {
		return true, nil
	}
	if len(originals) == 0 {
		return false, nil
	}
	records, err := lspatch.LegacyRecords(filepath.Join(home, "backups"), binary)
	if err != nil {
		return false, err
	}
	for _, record := range records {
		before, _ := record["binary_sha256_before"].(string)
		if record["action"] == "patch" && originals[before] && record["binary_sha256_after"] == sha {
			return true, nil
		}
	}
	return false, nil
}

func nativeEngine(root string, snapshot *assets.Snapshot) (lspatch.Engine, error) {
	var engine lspatch.Engine
	home, err := layout.DataRoot()
	if err != nil {
		return engine, err
	}
	engine.Directory = filepath.Join(home, "backups")
	engine.AssetsFingerprint = snapshot.Fingerprint()
	engine.SelectBinary = func(binary string) error {
		if _, _, err := apptarget.ReadVersion(binary); err != nil {
			return err
		}
		if _, err := apptarget.SelectBuild(binary, nativeAppVersions); err != nil {
			return &lspatch.Refusal{Kind: "unsupported", Cause: err}
		}
		return nil
	}
	toolRegistry, err := tooloutput.LoadRegistry(root, snapshot)
	if err != nil {
		return engine, err
	}
	compactionRegistry, err := compaction.LoadRegistry(root, snapshot)
	if err != nil {
		return engine, err
	}
	seen := map[string]bool{}
	for ti := range toolRegistry.Targets {
		target := &toolRegistry.Targets[ti]
		if !nativeVersion(target.AppVersion) {
			continue
		}
		for ii := range target.Inputs {
			input := &target.Inputs[ii]
			if input.Input != "original" {
				continue
			}
			if seen[input.BinarySHA] {
				return engine, errors.New("ambiguous registered shared native original")
			}
			seen[input.BinarySHA] = true
			limitRef, err := limit.NativeReferenceForBase(root, snapshot, input.BinarySHA)
			if err != nil {
				return engine, err
			}
			toolRecipe := tooloutput.NativeRecipe(target, input)
			spec := lspatch.Spec{ID: target.ID, BaseSHA: input.BinarySHA, Size: int(target.BinarySize), LimitRef: limitRef, LegacyLimitRefs: limit.NativeLegacyReferences(limitRef), ToolOutput: &toolRecipe}
			for hi := range target.HistoricalInputs {
				historical := &target.HistoricalInputs[hi]
				if historical.Input == input.Input && historical.BinarySHA == input.BinarySHA {
					spec.HistoricalToolOutput = append(spec.HistoricalToolOutput, tooloutput.NativeRecipe(target, historical))
				}
			}
			var compactionTarget *compaction.Target
			var compactionInput *compaction.InputState
			for ci := range compactionRegistry.Targets {
				candidate := &compactionRegistry.Targets[ci]
				if candidate.Platform != target.Platform || candidate.Arch != target.Arch || candidate.BinarySize != target.BinarySize {
					continue
				}
				for cj := range candidate.Inputs {
					state := &candidate.Inputs[cj]
					if state.Input != "original" || state.BinarySHA != input.BinarySHA {
						continue
					}
					if compactionInput != nil {
						return engine, errors.New("ambiguous registered native compaction original")
					}
					compactionTarget, compactionInput = candidate, state
				}
			}
			if compactionInput != nil {
				compactionRecipe := compaction.NativeRecipe(compactionTarget, compactionInput)
				spec.Compaction = &compactionRecipe
				if compactionInput.Prompt != nil {
					spec.CompactionPromptMaxBytes = compactionInput.Prompt.MaxBytes
					promptTarget := compactionTarget
					promptInputs := map[lspatch.RecipeRef]*compaction.InputState{compactionRecipe.Ref: compactionInput}
					for hi := range compactionTarget.HistoricalInputs {
						historical := &compactionTarget.HistoricalInputs[hi]
						if historical.Input == compactionInput.Input && historical.BinarySHA == input.BinarySHA && historical.Prompt != nil {
							promptInputs[compaction.NativeRecipe(compactionTarget, historical).Ref] = historical
						}
					}
					spec.BuildCompaction = func(base []byte, prompt lspatch.CompactionPrompt, ref lspatch.RecipeRef) (lspatch.Contribution, error) {
						promptInput := promptInputs[ref]
						if promptInput == nil {
							return lspatch.Contribution{}, errors.New("compaction prompt template identity is not registered")
						}
						return compaction.NativePromptContribution(base, promptTarget, promptInput, prompt, ref)
					}
				}
				for hi := range compactionTarget.HistoricalInputs {
					historical := &compactionTarget.HistoricalInputs[hi]
					if historical.Input == compactionInput.Input && historical.BinarySHA == input.BinarySHA {
						spec.HistoricalCompaction = append(spec.HistoricalCompaction, compaction.NativeRecipe(compactionTarget, historical))
					}
				}
			}
			spec.Limit = func(base []byte, config lspatch.LimitConfig, reserved []lspatch.Span, ref lspatch.RecipeRef) (lspatch.Contribution, error) {
				return limit.NativeContribution(root, snapshot, base, config, reserved, ref)
			}
			engine.Specs = append(engine.Specs, spec)
		}
	}
	candidates, err := layout.DefaultCandidates(root, snapshot)
	if err != nil {
		return engine, err
	}
	engine.RequireStopped = func(binary string) error {
		running, err := apptarget.AppRunning(binary, candidates)
		return apptarget.RequireStopped(running, err)
	}
	engine.Legacy = func(binary string, current, base []byte, spec lspatch.Spec) (*lspatch.Legacy, error) {
		proof, err := limit.NativeLegacy(root, snapshot, engine.Directory, binary, current, base, spec)
		if proof != nil || err != nil {
			return proof, err
		}
		proof, err = tooloutput.NativeLegacy(engine.Directory, binary, current, base, spec)
		if proof != nil || err != nil {
			return proof, err
		}
		return compaction.NativeLegacy(engine.Directory, binary, current, base, spec)
	}
	return engine, nil
}

func runNative(root string, snapshot *assets.Snapshot, args []string) (any, int, error) {
	failure := func(err error) (any, int, error) { return map[string]any{"error": err.Error()}, 1, err }
	if len(args) == 0 {
		return failure(errors.New("usage: native status|plan|apply --binary ABS --desired JSON [--expected JSON] --json"))
	}
	command := args[0]
	if command != "status" && command != "plan" && command != "apply" {
		return failure(fmt.Errorf("unknown native command %s", command))
	}
	flags := flag.NewFlagSet("native "+command, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	var binary, desiredJSON, expectedJSON string
	var jsonOutput bool
	flags.StringVar(&binary, "binary", "", "absolute language server path")
	flags.BoolVar(&jsonOutput, "json", false, "return JSON")
	if command != "status" {
		flags.StringVar(&desiredJSON, "desired", "", "strict partial desired-state JSON")
	}
	if command == "apply" {
		flags.StringVar(&expectedJSON, "expected", "", "exact plan.expected JSON")
	}
	if err := flags.Parse(args[1:]); err != nil {
		return failure(err)
	}
	if flags.NArg() != 0 || !filepath.IsAbs(binary) {
		return failure(errors.New("native requires --binary ABS and accepts no positional arguments"))
	}
	engine, err := nativeEngine(root, snapshot)
	if err != nil {
		return failure(err)
	}
	if command == "status" {
		result, err := engine.Status(binary)
		if err != nil {
			return failure(err)
		}
		return result, 0, nil
	}
	if desiredJSON == "" {
		return failure(errors.New("native plan/apply requires --desired JSON; use {} to retain all current settings"))
	}
	desired, err := lspatch.ParseDesired([]byte(desiredJSON))
	if err != nil {
		return failure(err)
	}
	if command == "plan" {
		plan, err := engine.Plan(binary, desired)
		if err != nil {
			return failure(err)
		}
		status := plan.Proof
		status["expected"], status["desired"], status["after_sha256"], status["bytes_changed"] = plan.Expected, plan.Desired, plan.AfterSHA, plan.BytesChanged
		return status, 0, nil
	}
	if expectedJSON == "" {
		return failure(errors.New("native apply requires --expected JSON from the reviewed plan"))
	}
	expected, err := lspatch.ParseExpected([]byte(expectedJSON))
	if err != nil {
		return failure(err)
	}
	result, err := engine.Apply(binary, desired, expected, "native")
	if err != nil {
		return failure(err)
	}
	return result, 0, nil
}
