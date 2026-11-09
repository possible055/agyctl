package winproc

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestSelectedInstallationProcessScope(t *testing.T) {
	target := Target{ExecutablePath: filepath.Join("selected", "Antigravity.exe"), BinaryPath: filepath.Join("selected", "language_server.exe")}
	for _, row := range []struct {
		name                                             string
		paths                                            []string
		unknown, application, server, anyServer, running bool
	}{
		{name: "other installation server is informational", paths: []string{filepath.Join("other", "language_server.exe")}, anyServer: true},
		{name: "selected application blocks", paths: []string{target.ExecutablePath}, application: true, running: true},
		{name: "selected server blocks", paths: []string{target.BinaryPath}, server: true, anyServer: true, running: true},
		{name: "unknown inventory fails closed", paths: []string{filepath.Join("other", "language_server.exe")}, unknown: true, anyServer: true},
	} {
		t.Run(row.name, func(t *testing.T) {
			state := stateForPaths(target, row.paths, row.unknown)
			if state.Unknown != row.unknown || state.ApplicationRunning != row.application || state.LanguageServerRunning != row.server || state.AnyLanguageServerRunning != row.anyServer || state.GlobalLanguageServerRunning != row.anyServer || (state.Running == nil) != row.unknown {
				t.Fatalf("state=%+v", state)
			}
			if state.Running != nil && *state.Running != row.running {
				t.Fatalf("running=%v want=%v", *state.Running, row.running)
			}
		})
	}
}

func TestPgrepProcessStateContract(t *testing.T) {
	for _, row := range []struct {
		name, output string
		code         int
		running      bool
		failure      string
	}{
		{"running", "123\n456\n", 0, true, ""},
		{"stopped", "", 1, false, ""},
		{"query failed", "", 3, false, "pgrep exit 3"},
		{"inconsistent success", "", 0, false, "no process IDs"},
		{"invalid PID", "unknown\n", 0, false, "invalid process ID"},
	} {
		t.Run(row.name, func(t *testing.T) {
			running, err := pgrepResult([]byte(row.output), row.code)
			if row.failure != "" {
				if err == nil || !strings.Contains(err.Error(), row.failure) {
					t.Fatalf("error=%v, want %q", err, row.failure)
				}
			} else if err != nil || running != row.running {
				t.Fatalf("running=%v error=%v, want %v", running, err, row.running)
			}
		})
	}
}
