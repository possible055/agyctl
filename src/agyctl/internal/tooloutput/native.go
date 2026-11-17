package tooloutput

import (
	"errors"

	"agyctl/internal/fsx"
	"agyctl/internal/lspatch"
)

// NativeContribution admits the exact registered original and reproduces the
// standalone output before exporting its complete writes and preserve guards.
func NativeContribution(base []byte, target *Target, input *InputState) (lspatch.Contribution, error) {
	admission, refusal := admitTarget(base, target, input)
	if refusal != nil {
		return lspatch.Contribution{}, refusal.error()
	}
	if fsx.SHA256(base) != input.BinarySHA || int64(len(base)) != target.BinarySize {
		return lspatch.Contribution{}, errors.New("native tooloutput base is not the exact registered whole-file original")
	}
	if _, err := BuildPlan(base, admission); err != nil {
		return lspatch.Contribution{}, err
	}
	return NativeRecipe(target, input), nil
}

// NativeRecipe retains qualification of this exact revision for reconstruction.
func NativeRecipe(target *Target, input *InputState) lspatch.Contribution {
	spans := make([]lspatch.Span, 0, len(input.Segments))
	for i, segment := range input.Segments {
		spans = append(spans, lspatch.Span{Offset: int(segment.Offset), Expected: input.Expected(i), Replacement: input.Replacement(i)})
	}
	return lspatch.Contribution{
		Ref:   lspatch.RecipeRef{ID: target.ID + "/" + input.Input, Fingerprint: input.Fingerprint()},
		Spans: spans,
		Qualify: func(base []byte) error {
			_, err := NativeContribution(base, target, input)
			return err
		},
	}
}

func NativeLegacy(directory, binary string, current, base []byte, spec lspatch.Spec) (*lspatch.Legacy, error) {
	s := store{directory: directory}
	record, err := s.last(binary)
	if err != nil {
		return nil, err
	}
	return lspatch.VerifyLegacyFeature(binary, record, current, base, spec, "tool_output")
}
