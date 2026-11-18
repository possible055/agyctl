package compaction

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"agyctl/internal/assets"
	"agyctl/internal/lspatch"
)

// The registry admits only exact whole-file originals. Prompt choices may fill
// registered data and length fields, never user-selected code or offsets.
type Segment struct {
	Name        string `json:"name"`
	Role        string `json:"role"`
	VA          string `json:"va"`
	Offset      int64  `json:"offset"`
	ExpectedHex string `json:"expected_hex"`
	NewHex      string `json:"new_hex"`
}

type InputState struct {
	Input       string        `json:"input"`
	BinarySHA   string        `json:"binary_sha256"`
	OutputSHA   string        `json:"output_sha256"`
	Segments    []Segment     `json:"segments"`
	Prompt      *PromptRecipe `json:"prompt,omitempty"`
	fingerprint string
}

type PromptLengthField struct {
	Segment     string `json:"segment"`
	Offset      int    `json:"offset"`
	ExpectedHex string `json:"expected_hex"`
}

type PromptRecipe struct {
	BodySegment  string              `json:"body_segment"`
	MaxBytes     int                 `json:"max_bytes"`
	Segments     []Segment           `json:"segments"`
	LengthFields []PromptLengthField `json:"length_fields"`
}

type ValueTarget struct {
	SourceValue int    `json:"source_value"`
	Target      int    `json:"target"`
	Layer       string `json:"layer"`
}

type Target struct {
	ID               string                 `json:"id"`
	AppVersion       string                 `json:"app_version,omitempty"`
	Product          string                 `json:"product"`
	Channel          string                 `json:"channel"`
	Platform         string                 `json:"platform"`
	Arch             string                 `json:"arch"`
	BinaryName       string                 `json:"binary_name"`
	BinarySize       int64                  `json:"binary_size"`
	Member           string                 `json:"member"`
	Qualification    string                 `json:"qualification"`
	VerifiedAt       string                 `json:"verified_at"`
	ValueTargets     map[string]ValueTarget `json:"value_targets"`
	OutOfScope       []string               `json:"out_of_scope"`
	Evidence         map[string]string      `json:"evidence"`
	Notes            string                 `json:"notes"`
	Inputs           []InputState           `json:"inputs"`
	HistoricalInputs []InputState           `json:"historical_inputs,omitempty"`
}

type Registry struct {
	Schema  int      `json:"schema"`
	Feature string   `json:"feature"`
	Targets []Target `json:"targets"`
}

