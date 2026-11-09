package limit

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

func channelOf(binary string) string {
	if strings.Contains(strings.ToLower(binary), "insiders") {
		return "antigravity-insiders"
	}
	return "antigravity"
}

func readVersion(binary string) (string, string, error) {
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

func targetForBinary(binary string, candidates []layout.Target) winproc.Target {
	target := winproc.Target{BinaryPath: filepath.Clean(binary)}
	for _, candidate := range candidates {
		path := filepath.Clean(candidate.LanguageServer)
		matches := path == target.BinaryPath
		if runtime.GOOS == "windows" {
			matches = strings.EqualFold(path, target.BinaryPath)
		}
		if matches {
			target.ExecutablePath = candidate.Executable
			break
		}
	}
	return target
}

func appRunning(binary string, candidates []layout.Target) (*bool, error) {
	path, err := normalized(binary)
	if err != nil {
		return nil, err
	}
	state, err := winproc.Inspect(targetForBinary(path, candidates))
	if err != nil {
		return nil, err
	}
	if state.Unknown {
		return nil, errors.New("cannot verify the target installation's process identities")
	}
	return state.Running, nil
}
