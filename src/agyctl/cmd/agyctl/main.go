package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"agyctl/internal/assets"
	"agyctl/internal/check"
	"agyctl/internal/layout"
	"agyctl/internal/limit"
)

// buildCommit is bound at build time by scripts/tools-build.mjs and lets the
// locate output prove which source tree an executable was built from.
var buildCommit = "unknown"

func runtimeScopes(args []string) []string {
	switch args[0] {
	case "locate":
		return []string{"layout"}
	case "client":
		if len(args) > 1 && args[1] == "target" {
			return []string{"layout"}
		}
	case "limit":
		for _, arg := range args[1:] {
			if arg == "--help" || arg == "-h" {
				return nil
			}
		}
		if len(args) > 1 && (args[1] == "metadata" || args[1] == "verify-state") {
			return nil
		}
		return []string{"limit"}
	case "check":
		switch checkerCommand(args[1:]) {
		case "local":
			return []string{"layout", "check"}
		case "versions", "check", "files":
			return []string{"layout", "check"}
		}
	}
	return nil
}

func checkerCommand(args []string) string {
	for i := 0; i < len(args); i++ {
		key, _, assigned := strings.Cut(args[i], "=")
		switch key {
		case "--work-dir", "--reports-dir", "--input-dir", "--channel", "--version", "--install-dir", "--file", "--limit", "--platform":
			if !assigned {
				i++
			}
			continue
		}
		if !strings.HasPrefix(key, "-") {
			return key
		}
	}
	return ""
}

// assetRoot finds the repository checkout that holds compat/, starting at the
// executable (dist/bin/<target>/) and then at the working directory.
func assetRoot() string {
	var starts []string
	if executable, err := os.Executable(); err == nil {
		starts = append(starts, filepath.Dir(executable))
	}
	if cwd, err := os.Getwd(); err == nil {
		starts = append(starts, cwd)
	}
	for _, start := range starts {
		for current := start; ; current = filepath.Dir(current) {
			if _, err := os.Stat(filepath.Join(current, "compat", "install-layout.json")); err == nil {
				return current
			}
			if filepath.Dir(current) == current {
				break
			}
		}
	}
	return ""
}

func run(args []string) (any, int, error) {
	root := assetRoot()
	if len(args) > 0 && args[0] == "--root" {
		if len(args) < 3 || !filepath.IsAbs(args[1]) {
			return nil, 1, fmt.Errorf("--root requires an absolute asset directory")
		}
		root, args = args[1], args[2:]
	}
	if len(args) == 0 {
		return nil, 1, fmt.Errorf("usage: agyctl [--root ABS_PATH] locate|limit|check|client target [arguments] --json")
	}
	scopes := runtimeScopes(args)
	snapshot, err := assets.Capture(root, scopes...)
	if err != nil {
		code := 1
		if args[0] == "check" {
			code = 3
		}
		return nil, code, err
	}
	switch args[0] {
	case "limit":
		return limit.Run(root, snapshot, args[1:])
	case "check":
		return check.Run(root, snapshot, args[1:])
	case "client":
		return clientTarget(root, snapshot, args[1:])
	case "locate":
		for _, arg := range args[1:] {
			if arg != "--json" {
				return nil, 1, fmt.Errorf("unknown locate argument: %s", arg)
			}
		}
		targets, err := layout.LocateFrom(root, snapshot)
		return map[string]any{
			"targets": targets,
			"build":   map[string]any{"commit": buildCommit},
		}, 0, err
	default:
		return nil, 1, fmt.Errorf("unknown command: %s", args[0])
	}
}

func clientTarget(root string, snapshot *assets.Snapshot, args []string) (any, int, error) {
	if len(args) == 0 || args[0] != "target" {
		return nil, 1, fmt.Errorf("usage: client target --binary PATH --json")
	}
	binary := ""
	for i := 1; i < len(args); i++ {
		if args[i] == "--json" {
			continue
		}
		if args[i] != "--binary" || binary != "" || i+1 >= len(args) {
			return nil, 1, fmt.Errorf("usage: client target --binary PATH --json")
		}
		i++
		binary = args[i]
	}
	if binary == "" {
		return nil, 1, fmt.Errorf("client target requires --binary PATH")
	}
	config, err := layout.Load(root, snapshot)
	if err != nil {
		return nil, 1, err
	}
	target, err := config.IdentifyBinary(binary)
	if err != nil {
		return nil, 1, err
	}
	return target, 0, nil
}

func main() {
	result, code, err := run(os.Args[1:])
	if err != nil {
		if code == 0 {
			code = 1
		}
		result = map[string]any{"error": err.Error()}
		fmt.Fprintln(os.Stderr, err)
	}
	if result == nil {
		result = map[string]any{}
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(result); err != nil {
		fmt.Fprintln(os.Stderr, err)
		code = 1
	}
	os.Exit(code)
}
