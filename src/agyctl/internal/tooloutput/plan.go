package tooloutput

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"

	"agyctl/internal/fsx"
)

// Refusal kinds reported to the CLI. Every refusal leaves the installed
// binary untouched.
const (
	RefusalUnknownInput    = "unknown-input"
	RefusalPatchConflict   = "PATCH_CONFLICT"
	RefusalUnmanagedOutput = "recognized-output-unmanaged"
	RefusalSizeMismatch    = "size-mismatch"
	RefusalPEInvalid       = "pe-invalid"
)

type Refusal struct {
	Kind   string `json:"kind"`
	Detail string `json:"detail"`
}

func (r *Refusal) error() error {
	if r == nil {
		return nil
	}
	return fmt.Errorf("%s: %s", r.Kind, r.Detail)
}

type Admission struct {
	Target *Target
	State  *InputState
	parsed bool
}

// peArch inspects the DOS/PE headers and returns the image architecture, or
// an error for malformed images. This is a coarse identity check: the byte
// gate is the registered whole-file SHA-256, never the version string.
func peArch(data []byte) (string, error) {
	if len(data) < 0x40 || !bytes.HasPrefix(data, []byte("MZ")) {
		return "", errors.New("not a PE image")
	}
	peOffset := int(binary.LittleEndian.Uint32(data[0x3c:0x40]))
	if peOffset <= 0 || peOffset+6 > len(data) || !bytes.HasPrefix(data[peOffset:], []byte("PE\x00\x00")) {
		return "", errors.New("invalid PE header")
	}
	switch binary.LittleEndian.Uint16(data[peOffset+4:]) {
	case 0x8664:
		return "x86-64", nil
	case 0xAA64:
		return "arm64", nil
	default:
		return "unknown", nil
	}
}

// Admit matches a binary against the registry. A binary qualifies only on an
// exact whole-file SHA-256 registered for its target plus a matching PE
// identity, and every registered segment must still match the recorded
// expected bytes. Recognized output binaries and unknown mixtures are
// refused, never repaired or auto-restored.
func Admit(data []byte, reg Registry) (*Admission, *Refusal) {
	sha := fsx.SHA256(data)
	for ti := range reg.Targets {
		target := &reg.Targets[ti]
		if int64(len(data)) != target.BinarySize {
			continue
		}
		for ii := range target.Inputs {
			state := &target.Inputs[ii]
			if state.BinarySHA == sha {
				return admitTarget(data, target, state)
			}
		}
	}
	if isRecognizedOutput(data, reg) {
		return nil, &Refusal{Kind: RefusalUnmanagedOutput, Detail: "the binary matches a registered tool-output result but is not a registered input — it was produced outside this tool's transactions; refusing without guessing backups"}
	}
	for ti := range reg.Targets {
		if int64(len(data)) != reg.Targets[ti].BinarySize {
			continue
		}
		return nil, &Refusal{Kind: RefusalSizeMismatch, Detail: fmt.Sprintf("binary size matches target %s but the whole-file SHA-256 matches no registered input; refusing unknown bytes", reg.Targets[ti].ID)}
	}
	return nil, &Refusal{Kind: RefusalUnknownInput, Detail: "the binary matches no registered tool-output input; refusing"}
}

func admitTarget(data []byte, target *Target, state *InputState) (*Admission, *Refusal) {
	arch, err := peArch(data)
	if err != nil {
		return nil, &Refusal{Kind: RefusalPEInvalid, Detail: fmt.Sprintf("registered input matched but the image is not a valid PE: %v", err)}
	}
	if arch != target.Arch {
		return nil, &Refusal{Kind: RefusalPEInvalid, Detail: fmt.Sprintf("image architecture %s does not match the registered target architecture %s", arch, target.Arch)}
	}
	for si := range state.Segments {
		expected := state.Expected(si)
		if !bytes.Equal(data[state.Segments[si].Offset:int64(len(expected))+state.Segments[si].Offset], expected) {
			return nil, &Refusal{Kind: RefusalUnknownInput, Detail: fmt.Sprintf("whole-file hash matched input %s but segment %s drifted from its recorded bytes — refusing", state.Input, state.Segments[si].Name)}
		}
	}
	return &Admission{Target: target, State: state, parsed: true}, nil
}

func isRecognizedOutput(data []byte, reg Registry) bool {
	sha := fsx.SHA256(data)
	for ti := range reg.Targets {
		for ii := range reg.Targets[ti].Inputs {
			if reg.Targets[ti].Inputs[ii].OutputSHA == sha {
				return true
			}
		}
	}
	return false
}

type Plan struct {
	TargetID        string                    `json:"target_id"`
	TargetMember    string                    `json:"target_member"`
	Input           string                    `json:"input"`
	Qualification   string                    `json:"qualification"`
	Fingerprint     string                    `json:"recipe_fingerprint"`
	CapacityTargets map[string]CapacityTarget `json:"capacity_targets"`
	BytesChanged    int                       `json:"bytes_changed"`
	BeforeSHA       string                    `json:"binary_sha256_before"`
	AfterSHA        string                    `json:"binary_sha256_after"`

	output []byte
}

// Output returns the planned result bytes; callers persist them through
// fsx.ReplaceVerified only after the full transaction is prepared.
func (p Plan) Output() []byte { return p.output }

// BuildPlan produces the complete in-memory patch plan. It refuses when the
// registered output hash would not be reproduced exactly, so registry drift
// fails loudly instead of writing a mixed state.
func BuildPlan(data []byte, adm *Admission) (Plan, error) {
	var plan Plan
	out := make([]byte, len(data))
	copy(out, data)
	changed := 0
	for si := range adm.State.Segments {
		segment := adm.State.Segments[si]
		offset := segment.Offset
		replacement := adm.State.Replacement(si)
		copy(out[offset:offset+int64(len(replacement))], replacement)
		for i := range replacement {
			if data[offset+int64(i)] != replacement[i] {
				changed++
			}
		}
	}
	after := fsx.SHA256(out)
	if after != adm.State.OutputSHA {
		return plan, fmt.Errorf("registry inconsistency: applying the recorded recipe for input %s would not reproduce the registered output hash (got %s, registered %s) — refusing", adm.State.Input, after, adm.State.OutputSHA)
	}
	plan.TargetID = adm.Target.ID
	plan.TargetMember = adm.Target.Member
	plan.Input = adm.State.Input
	plan.Qualification = adm.Target.Qualification
	plan.Fingerprint = adm.State.Fingerprint()
	plan.CapacityTargets = adm.Target.CapacityTargets
	plan.BytesChanged = changed
	plan.BeforeSHA = fsx.SHA256(data)
	plan.AfterSHA = after
	plan.output = out
	return plan, nil
}
