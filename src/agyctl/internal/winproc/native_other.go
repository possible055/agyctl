//go:build !windows

package winproc

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"time"
)

// Process binding on POSIX matches the executable path anchored at the start
// of the full command line.
func processMatches(pattern string, full bool) (bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	args := []string{"-x", pattern}
	if full {
		args = []string{"-f", pattern}
	}
	output, err := exec.CommandContext(ctx, "pgrep", args...).Output()
	if ctx.Err() != nil {
		return false, fmt.Errorf("process inventory: %w", ctx.Err())
	}
	code := 0
	if err != nil {
		var exited *exec.ExitError
		if !errors.As(err, &exited) {
			return false, fmt.Errorf("process inventory: %w", err)
		}
		code = exited.ExitCode()
	}
	return pgrepResult(output, code)
}

func Inspect(target Target) (State, error) {
	globalServer, err := processMatches("language_server", false)
	if err != nil {
		return State{}, err
	}
	application := false
	if target.ExecutablePath != "" {
		application, err = processMatches("^"+regexp.QuoteMeta(target.ExecutablePath)+"([[:space:]]|$)", true)
		if err != nil {
			return State{}, err
		}
	}
	server := false
	if target.BinaryPath != "" {
		server, err = processMatches("^"+regexp.QuoteMeta(target.BinaryPath)+"([[:space:]]|$)", true)
		if err != nil {
			return State{}, err
		}
	}
	running := application || server
	return State{ApplicationRunning: application, LanguageServerRunning: server,
		AnyLanguageServerRunning: globalServer, GlobalLanguageServerRunning: globalServer, Running: &running}, nil
}
