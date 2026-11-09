package check

import (
	"agyctl/internal/fsx"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"unicode/utf8"
)

type object = map[string]any
type checkerError struct{ kind, message string }

func (e *checkerError) Error() string { return e.message }
func failure(kind, format string, args ...any) error {
	return &checkerError{kind, fmt.Sprintf(format, args...)}
}
func errorType(err error) string {
	var c *checkerError
	var s *symbolError
	var h *httpError
	if errors.As(err, &h) {
		return "HTTPError"
	}
	if errors.As(err, &c) {
		return c.kind
	}
	if errors.As(err, &s) {
		return "SymbolError"
	}
	if errors.Is(err, os.ErrNotExist) {
		return "FileNotFoundError"
	}
	if errors.Is(err, os.ErrPermission) {
		return "PermissionError"
	}
	var j *json.SyntaxError
	if errors.As(err, &j) {
		return "JSONDecodeError"
	}
	return "OSError"
}
func probeError(name string, err error) object {
	return object{"probe": name, "type": errorType(err), "message": err.Error()}
}
func failedProbe(err object) object {
	return object{"verdict": "fail", "checks": []string{fmt.Sprintf("%s: %s", err["type"], err["message"])}, "error": err}
}
func str(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprint(v)
}
func py(v any) string {
	if v == nil {
		return "None"
	}
	if b, ok := v.(bool); ok {
		if b {
			return "True"
		}
		return "False"
	}
	return str(v)
}
func num(v any) int64 {
	switch n := v.(type) {
	case float64:
		return int64(n)
	case int:
		return int64(n)
	case int64:
		return n
	case uint64:
		return int64(n)
	case json.Number:
		r, _ := n.Int64()
		return r
	}
	return 0
}
func obj(v any) object {
	if m, ok := v.(map[string]any); ok && m != nil {
		return m
	}
	return object{}
}
func objects(v any) []object {
	out := []object{}
	switch a := v.(type) {
	case []object:
		return a
	case []any:
		for _, v := range a {
			out = append(out, obj(v))
		}
	}
	return out
}
func stringsOf(v any) []string {
	if a, ok := v.([]string); ok {
		return a
	}
	out := []string{}
	if a, ok := v.([]any); ok {
		for _, v := range a {
			out = append(out, str(v))
		}
	}
	return out
}
func clone(m object) object {
	out := object{}
	for k, v := range m {
		out[k] = v
	}
	return out
}
func hashBytes(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }
func hashFile(path string) (string, error) {
	f, e := os.Open(path)
	if e != nil {
		return "", e
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	if _, e = io.Copy(h, f); e != nil {
		return "", e
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
func readJSON(path string) (object, error) {
	b, e := os.ReadFile(path)
	if e != nil {
		return nil, e
	}
	if !utf8.Valid(b) {
		return nil, failure("UnicodeDecodeError", "invalid UTF-8 JSON: %s", path)
	}
	var m object
	e = json.Unmarshal(b, &m)
	return m, e
}
func writeJSON(path string, m object) error {
	b, e := json.MarshalIndent(m, "", "  ")
	if e != nil {
		return e
	}
	if e = os.MkdirAll(filepath.Dir(path), 0755); e != nil {
		return e
	}
	return fsx.AtomicWrite(path, append(b, '\n'), 0600)
}
func isFile(path string) bool         { s, e := os.Stat(path); return e == nil && s.Mode().IsRegular() }
func isDir(path string) bool          { s, e := os.Stat(path); return e == nil && s.IsDir() }
func logf(format string, args ...any) { fmt.Fprintf(os.Stderr, format+"\n", args...) }
