package lspatch

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"
)

const CompactionRetentionBudgetBytes = 61440
const MaxCompactionPromptBytes = 3937

type CompactionPrompt struct {
	Mode string `json:"mode"`
	Text string `json:"text"`
}

func (p CompactionPrompt) Validate() error {
	switch p.Mode {
	case "native":
		if p.Text != "" {
			return errors.New("native compaction prompt requires empty text")
		}
	case "custom":
		if !utf8.ValidString(p.Text) || strings.ContainsRune(p.Text, 0) {
			return errors.New("custom compaction prompt must be valid UTF-8 without NUL")
		}
		if strings.TrimFunc(p.Text, func(r rune) bool { return unicode.IsSpace(r) || r == '\ufeff' }) == "" {
			return errors.New("custom compaction prompt must not be empty")
		}
		if len(p.Text) > MaxCompactionPromptBytes {
			return fmt.Errorf("custom compaction prompt exceeds %d UTF-8 bytes", MaxCompactionPromptBytes)
		}
	default:
		return errors.New("compaction prompt mode must be native or custom")
	}
	return nil
}

func parseCompactionPrompt(data []byte) (*CompactionPrompt, error) {
	var fields map[string]json.RawMessage
	if err := StrictJSON(data, &fields); err != nil {
		return nil, err
	}
	if len(fields) != 2 || fields["mode"] == nil || fields["text"] == nil {
		return nil, errors.New("compaction_prompt requires mode and text")
	}
	for _, name := range []string{"mode", "text"} {
		value := bytes.TrimSpace(fields[name])
		if len(value) < 2 || value[0] != '"' || !utf8.Valid(value) {
			return nil, fmt.Errorf("compaction_prompt.%s must be a valid Unicode string", name)
		}
		// encoding/json replaces unpaired surrogate escapes instead of rejecting
		// them; a custom prompt must not change during configuration parsing.
		for i := 1; i < len(value)-1; i++ {
			if value[i] != '\\' {
				continue
			}
			i++
			if value[i] != 'u' {
				continue
			}
			unit, err := strconv.ParseUint(string(value[i+1:i+5]), 16, 16)
			if err != nil {
				return nil, err
			}
			i += 4
			if !utf16.IsSurrogate(rune(unit)) {
				continue
			}
			if unit >= 0xdc00 || i+6 >= len(value)-1 || value[i+1] != '\\' || value[i+2] != 'u' {
				return nil, errors.New("compaction prompt contains an unpaired Unicode surrogate")
			}
			low, err := strconv.ParseUint(string(value[i+3:i+7]), 16, 16)
			if err != nil || low < 0xdc00 || low > 0xdfff {
				return nil, errors.New("compaction prompt contains an unpaired Unicode surrogate")
			}
			i += 6
		}
	}
	type plain CompactionPrompt
	var value plain
	if err := StrictJSON(data, &value); err != nil {
		return nil, err
	}
	prompt := CompactionPrompt(value)
	return &prompt, prompt.Validate()
}

// UnmarshalJSON rejects invalid Unicode rather than repairing persisted prompts.
func (p *CompactionPrompt) UnmarshalJSON(data []byte) error {
	prompt, err := parseCompactionPrompt(data)
	if err != nil {
		return err
	}
	*p = *prompt
	return nil
}
