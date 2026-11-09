package winproc

import (
	"path/filepath"
	"strings"
)

type Target struct {
	ExecutablePath string `json:"executablePath"`
	BinaryPath     string `json:"binaryPath"`
}

type State struct {
	Unknown                     bool  `json:"unknown"`
	ApplicationRunning          bool  `json:"applicationRunning"`
	LanguageServerRunning       bool  `json:"languageServerRunning"`
	AnyLanguageServerRunning    bool  `json:"anyLanguageServerRunning"`
	GlobalLanguageServerRunning bool  `json:"globalLanguageServerRunning"`
	Running                     *bool `json:"running"`
}

func stateForPaths(target Target, paths []string, unknown bool) State {
	state := State{Unknown: unknown}
	for _, path := range paths {
		state.ApplicationRunning = state.ApplicationRunning || (target.ExecutablePath != "" && strings.EqualFold(path, target.ExecutablePath))
		state.LanguageServerRunning = state.LanguageServerRunning || (target.BinaryPath != "" && strings.EqualFold(path, target.BinaryPath))
		state.AnyLanguageServerRunning = state.AnyLanguageServerRunning || strings.EqualFold(filepath.Base(path), "language_server.exe")
	}
	state.GlobalLanguageServerRunning = state.AnyLanguageServerRunning
	if !unknown {
		running := state.ApplicationRunning || state.LanguageServerRunning
		state.Running = &running
	}
	return state
}
