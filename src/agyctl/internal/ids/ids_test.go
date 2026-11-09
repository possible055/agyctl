package ids

import (
	"errors"
	"testing"
)

func TestParseGrammarAndRefusalKinds(t *testing.T) {
	for _, row := range []struct {
		spec string
		kind string // "" means a successful parse
	}{
		{spec: "1318-1320, 1400,1318"},
		{spec: "1 , 2"},
		{spec: "01"},
		{spec: "0-127"},
		{spec: "5-2", kind: "range"},
		{spec: "+5", kind: "form"},
		{spec: "-5", kind: "form"},
		{spec: "1,,2", kind: "form"},
		{spec: "1,", kind: "form"},
		{spec: "1 2", kind: "form"},
		{spec: "1x", kind: "form"},
		{spec: "99999999999", kind: "form"},
		{spec: "1000-1129", kind: "window"},
		{spec: "0-2000000000", kind: "window"},
		{spec: "0-127,200", kind: "window"},
		{spec: ",", kind: "empty"},
		{spec: "", kind: "empty"},
	} {
		if row.kind == "" {
			if _, err := Parse(row.spec); err != nil {
				t.Fatalf("spec %q: unexpected error %v", row.spec, err)
			}
			continue
		}
		_, err := Parse(row.spec)
		var termErr *TermError
		if !errors.As(err, &termErr) || termErr.Kind != row.kind {
			t.Fatalf("spec %q: error = %v, want kind %q", row.spec, err, row.kind)
		}
	}
}
