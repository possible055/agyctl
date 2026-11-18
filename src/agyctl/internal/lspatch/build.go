package lspatch

import (
	"bytes"
	"errors"
	"fmt"

	"agyctl/internal/fsx"
)

func recipeRefs(spec Spec, config Config) map[string]RecipeRef {
	refs := map[string]RecipeRef{}
	if config.Limit.Enabled {
		refs["limit"] = spec.LimitRef
	}
	if config.ToolOutput && spec.ToolOutput != nil {
		refs["tool_output"] = spec.ToolOutput.Ref
	}
	if config.Compaction && spec.Compaction != nil {
		refs["compaction"] = spec.Compaction.Ref
	}
	return refs
}

func layoutRefs(spec Spec) map[string]RecipeRef {
	refs := map[string]RecipeRef{}
	if spec.ToolOutput != nil {
		refs["tool_output"] = spec.ToolOutput.Ref
	}
	if spec.Compaction != nil {
		refs["compaction"] = spec.Compaction.Ref
	}
	return refs
}

func recordedLayout(spec Spec, refs map[string]RecipeRef) (Spec, error) {
	if refs == nil {
		return spec, errors.New("native recorded layout is missing")
	}
	for name, ref := range refs {
		var contribution *Contribution
		var history []Contribution
		switch name {
		case "tool_output":
			contribution = spec.ToolOutput
			history = spec.HistoricalToolOutput
		case "compaction":
			contribution = spec.Compaction
			history = spec.HistoricalCompaction
		default:
			return spec, errors.New("unknown native recorded layout feature")
		}
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
			return spec, errors.New("native recorded layout recipe identity or fingerprint changed")
		}
		if name == "tool_output" {
			spec.ToolOutput = contribution
		} else {
			spec.Compaction = contribution
		}
	}
	if _, ok := refs["tool_output"]; !ok {
		spec.ToolOutput = nil
	}
	if _, ok := refs["compaction"]; !ok {
		spec.Compaction = nil
	}
	return spec, nil
}

// Build always reconstructs the complete file from its registered original.
// All fixed recipe spans, including preserve guards, are reserved even while
// their feature is disabled, so limit allocation cannot depend on toggle order.
func Build(base []byte, spec Spec, config Config, refs map[string]RecipeRef) ([]byte, error) {
	if !validSHA(spec.BaseSHA) || fsx.SHA256(base) != spec.BaseSHA || len(base) != spec.Size {
		return nil, errors.New("native base does not match the registered whole-file original")
	}
	if spec.Qualify != nil {
		if err := spec.Qualify(base); err != nil {
			return nil, err
		}
	}
	if err := config.Validate(); err != nil {
		return nil, err
	}
	reserved := []Span{}
	for _, contribution := range []*Contribution{spec.ToolOutput, spec.Compaction} {
		if contribution == nil {
			continue
		}
		if contribution.Ref.ID == "" || !validSHA(contribution.Ref.Fingerprint) {
			return nil, errors.New("invalid native recipe identity")
		}
		if contribution.Qualify != nil {
			if err := contribution.Qualify(base); err != nil {
				return nil, err
			}
		}
		for _, span := range contribution.Spans {
			if err := validateSpan(base, span); err != nil {
				return nil, err
			}
			reserved = append(reserved, span)
		}
	}
	contributions := []Contribution{}
	if config.Limit.Enabled {
		allowed := refs["limit"] == spec.LimitRef
		for _, ref := range spec.LegacyLimitRefs {
			allowed = allowed || refs["limit"] == ref
		}
		if !allowed {
			return nil, errors.New("native limit recipe identity or fingerprint changed")
		}
		if spec.Limit == nil {
			return nil, errors.New("unsupported: limit is not qualified for the registered native base")
		}
		contribution, err := spec.Limit(base, config.Limit, reserved, refs["limit"])
		if err != nil {
			return nil, err
		}
		if contribution.Ref != refs["limit"] {
			return nil, errors.New("native limit recipe fingerprint changed")
		}
		contributions = append(contributions, contribution)
	}
	for _, entry := range []struct {
		name         string
		enabled      bool
		contribution *Contribution
	}{{"tool_output", config.ToolOutput, spec.ToolOutput}, {"compaction", config.Compaction, spec.Compaction}} {
		if !entry.enabled {
			continue
		}
		if entry.contribution == nil {
			return nil, fmt.Errorf("unsupported: %s has no registered recipe for this native base", entry.name)
		}
		if refs[entry.name] != entry.contribution.Ref {
			return nil, fmt.Errorf("native %s recipe identity or fingerprint changed", entry.name)
		}
		if entry.name == "compaction" && config.CompactionPrompt != nil {
			if spec.BuildCompaction == nil {
				return nil, errors.New("compaction prompt selection is not supported by this registered recipe")
			}
			contribution, err := spec.BuildCompaction(base, *config.CompactionPrompt, entry.contribution.Ref)
			if err != nil {
				return nil, err
			}
			if contribution.Ref != entry.contribution.Ref {
				return nil, errors.New("native compaction prompt recipe fingerprint changed")
			}
			if len(contribution.Spans) != len(entry.contribution.Spans) {
				return nil, errors.New("native compaction prompt omitted a registered span")
			}
			for _, span := range contribution.Spans {
				registered := false
				for _, fixed := range entry.contribution.Spans {
					if span.Offset == fixed.Offset && bytes.Equal(span.Expected, fixed.Expected) && len(span.Replacement) == len(fixed.Replacement) {
						registered = true
						break
					}
				}
				if !registered {
					return nil, errors.New("native compaction prompt writes outside its registered spans")
				}
			}
			entry.contribution = &contribution
		}
		contributions = append(contributions, *entry.contribution)
	}
	if len(refs) != len(contributions) {
		return nil, errors.New("native active recipe references do not match enabled features")
	}
	out := bytes.Clone(base)
	type owned struct {
		span    Span
		feature int
	}
	used := []owned{}
	for feature, contribution := range contributions {
		for _, span := range contribution.Spans {
			if err := validateSpan(base, span); err != nil {
				return nil, err
			}
			for _, prior := range used {
				if spansOverlap(span, prior.span) {
					return nil, fmt.Errorf("native contribution write/guard overlap at offset %#x", span.Offset)
				}
			}
			if feature == 0 && config.Limit.Enabled && refs["limit"] == spec.LimitRef {
				for _, fixed := range reserved {
					if spansOverlap(span, fixed) {
						return nil, fmt.Errorf("native limit overlaps a reserved recipe write/guard at offset %#x", span.Offset)
					}
				}
			}
			used = append(used, owned{span, feature})
			copy(out[span.Offset:], span.Replacement)
		}
	}
	return out, nil
}

func validateSpan(base []byte, span Span) error {
	if span.Offset < 0 || len(span.Expected) == 0 || len(span.Expected) != len(span.Replacement) || span.Offset > len(base)-len(span.Expected) {
		return errors.New("invalid native contribution bounds")
	}
	if !bytes.Equal(base[span.Offset:span.Offset+len(span.Expected)], span.Expected) {
		return fmt.Errorf("native contribution expected bytes drifted at offset %#x", span.Offset)
	}
	return nil
}

func spansOverlap(a, b Span) bool {
	return a.Offset < b.Offset+len(b.Expected) && b.Offset < a.Offset+len(a.Expected)
}