func isSHA256(value string) bool {
	if len(value) != 64 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

// LoadRegistry parses compat/compaction.json from the verified asset
// snapshot. A nil snapshot (only for direct library use in tests) falls back
// to reading the file under root; a non-nil snapshot must contain the file
// and never rereads it from disk.
func LoadRegistry(root string, snap *assets.Snapshot) (Registry, error) {
	var reg Registry
	data, err := assets.ReadFile(snap, root, "compat/compaction.json")
	if err != nil {
		return reg, err
	}
	if err = json.Unmarshal(data, &reg); err != nil {
		return reg, fmt.Errorf("invalid compat/compaction.json: %w", err)
	}
	if reg.Schema != 1 || reg.Feature != "compaction" || len(reg.Targets) == 0 {
		return reg, fmt.Errorf("invalid compaction registry schema, feature or targets")
	}
	seenTargets := map[string]bool{}
	for ti := range reg.Targets {
		if err = validateTarget(&reg.Targets[ti], seenTargets); err != nil {
			return reg, err
		}
	}
	return reg, nil
}

func validateTarget(target *Target, seenTargets map[string]bool) error {
	if target.ID == "" || seenTargets[target.ID] {
		return fmt.Errorf("registry target id %q is empty or duplicated", target.ID)
	}
	seenTargets[target.ID] = true
	if target.Arch != "x86-64" {
		return fmt.Errorf("registry target %s declares unsupported architecture %q", target.ID, target.Arch)
	}
	if target.Qualification != "candidate" && target.Qualification != "supported" {
		return fmt.Errorf("registry target %s must declare qualification candidate or supported", target.ID)
	}
	if target.BinarySize <= 0 || target.Member == "" || target.BinaryName == "" || target.Product == "" || target.Platform == "" {
		return fmt.Errorf("registry target %s is missing identity fields", target.ID)
	}
	if len(target.ValueTargets) == 0 {
		return fmt.Errorf("registry target %s must declare its value targets", target.ID)
	}
	seenInputs := map[string]bool{}
	for ii := range target.Inputs {
		if err := validateInput(&target.Inputs[ii], target, seenInputs); err != nil {
			return err
		}
	}
	seenRecipes := map[string]bool{}
	for ii := range target.Inputs {
		input := &target.Inputs[ii]
		seenRecipes[input.Input+"/"+input.Fingerprint()] = true
	}
	for ii := range target.HistoricalInputs {
		input := &target.HistoricalInputs[ii]
		if err := validateInput(input, target, map[string]bool{}); err != nil {
			return err
		}
		matched := false
		for _, current := range target.Inputs {
			matched = matched || input.Input == current.Input && input.BinarySHA == current.BinarySHA
		}
		key := input.Input + "/" + input.Fingerprint()
		if !matched || seenRecipes[key] {
			return fmt.Errorf("registry target %s has an unmatched or duplicated historical input recipe %s", target.ID, input.Input)
		}
		seenRecipes[key] = true
	}
	return nil
}

func validateInput(state *InputState, target *Target, seenInputs map[string]bool) error {
	if state.Input == "" || seenInputs[state.Input] {
		return fmt.Errorf("registry target %s has an empty or duplicated input state name", target.ID)
	}
	seenInputs[state.Input] = true
	if !isSHA256(state.BinarySHA) || !isSHA256(state.OutputSHA) {
		return fmt.Errorf("registry target %s input %s must declare whole-file SHA-256 input and output hashes", target.ID, state.Input)
	}
	if len(state.Segments) == 0 {
		return fmt.Errorf("registry target %s input %s must declare at least one segment", target.ID, state.Input)
	}
	roles := map[string]bool{"prompt": false, "capacity": false}
	type span struct {
		start, end int64
		name       string
	}
	spans := make([]span, 0, len(state.Segments))
	seenSegments := map[string]bool{}
	for si := range state.Segments {
		segment := &state.Segments[si]
		if segment.Name == "" || segment.Offset < 0 {
			return fmt.Errorf("registry target %s input %s segment %d is missing name or offset", target.ID, state.Input, si)
		}
		if seenSegments[segment.Name] {
			return fmt.Errorf("registry target %s input %s repeats segment name %s", target.ID, state.Input, segment.Name)
		}
		seenSegments[segment.Name] = true
		if _, known := roles[segment.Role]; !known {
			return fmt.Errorf("registry target %s input %s segment %s declares unsupported role %q", target.ID, state.Input, segment.Name, segment.Role)
		}
		expected, err := hex.DecodeString(segment.ExpectedHex)
		if err != nil || len(expected) == 0 {
			return fmt.Errorf("registry target %s input %s segment %s has invalid expected bytes", target.ID, state.Input, segment.Name)
		}
		replacement, err := hex.DecodeString(segment.NewHex)
		if err != nil || len(replacement) != len(expected) {
			return fmt.Errorf("registry target %s input %s segment %s has invalid or mismatched new bytes", target.ID, state.Input, segment.Name)
		}
		if segment.Offset > target.BinarySize-int64(len(expected)) {
			return fmt.Errorf("registry target %s input %s segment %s exceeds the declared binary size", target.ID, state.Input, segment.Name)
		}
		spans = append(spans, span{segment.Offset, segment.Offset + int64(len(expected)), segment.Name})
	}
	sort.Slice(spans, func(i, j int) bool { return spans[i].start < spans[j].start })
	for i := 1; i < len(spans); i++ {
		if spans[i].start < spans[i-1].end {
			return fmt.Errorf("registry target %s input %s segments %s and %s overlap", target.ID, state.Input, spans[i-1].name, spans[i].name)
		}
	}
	if err := validatePromptRecipe(state); err != nil {
		return fmt.Errorf("registry target %s input %s: %w", target.ID, state.Input, err)
	}
	// Pin the fingerprint now so loading validates the canonical digest once.
	state.Fingerprint()
	return nil
}

// Expected and Replacement decode the registered bytes of one segment. The
// registry loader has already validated the hex, so decoding cannot fail here.
func (s *InputState) Expected(index int) []byte {
	decoded, _ := hex.DecodeString(s.Segments[index].ExpectedHex)
	return decoded
}

func (s *InputState) Replacement(index int) []byte {
	decoded, _ := hex.DecodeString(s.Segments[index].NewHex)
	return decoded
}

// Fingerprint identifies the exact recipe of an input state; state records
// pin it so a registry change cannot silently alter what a recorded
// transaction restores.
func (s *InputState) Fingerprint() string {
	if s.fingerprint == "" {
		digest := sha256.New()
		ordered := append([]Segment(nil), s.Segments...)
		sort.Slice(ordered, func(i, j int) bool { return ordered[i].Name < ordered[j].Name })
		for _, segment := range ordered {
			_, _ = fmt.Fprintf(digest, "%s\x00%d\x00%s\x00%s\n", segment.Name, segment.Offset, strings.ToLower(segment.ExpectedHex), strings.ToLower(segment.NewHex))
		}
		if s.Prompt != nil {
			_, _ = fmt.Fprintf(digest, "@prompt-body\x00%s\x00%d\n", s.Prompt.BodySegment, s.Prompt.MaxBytes)
			custom := append([]Segment(nil), s.Prompt.Segments...)
			sort.Slice(custom, func(i, j int) bool { return custom[i].Name < custom[j].Name })
			for _, segment := range custom {
				_, _ = fmt.Fprintf(digest, "@prompt/%s\x00%d\x00%s\x00%s\n", segment.Name, segment.Offset, strings.ToLower(segment.ExpectedHex), strings.ToLower(segment.NewHex))
			}
			fields := append([]PromptLengthField(nil), s.Prompt.LengthFields...)
			sort.Slice(fields, func(i, j int) bool {
				if fields[i].Segment == fields[j].Segment {
					return fields[i].Offset < fields[j].Offset
				}
				return fields[i].Segment < fields[j].Segment
			})
			for _, field := range fields {
				_, _ = fmt.Fprintf(digest, "@prompt-length/%s\x00%d\x00%s\n", field.Segment, field.Offset, strings.ToLower(field.ExpectedHex))
			}
		}
		s.fingerprint = hex.EncodeToString(digest.Sum(nil))
	}
	return s.fingerprint
}

func validatePromptRecipe(state *InputState) error {
	policy := state.Prompt
	if policy == nil {
		return nil
	}
	if policy.MaxBytes < 1 || policy.MaxBytes > lspatch.MaxCompactionPromptBytes || policy.BodySegment == "" || len(policy.Segments) == 0 || len(policy.LengthFields) == 0 {
		return fmt.Errorf("invalid registered compaction prompt policy")
	}
	fixed := map[string]Segment{}
	for _, segment := range state.Segments {
		fixed[segment.Name] = segment
	}
	custom := map[string][]byte{}
	for _, segment := range policy.Segments {
		original, found := fixed[segment.Name]
		expected, err := hex.DecodeString(segment.ExpectedHex)
		if err != nil {
			return fmt.Errorf("invalid custom prompt preimage")
		}
		replacement, err := hex.DecodeString(segment.NewHex)
		if err != nil || len(expected) == 0 || len(expected) != len(replacement) || !found || segment.Role != "prompt" || original.Role != "prompt" || original.Offset != segment.Offset || !strings.EqualFold(original.ExpectedHex, segment.ExpectedHex) || !strings.EqualFold(original.ExpectedHex, original.NewHex) || custom[segment.Name] != nil {
			return fmt.Errorf("custom prompt template %s does not match a native-preserved registered span", segment.Name)
		}
		custom[segment.Name] = replacement
	}
	if len(custom[policy.BodySegment]) != policy.MaxBytes {
		return fmt.Errorf("custom prompt body does not match its registered byte capacity")
	}
	seen := map[string]bool{}
	for _, field := range policy.LengthFields {
		body, found := custom[field.Segment]
		expected, err := hex.DecodeString(field.ExpectedHex)
		key := fmt.Sprintf("%s/%d", field.Segment, field.Offset)
		if !found || field.Segment == policy.BodySegment || field.Offset < 0 || field.Offset > len(body)-4 || err != nil || len(expected) != 4 || binary.LittleEndian.Uint32(expected) != uint32(policy.MaxBytes) || hex.EncodeToString(body[field.Offset:field.Offset+4]) != strings.ToLower(field.ExpectedHex) || seen[key] {
			return fmt.Errorf("invalid custom prompt length field %s", key)
		}
		seen[key] = true
	}
	return nil
}
