package ids

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Window is the largest span (max minus min) the consumers' 128-bit lookup
// tables accept.
const Window = 128

// TermError reports why a model-id list was refused. Kind is one of "form"
// (grammar, signs, empty terms among valid ones, out-of-32-bit values),
// "range" (end before start), "window" (span past Window), or "empty" (no
// terms at all).
type TermError struct {
	Kind string
	Term string
	Lo   int64
	Hi   int64
}

func (e *TermError) Error() string {
	switch e.Kind {
	case "form":
		return fmt.Sprintf("invalid model id term %q", e.Term)
	case "range":
		return fmt.Sprintf("bad range %s", e.Term)
	case "window":
		return fmt.Sprintf("ids span %d..%d, past the %d-wide window", e.Lo, e.Hi, Window)
	default:
		return "no model ids given"
	}
}

// termPattern mirrors the settings validator grammar, tolerant of whitespace
// around the separators: comma-separated non-negative 32-bit numbers or
// inclusive "start-end" ranges, no empty terms, no signs.
var termPattern = regexp.MustCompile(`^\d+(?:\s*-\s*\d+)?$`)
var rangePattern = regexp.MustCompile(`^(\d+)\s*-\s*(\d+)$`)

// Parse is the single grammar for model-id lists shared by the limit patch
// commands and the supervisor's management options. It returns the deduplicated,
// sorted id list and refuses empty terms, malformed ranges (5-2), signs,
// whitespace terms, values outside int32, and spans past Window.
func Parse(spec string) ([]int, error) {
	set := map[int]bool{}
	sawTerm, sawEmpty := false, false
	for _, part := range strings.Split(spec, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			sawEmpty = true
			continue
		}
		sawTerm = true
		loText, hiText, hasRange := part, "", false
		if !termPattern.MatchString(part) {
			return nil, &TermError{Kind: "form", Term: part}
		}
		if m := rangePattern.FindStringSubmatch(part); m != nil {
			loText, hiText, hasRange = m[1], m[2], true
		}
		lo, e := strconv.ParseInt(loText, 10, 32)
		if e != nil {
			return nil, &TermError{Kind: "form", Term: part}
		}
		hi := lo
		if hasRange {
			hi, e = strconv.ParseInt(hiText, 10, 32)
			if e != nil {
				return nil, &TermError{Kind: "form", Term: part}
			}
			if hi < lo {
				return nil, &TermError{Kind: "range", Term: part, Lo: lo, Hi: hi}
			}
			// Refuse before expanding: a 32-bit span would otherwise be
			// materialized id by id.
			if hi-lo >= Window {
				return nil, &TermError{Kind: "window", Lo: lo, Hi: hi}
			}
		}
		for id := lo; id <= hi; id++ {
			set[int(id)] = true
		}
	}
	if sawEmpty && sawTerm {
		return nil, &TermError{Kind: "form", Term: ""}
	}
	out := make([]int, 0, len(set))
	for id := range set {
		out = append(out, id)
	}
	sort.Ints(out)
	if len(out) == 0 {
		return nil, &TermError{Kind: "empty"}
	}
	if int64(out[len(out)-1]-out[0]) >= Window {
		return nil, &TermError{Kind: "window", Lo: int64(out[0]), Hi: int64(out[len(out)-1])}
	}
	return out, nil
}
