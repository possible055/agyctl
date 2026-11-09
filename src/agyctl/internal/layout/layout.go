package layout

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"agyctl/internal/assets"
)

type Target struct {
	TargetID       string `json:"targetId"`
	Root           string `json:"root"`
	Asar           string `json:"asar"`
	LanguageServer string `json:"languageServer"`
	Executable     string `json:"executable"`
	Channel        string `json:"channel"`
	Product        string `json:"product"`
}

type Channel struct {
	Channel    string `json:"channel"`
	Product    string `json:"product"`
	Root       string `json:"root"`
	Executable string `json:"executable"`
}

type Platform struct {
	Resources      string    `json:"resources"`
	LanguageServer string    `json:"language_server"`
	Channels       []Channel `json:"channels"`
}

type SupportedTarget struct {
	GOOS             string `json:"goos"`
	GOARCH           string `json:"goarch"`
	NodePlatform     string `json:"nodePlatform"`
	NodeArch         string `json:"nodeArch"`
	Feed             string `json:"feed"`
	ReleaseDirectory string `json:"releaseDirectory"`
	ChannelFile      string `json:"channelFile"`
}

type Config struct {
	Targets   map[string]SupportedTarget `json:"targets"`
	Schema    int                        `json:"schema"`
	Platforms map[string]Platform        `json:"platforms"`
}

func (c Config) Target(goos, goarch string) (SupportedTarget, error) {
	target, ok := c.Targets[goos+"/"+goarch]
	if !ok {
		return SupportedTarget{}, fmt.Errorf("unsupported target %s/%s", goos, goarch)
	}
	return target, nil
}

func (c Config) FeedTarget(feed string) (SupportedTarget, error) {
	for _, target := range c.Targets {
		if target.Feed == feed {
			return target, nil
		}
	}
	return SupportedTarget{}, fmt.Errorf("unsupported platform: %s", feed)
}

func (c Config) Feeds() []string {
	feeds := make([]string, 0, len(c.Targets))
	for _, target := range c.Targets {
		feeds = append(feeds, target.Feed)
	}
	sort.Strings(feeds)
	return feeds
}

// Load parses compat/install-layout.json from the verified asset snapshot.
// A nil snapshot (only for direct library use in tests) falls back to reading
// the file under root; a non-nil snapshot must contain the file and never
// rereads it from disk.
func Load(root string, snap *assets.Snapshot) (Config, error) {
	var config Config
	data, err := assets.ReadFile(snap, root, "compat/install-layout.json")
	if err != nil {
		return config, err
	}
	if err = json.Unmarshal(data, &config); err != nil {
		return config, err
	}
	if config.Schema != 1 {
		return config, fmt.Errorf("unsupported install layout schema %d", config.Schema)
	}
	if len(config.Targets) != 3 {
		return config, fmt.Errorf("install layout must declare exactly three supported targets")
	}
	feeds := map[string]bool{}
	for id, target := range config.Targets {
		if id != "windows/amd64" && id != "darwin/arm64" && id != "linux/amd64" {
			return config, fmt.Errorf("unsupported install layout target %s", id)
		}
		platform, ok := config.Platforms[target.NodePlatform]
		nodePlatform, nodeArch := target.GOOS, target.GOARCH
		if nodePlatform == "windows" {
			nodePlatform = "win32"
		}
		if nodeArch == "amd64" {
			nodeArch = "x64"
		}
		if target.GOOS+"/"+target.GOARCH != id || !ok || len(platform.Channels) != 2 || target.NodeArch == "" || target.Feed == "" || target.ReleaseDirectory == "" || target.ChannelFile == "" || feeds[target.Feed] {
			return config, fmt.Errorf("invalid install layout target %s", id)
		}
		if target.NodePlatform != nodePlatform || target.NodeArch != nodeArch {
			return config, fmt.Errorf("inconsistent Node identity for target %s", id)
		}
		feeds[target.Feed] = true
	}
	return config, nil
}

func DataRoot() (string, error) {
	if override := os.Getenv("AGYCTL_HOME"); override != "" {
		return override, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	switch runtime.GOOS {
	case "windows":
		local := os.Getenv("LOCALAPPDATA")
		if local == "" {
			local = filepath.Join(home, "AppData", "Local")
		}
		return filepath.Join(local, "agyctl"), nil
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "agyctl"), nil
	default:
		base := os.Getenv("XDG_STATE_HOME")
		if base == "" {
			base = filepath.Join(home, ".local", "state")
		}
		return filepath.Join(base, "agyctl"), nil
	}
}

// Candidates parses the install layout from the verified snapshot and resolves
// the per-channel install paths; a nil snapshot falls back to reading the
// layout file under root (library tests only).
func Candidates(root string, snap *assets.Snapshot) ([]Target, error) {
	config, err := Load(root, snap)
	if err != nil {
		return nil, err
	}
	target, err := config.Target(runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return nil, err
	}
	p := config.Platforms[target.NodePlatform]
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	local := os.Getenv("LOCALAPPDATA")
	if local == "" {
		local = filepath.Join(home, "AppData", "Local")
	}
	result := make([]Target, 0, len(p.Channels))
	for _, channel := range p.Channels {
		install := filepath.Clean(filepath.FromSlash(strings.ReplaceAll(channel.Root, "{localAppData}", local)))
		resources := filepath.Join(install, p.Resources)
		result = append(result, Target{TargetID: runtime.GOOS + "/" + runtime.GOARCH, Root: install, Asar: filepath.Join(resources, "app.asar"), LanguageServer: filepath.Join(resources, "bin", p.LanguageServer), Executable: filepath.Join(install, filepath.FromSlash(channel.Executable)), Channel: channel.Channel, Product: channel.Product})
	}
	return result, nil
}

// LocateFrom parses the install layout from the verified snapshot before
// statting the candidate installs; a nil snapshot falls back to reading the
// layout file under root (library tests only).
func LocateFrom(root string, snap *assets.Snapshot) ([]Target, error) {
	candidates, err := Candidates(root, snap)
	if err != nil {
		return nil, err
	}
	result := []Target{}
	for _, target := range candidates {
		stat, err := os.Stat(target.Asar)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if stat.Mode().IsRegular() {
			result = append(result, target)
		}
	}
	return result, nil
}
