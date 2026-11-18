package lspatch

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"slices"
	"strconv"

	"agyctl/internal/fsx"
)

const MaxContextLimit = 983040

type ModelLimit struct {
	ID    int `json:"id"`
	Limit int `json:"limit"`
}

type LimitConfig struct {
	Enabled     bool         `json:"enabled"`
	ModelLimits []ModelLimit `json:"model_limits"`
}

type Config struct {
	Limit            LimitConfig       `json:"limit"`
	ToolOutput       bool              `json:"tool_output"`
	Compaction       bool              `json:"compaction"`
	CompactionPrompt *CompactionPrompt `json:"compaction_prompt,omitempty"`
}

type Desired struct {
	Limit            *LimitConfig      `json:"limit,omitempty"`
	ToolOutput       *bool             `json:"tool_output,omitempty"`
	Compaction       *bool             `json:"compaction,omitempty"`
	CompactionPrompt *CompactionPrompt `json:"compaction_prompt,omitempty"`
}

func EmptyConfig() Config { return Config{Limit: LimitConfig{ModelLimits: []ModelLimit{}}} }

func (d Desired) Merge(current Config) (Config, error) {
	if d.Limit != nil {
		for _, value := range d.Limit.ModelLimits {
			if value.Limit > MaxContextLimit && !slices.Contains(current.Limit.ModelLimits, value) {
				return Config{}, fmt.Errorf("new or changed context limits must not exceed %d tokens", MaxContextLimit)
			}
		}
		current.Limit = *d.Limit
	}
	if d.ToolOutput != nil {
		current.ToolOutput = *d.ToolOutput
	}
	if d.Compaction != nil {
		current.Compaction = *d.Compaction
	}
	if d.CompactionPrompt != nil {
		prompt := *d.CompactionPrompt
		current.CompactionPrompt = &prompt
	}
	if !current.Compaction {
		if d.CompactionPrompt != nil {
			return Config{}, errors.New("compaction_prompt requires enabled compaction")
		}
		current.CompactionPrompt = nil
	}
	return current, current.Validate()
}

func (c Config) Validate() error {
	if c.CompactionPrompt != nil {
		if !c.Compaction {
			return errors.New("compaction_prompt requires enabled compaction")
		}
		if err := c.CompactionPrompt.Validate(); err != nil {
			return err
		}
	}
	if c.Limit.ModelLimits == nil {
		return errors.New("limit.model_limits must be an array")
	}
	if !c.Limit.Enabled {
		if len(c.Limit.ModelLimits) != 0 {
			return errors.New("disabled limit requires an empty model_limits array")
		}
		return nil
	}
	if len(c.Limit.ModelLimits) == 0 || len(c.Limit.ModelLimits) > 128 {
		return errors.New("enabled limit requires 1..128 model limits")
	}
	for i, value := range c.Limit.ModelLimits {
		if value.ID < 1 || int64(value.ID) > math.MaxInt32 || value.Limit < 1 || int64(value.Limit) > math.MaxInt32 {
			return errors.New("model IDs and limits must be positive int32 values")
		}
		if i > 0 && c.Limit.ModelLimits[i-1].ID >= value.ID {
			return errors.New("model IDs must be sorted and unique")
		}
	}
	return nil
}

// StrictJSON rejects unknown members, duplicate keys and trailing JSON values.
func StrictJSON(data []byte, value any) error {
	d := json.NewDecoder(bytes.NewReader(data))
	var walk func() error
	walk = func() error {
		token, err := d.Token()
		if err != nil {
			return err
		}
		delim, ok := token.(json.Delim)
		if !ok {
			return nil
		}
		switch delim {
		case '{':
			seen := map[string]bool{}
			for d.More() {
				key, err := d.Token()
				if err != nil {
					return err
				}
				name, ok := key.(string)
				if !ok || seen[name] {
					return fmt.Errorf("duplicate or invalid JSON member %v", key)
				}
				seen[name] = true
				if err := walk(); err != nil {
					return err
				}
			}
		case '[':
			for d.More() {
				if err := walk(); err != nil {
					return err
				}
			}
		default:
			return errors.New("unexpected JSON delimiter")
		}
		_, err = d.Token()
		return err
	}
	if err := walk(); err != nil {
		return err
	}
	if _, err := d.Token(); err != io.EOF {
		return errors.New("expected exactly one JSON value")
	}
	d = json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	return d.Decode(value)
}

