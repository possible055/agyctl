package layout

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"agyctl/internal/assets"
	"agyctl/internal/testutil"
)

func assetRootFixture(t *testing.T, files map[string]string) string {
	t.Helper()
	root := testutil.TempDir(t)
	for _, directory := range []string{"scripts", "compat", "src/plugin", "src/capsule", "src/localization", "dist/localization"} {
		if err := os.MkdirAll(filepath.Join(root, directory), 0755); err != nil {
			t.Fatal(err)
		}
	}
	for name, content := range files {
		path := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestAppDirSelection(t *testing.T) {
	config, err := Load(filepath.Join("..", "..", "..", ".."), nil)
	if err != nil {
		t.Fatal(err)
	}
	host, err := config.Target(runtime.GOOS, runtime.GOARCH)
	if err != nil {
		t.Fatal(err)
	}
	platform := config.Platforms[host.NodePlatform]
	createInstallation := func(root string, channel Channel, complete bool) {
		t.Helper()
		files := []string{filepath.Join(platform.Resources, "app.asar")}
		if complete {
			files = append(files, filepath.Join(platform.Resources, "bin", platform.LanguageServer), filepath.FromSlash(channel.Executable))
		}
		for _, name := range files {
			filename := filepath.Join(root, name)
			if err := os.MkdirAll(filepath.Dir(filename), 0755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filename, []byte("installation data is never executed"), 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
	directory := testutil.TempDir(t)
	for index := range platform.Channels {
		platform.Channels[index].Root = filepath.Join(directory, platform.Channels[index].Channel)
		createInstallation(platform.Channels[index].Root, platform.Channels[index], true)
	}
	config.Platforms[host.NodePlatform] = platform
	data, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	root := assetRootFixture(t, map[string]string{"compat/install-layout.json": string(data)})
	for _, channel := range platform.Channels {
		t.Run(channel.Channel, func(t *testing.T) {
			selected := filepath.Join(directory, "unrelated-portable-"+channel.Channel)
			createInstallation(selected, channel, true)
			t.Setenv("AGYCTL_APP_DIR", selected)
			for _, discover := range []func(string, *assets.Snapshot) ([]Target, error){Candidates, LocateFrom} {
				targets, err := discover(root, nil)
				if err != nil || len(targets) != 1 || targets[0].Root != selected || targets[0].Channel != channel.Channel {
					t.Fatalf("targets=%+v error=%v", targets, err)
				}
			}
			defaults, err := DefaultCandidates(root, nil)
			if err != nil || len(defaults) != 2 || defaults[0].Root != platform.Channels[0].Root || defaults[1].Root != platform.Channels[1].Root {
				t.Fatalf("defaults=%+v error=%v", defaults, err)
			}
		})
	}
	incomplete := filepath.Join(directory, "incomplete")
	createInstallation(incomplete, platform.Channels[0], false)
	ambiguous := filepath.Join(directory, "ambiguous")
	for _, channel := range platform.Channels {
		createInstallation(ambiguous, channel, true)
	}
	rows := []struct{ name, value, reason string }{
		{"empty", "", "absolute"},
		{"relative", "relative-installation", "absolute"},
		{"missing", filepath.Join(directory, "missing"), "no such file"},
		{"incomplete", incomplete, "no such file"},
		{"ambiguous", ambiguous, "ambiguous"},
	}
	for _, row := range []struct{ name, reason string }{
		{filepath.Join(platform.Resources, "app.asar"), "no such file"},
		{filepath.FromSlash(platform.Channels[0].Executable), "missing or ambiguous"},
	} {
		name := row.name
		selected := filepath.Join(directory, "missing-"+filepath.Base(name))
		createInstallation(selected, platform.Channels[0], true)
		if err := os.Remove(filepath.Join(selected, name)); err != nil {
			t.Fatal(err)
		}
		rows = append(rows, struct{ name, value, reason string }{"missing-" + name, selected, row.reason})
	}
	for _, row := range rows {
		t.Run(row.name, func(t *testing.T) {
			t.Setenv("AGYCTL_APP_DIR", row.value)
			for _, discover := range []func(string, *assets.Snapshot) ([]Target, error){Candidates, LocateFrom} {
				_, err := discover(root, nil)
				if err == nil || !strings.Contains(err.Error(), "AGYCTL_APP_DIR") {
					t.Fatalf("expected AGYCTL_APP_DIR %s refusal, got %v", row.reason, err)
				}
				if row.reason == "no such file" && !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("expected missing installation file, got %v", err)
				}
				if row.reason != "no such file" && !strings.Contains(err.Error(), row.reason) {
					t.Fatalf("expected AGYCTL_APP_DIR %s refusal, got %v", row.reason, err)
				}
			}
			defaults, err := DefaultCandidates(root, nil)
			if err != nil || len(defaults) != 2 {
				t.Fatalf("invalid environment must not affect explicit-path defaults: targets=%+v error=%v", defaults, err)
			}
		})
	}
}

func layoutFixture(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "compat", "install-layout.json"))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestLocateFromUsesVerifiedSnapshot(t *testing.T) {
	root := assetRootFixture(t, map[string]string{"compat/install-layout.json": layoutFixture(t)})
	snap, err := assets.Capture(root, "layout")
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Remove(filepath.Join(root, "compat", "install-layout.json")); err != nil {
		t.Fatal(err)
	}
	targets, err := LocateFrom(root, snap)
	if err != nil {
		t.Fatalf("layout parsing must use the verified bytes, not a reread of the removed file: %v", err)
	}
	if targets == nil {
		t.Fatal("layout parsing returned no candidate list")
	}
	if _, err := LocateFrom(root, nil); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("nil snapshot must fall back to reading the removed file: %v", err)
	}
	if err = os.WriteFile(filepath.Join(root, "compat", "install-layout.json"), []byte(`{"schema":9}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = LocateFrom(root, snap); err != nil {
		t.Fatalf("snapshot parse must not reopen the mutated file: %v", err)
	}
	if _, err = LocateFrom(root, nil); err == nil || !strings.Contains(err.Error(), "unsupported install layout schema") {
		t.Fatalf("nil snapshot must parse the mutated file: %v", err)
	}
}

func TestClientTargetUsesExecutableBytes(t *testing.T) {
	config, err := Load(filepath.Join("..", "..", "..", ".."), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range []struct {
		file, target, format string
		mutate               func([]byte)
		refusal              string
	}{
		{file: "pe-x64.bin", target: "windows/amd64", format: "pe"},
		{file: "elf-x64.bin", target: "linux/amd64", format: "elf"},
		{file: "macho-arm64.bin", target: "darwin/arm64", format: "macho"},
		{file: "pe-x64.bin", mutate: func(b []byte) {
			offset := binary.LittleEndian.Uint32(b[0x3c:])
			binary.LittleEndian.PutUint16(b[offset+4:], 0xaa64)
		}, refusal: "unsupported PE target"},
		{file: "elf-x64.bin", mutate: func(b []byte) { binary.LittleEndian.PutUint16(b[18:], 0xb7) }, refusal: "unsupported ELF target"},
		{file: "macho-arm64.bin", mutate: func(b []byte) { binary.LittleEndian.PutUint32(b[4:], 0x1000007) }, refusal: "unsupported Mach-O target"},
	} {
		t.Run(row.file+row.refusal, func(t *testing.T) {
			directory, name := "check", row.file
			if row.file == "pe-x64.bin" {
				directory, name = "limit", "original.bin"
			}
			data, err := os.ReadFile(filepath.Join("..", "..", "testdata", directory, name))
			if err != nil {
				t.Fatal(err)
			}
			if row.mutate != nil {
				row.mutate(data)
			}
			path := filepath.Join(testutil.TempDir(t), "unrelated-platform-name.bin")
			if err = os.WriteFile(path, data, 0600); err != nil {
				t.Fatal(err)
			}
			result, err := config.IdentifyBinary(path)
			if row.refusal != "" {
				if err == nil || !strings.Contains(err.Error(), row.refusal) {
					t.Fatalf("target=%+v error=%v", result, err)
				}
			} else if err != nil || result.TargetID != row.target || result.Format != row.format {
				t.Fatalf("target=%+v error=%v", result, err)
			}
		})
	}
	arm, err := os.ReadFile(filepath.Join("..", "..", "testdata", "check", "macho-arm64.bin"))
	if err != nil {
		t.Fatal(err)
	}
	data := make([]byte, 4096)
	binary.BigEndian.PutUint32(data, 0xcafebabe)
	binary.BigEndian.PutUint32(data[4:], 1)
	binary.BigEndian.PutUint32(data[8:], 0x100000c)
	binary.BigEndian.PutUint32(data[16:], 4096)
	binary.BigEndian.PutUint32(data[20:], uint32(len(arm)))
	binary.BigEndian.PutUint32(data[24:], 12)
	path := filepath.Join(testutil.TempDir(t), "universal.bin")
	if err = os.WriteFile(path, append(data, arm...), 0600); err != nil {
		t.Fatal(err)
	}
	result, err := config.IdentifyBinary(path)
	if err != nil || result.TargetID != "darwin/arm64" {
		t.Fatalf("universal target=%+v error=%v", result, err)
	}
}
