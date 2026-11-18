package compaction

import (
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"

	"agyctl/internal/lspatch"
)

// NativePromptContribution fills only the registered prompt data and length
// fields after qualifying the complete original and the fixed native recipe.
func NativePromptContribution(base []byte, target *Target, input *InputState, prompt lspatch.CompactionPrompt, ref lspatch.RecipeRef) (lspatch.Contribution, error) {
	if err := prompt.Validate(); err != nil {
		return lspatch.Contribution{}, err
	}
	if input.Prompt == nil {
		return lspatch.Contribution{}, errors.New("prompt selection is not supported by this registered compaction recipe")
	}
	if err := validatePromptRecipe(input); err != nil {
		return lspatch.Contribution{}, err
	}
	contribution, err := NativeContribution(base, target, input)
	if err != nil {
		return lspatch.Contribution{}, err
	}
	if contribution.Ref != ref {
		return lspatch.Contribution{}, errors.New("compaction prompt template identity changed")
	}
	if prompt.Mode == "native" {
		return contribution, nil
	}
	if len(prompt.Text) > input.Prompt.MaxBytes {
		return lspatch.Contribution{}, fmt.Errorf("custom compaction prompt exceeds the registered %d UTF-8 byte capacity", input.Prompt.MaxBytes)
	}
	byName := map[string]int{}
	for i, segment := range input.Segments {
		byName[segment.Name] = i
	}
	for _, segment := range input.Prompt.Segments {
		replacement, err := hex.DecodeString(segment.NewHex)
		if err != nil {
			return lspatch.Contribution{}, err
		}
		contribution.Spans[byName[segment.Name]].Replacement = replacement
	}
	body := contribution.Spans[byName[input.Prompt.BodySegment]].Replacement
	for i := range body {
		body[i] = ' '
	}
	copy(body, prompt.Text)
	for _, field := range input.Prompt.LengthFields {
		span := &contribution.Spans[byName[field.Segment]]
		binary.LittleEndian.PutUint32(span.Replacement[field.Offset:field.Offset+4], uint32(len(prompt.Text)))
	}
	return contribution, nil
}