func ParseDesired(data []byte) (Desired, error) {
	var raw map[string]json.RawMessage
	if err := StrictJSON(data, &raw); err != nil {
		return Desired{}, err
	}
	if raw == nil {
		return Desired{}, errors.New("desired must be an object")
	}
	var desired Desired
	for key, value := range raw {
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return desired, fmt.Errorf("desired.%s must not be null; omit it to preserve the current value", key)
		}
		switch key {
		case "limit":
			var fields map[string]json.RawMessage
			if err := StrictJSON(value, &fields); err != nil {
				return desired, err
			}
			if len(fields) != 2 || fields["enabled"] == nil || fields["model_limits"] == nil || bytes.Equal(fields["enabled"], []byte("null")) {
				return desired, errors.New("limit requires enabled and model_limits")
			}
			var config LimitConfig
			if err := StrictJSON(value, &config); err != nil {
				return desired, err
			}
			desired.Limit = &config
		case "tool_output":
			var enabled bool
			if err := StrictJSON(value, &enabled); err != nil {
				return desired, err
			}
			desired.ToolOutput = &enabled
		case "compaction":
			var enabled bool
			if err := StrictJSON(value, &enabled); err != nil {
				return desired, err
			}
			desired.Compaction = &enabled
		case "compaction_prompt":
			prompt, err := parseCompactionPrompt(value)
			if err != nil {
				return desired, err
			}
			desired.CompactionPrompt = prompt
		default:
			return desired, fmt.Errorf("unknown desired member %q", key)
		}
	}
	// The ceiling depends on installed mappings, which are only available at merge time.
	config := EmptyConfig()
	if desired.Limit != nil {
		config.Limit = *desired.Limit
	}
	if desired.CompactionPrompt != nil && desired.Compaction != nil && !*desired.Compaction {
		return desired, errors.New("compaction_prompt requires enabled compaction")
	}
	return desired, config.Validate()
}

func ParseExpected(data []byte) (Expected, error) {
	var fields map[string]json.RawMessage
	if err := StrictJSON(data, &fields); err != nil {
		return Expected{}, err
	}
	if len(fields) != 4 && len(fields) != 5 {
		return Expected{}, errors.New("expected requires base_sha256, current_sha256, generation and assets_fingerprint, with optional previous_state_sha256 for app updates")
	}
	for _, name := range []string{"base_sha256", "current_sha256", "generation", "assets_fingerprint"} {
		if fields[name] == nil || bytes.Equal(bytes.TrimSpace(fields[name]), []byte("null")) {
			return Expected{}, fmt.Errorf("expected.%s is required and must not be null", name)
		}
	}
	var expected Expected
	if err := StrictJSON(data, &expected); err != nil {
		return Expected{}, err
	}
	if !validSHA(expected.BaseSHA) || !validSHA(expected.CurrentSHA) || !validSHA(expected.AssetsFingerprint) {
		return Expected{}, errors.New("invalid native expected SHA-256 proof")
	}
	if raw, present := fields["previous_state_sha256"]; present && (bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || !validSHA(expected.PreviousStateSHA)) {
		return Expected{}, errors.New("invalid native previous-state SHA-256 proof")
	}
	return expected, nil
}

type Span struct {
	Offset                int
	Expected, Replacement []byte
}
type RecipeRef struct {
	ID          string `json:"id"`
	Fingerprint string `json:"fingerprint"`
}
type Contribution struct {
	Ref     RecipeRef
	Spans   []Span
	Qualify func([]byte) error
}

type Spec struct {
	ID, BaseSHA                                string
	Size                                       int
	ToolOutput, Compaction                     *Contribution
	HistoricalToolOutput, HistoricalCompaction []Contribution
	BuildCompaction                            func([]byte, CompactionPrompt, RecipeRef) (Contribution, error)
	CompactionPromptMaxBytes                   int
	Limit                                      func([]byte, LimitConfig, []Span, RecipeRef) (Contribution, error)
	LimitRef                                   RecipeRef
	LegacyLimitRefs                            []RecipeRef
	Qualify                                    func([]byte) error
}

type Legacy struct {
	Config   Config
	Recipes  map[string]RecipeRef
	Layout   map[string]RecipeRef
	BasePath string
}

type Engine struct {
	Directory         string
	AssetsFingerprint string
	Specs             []Spec
	RequireStopped    func(string) error
	SelectBinary      func(string) error
	Legacy            func(string, []byte, []byte, Spec) (*Legacy, error)
}

type Expected struct {
	BaseSHA           string `json:"base_sha256"`
	CurrentSHA        string `json:"current_sha256"`
	Generation        uint64 `json:"generation"`
	AssetsFingerprint string `json:"assets_fingerprint"`
	PreviousStateSHA  string `json:"previous_state_sha256,omitempty"`
}

func validSHA(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, c := range value {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

func Fingerprint(parts ...string) string {
	data := []byte{}
	for _, part := range parts {
		data = strconv.AppendInt(data, int64(len(part)), 10)
		data = append(data, ':')
		data = append(data, part...)
	}
	return fsx.SHA256(data)
}

type Request struct {
	Feature, Command, Binary string
	Apply                    bool
	Out                      string
	Desired                  Desired
	UseCurrentLimit          bool
}

type Handler func(Request) (map[string]any, bool, error)

type Refusal struct {
	Kind  string
	Cause error
}

func (r *Refusal) Error() string        { return r.Kind + ": " + r.Cause.Error() }
func (r *Refusal) Unwrap() error        { return r.Cause }
func refuse(kind, message string) error { return &Refusal{Kind: kind, Cause: errors.New(message)} }
