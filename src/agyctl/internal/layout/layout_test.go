package layout

import (
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
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
