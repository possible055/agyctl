// Package apptarget holds the neutral installation-target resolution shared
// by the native patching features: path normalization, paired-client target
// resolution, process inspection and app-version discovery. It owns no
// feature registry and no patch logic.
package apptarget

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"agyctl/internal/layout"
	"agyctl/internal/winproc"
)

// Normalized returns the canonical comparison key for a target path:
// absolute, symlink-resolved where possible, lower-cased on Windows.
func Normalized(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err == nil {
		absolute = resolved
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	if runtime.GOOS == "windows" {
		absolute = strings.ToLower(absolute)
	}
	return absolute, nil
}

// Resolved returns the absolute symlink-resolved path of an existing file.
func Resolved(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(absolute)
}

// TargetForBinary pairs an explicit language-server path with its
// installation's client executable, matching against the resolved candidates.
func TargetForBinary(binary string, candidates []layout.Target) (winproc.Target, error) {
	target := winproc.Target{BinaryPath: filepath.Clean(binary)}
	samePath := func(left, right string) bool {
		if runtime.GOOS == "windows" {
			return strings.EqualFold(left, right)
		}
		return left == right
	}
	for _, candidate := range candidates {
		path := filepath.Clean(candidate.LanguageServer)
		if samePath(path, target.BinaryPath) {
			target.ExecutablePath = candidate.Executable
			return target, nil
		}
	}
	matchedLayout := false
	for _, candidate := range candidates {
		if candidate.Root == "" {
			continue
		}
		relativeBinary, err := filepath.Rel(candidate.Root, candidate.LanguageServer)
		if err != nil || !filepath.IsLocal(relativeBinary) {
			return target, fmt.Errorf("invalid installation layout for %s", candidate.LanguageServer)
		}
		selectedRoot := target.BinaryPath
		for range strings.Split(relativeBinary, string(filepath.Separator)) {
			selectedRoot = filepath.Dir(selectedRoot)
		}
		if !samePath(filepath.Join(selectedRoot, relativeBinary), target.BinaryPath) {
			continue
		}
		matchedLayout = true
		relativeExecutable, err := filepath.Rel(candidate.Root, candidate.Executable)
		if err != nil || !filepath.IsLocal(relativeExecutable) {
			return target, fmt.Errorf("invalid paired executable layout for %s", candidate.Executable)
		}
		executable := filepath.Join(selectedRoot, relativeExecutable)
		info, err := os.Stat(executable)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return target, err
		}
		if !info.Mode().IsRegular() {
			return target, fmt.Errorf("paired client is not a regular file: %s", executable)
		}
		executable, err = Resolved(executable)
		if err != nil {
			return target, err
		}
		if target.ExecutablePath != "" && !samePath(target.ExecutablePath, executable) {
			return target, fmt.Errorf("ambiguous paired client for %s", binary)
		}
		target.ExecutablePath = executable
	}
	if matchedLayout && target.ExecutablePath == "" {
		return target, fmt.Errorf("paired client executable not found for %s", binary)
	}
	return target, nil
}

// AppRunning reports whether the target installation's application or
// language server is running. An unresolvable process state is an error, and
// callers must refuse mutation on any error or unknown result.
func AppRunning(binary string, candidates []layout.Target) (*bool, error) {
	path, err := Normalized(binary)
	if err != nil {
		return nil, err
	}
	target, err := TargetForBinary(path, candidates)
	if err != nil {
		return nil, err
	}
	state, err := winproc.Inspect(target)
	if err != nil {
		return nil, err
	}
	if state.Unknown {
		return nil, errors.New("cannot verify the target installation's process identities")
	}
	return state.Running, nil
}

// RequireStopped maps process-inspection outcomes to the shared refusal
// contract: probe errors, unknown states and running installations all refuse.
func RequireStopped(running *bool, probeErr error) error {
	if probeErr != nil {
		return fmt.Errorf("cannot verify language server process state — refusing to modify binary: %w", probeErr)
	}
	if running == nil {
		return errors.New("language server process state is unknown — refusing to modify binary")
	}
	if *running {
		return errors.New("the target installation's application or language server is running — quit that Antigravity installation first (the binary must be unlocked)")
	}
	return nil
}

// ChannelOf guesses the install channel from the installation path.
func ChannelOf(binary string) string {
	if strings.Contains(strings.ToLower(binary), "insiders") {
		return "antigravity-insiders"
	}
	return "antigravity"
}

// ReadVersion reports the installed app version from app.asar or
// app/package.json plus which source provided it. Version strings are
// diagnostics only and never substitute for byte-signature gates.
func ReadVersion(binary string) (string, string, error) {
	resources := filepath.Dir(filepath.Dir(binary))
	version, err := asarVersion(filepath.Join(resources, "app.asar"))
	var diagnostics []error
	if err != nil {
		diagnostics = append(diagnostics, err)
	}
	if version != "" {
		return version, "app.asar", errors.Join(diagnostics...)
	}
	data, err := os.ReadFile(filepath.Join(resources, "app", "package.json"))
	if errors.Is(err, os.ErrNotExist) {
		return "", "unknown", errors.Join(diagnostics...)
	}
	if err != nil {
		return "", "unknown", errors.Join(append(diagnostics, err)...)
	}
	var pkg struct {
		Version string `json:"version"`
	}
	if err = json.Unmarshal(data, &pkg); err != nil {
		return "", "unknown", errors.Join(append(diagnostics, fmt.Errorf("invalid app/package.json: %w", err))...)
	}
	if pkg.Version != "" {
		return pkg.Version, "app/package.json", errors.Join(diagnostics...)
	}
	return "", "unknown", errors.Join(diagnostics...)
}

func asarVersion(path string) (string, error) {
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	var pre [16]byte
	if _, err = io.ReadFull(f, pre[:]); err != nil {
		return "", fmt.Errorf("read app.asar header: %w", err)
	}
	size := binary.LittleEndian.Uint32(pre[12:])
	if size > 64<<20 {
		return "", fmt.Errorf("app.asar header exceeds 64 MiB")
	}
	data := make([]byte, size)
	if _, err = io.ReadFull(f, data); err != nil {
		return "", err
	}
	var header struct {
		Files map[string]struct {
			Size   int64  `json:"size"`
			Offset string `json:"offset"`
		} `json:"files"`
	}
	if err = json.Unmarshal(data, &header); err != nil {
		return "", fmt.Errorf("invalid app.asar header: %w", err)
	}
	node, ok := header.Files["package.json"]
	if !ok {
		return "", nil
	}
	offset, err := strconv.ParseInt(node.Offset, 10, 64)
	if err != nil {
		return "", fmt.Errorf("invalid app.asar package offset: %w", err)
	}
	if offset < 0 || node.Size < 0 || node.Size > 16<<20 {
		return "", fmt.Errorf("invalid app.asar package bounds")
	}
	data = make([]byte, node.Size)
	if _, err = f.ReadAt(data, 16+int64(size)+int64((4-size%4)%4)+offset); err != nil {
		return "", err
	}
	var pkg struct {
		Version string `json:"version"`
	}
	if err = json.Unmarshal(data, &pkg); err != nil {
		return "", fmt.Errorf("invalid app.asar package.json: %w", err)
	}
	return pkg.Version, nil
}
