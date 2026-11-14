package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"agyctl/internal/testutil"
)

func minimalAsar(t *testing.T) []byte {
	t.Helper()
	members := map[string]string{
		"package.json":    `{"name":"fixture","version":"1","main":"dist/main.js"}`,
		"dist/main.js":    "main",
		"dist/preload.js": "webFrame.executeJavaScript",
	}
	files := map[string]any{}
	blob := []byte{}
	for _, name := range []string{"package.json", "dist/main.js", "dist/preload.js"} {
		content := members[name]
		node := files
		parts := bytes.Split([]byte(name), []byte("/"))
		for _, part := range parts[:len(parts)-1] {
			children, ok := node[string(part)].(map[string]any)
			if !ok {
				children = map[string]any{}
				node[string(part)] = map[string]any{"files": children}
			}
			node = children
		}
		node[string(parts[len(parts)-1])] = map[string]any{"size": len(content), "offset": len(blob)}
		blob = append(blob, content...)
	}
	raw, e := json.Marshal(map[string]any{"files": files})
	if e != nil {
		t.Fatal(e)
	}
	head := make([]byte, 16)
	binary.LittleEndian.PutUint32(head[12:], uint32(len(raw)))
	head = append(head, raw...)
	head = append(head, make([]byte, (4-len(raw)%4)%4)...)
	return append(head, blob...)
}

func runtimeFixture(t *testing.T) (root, install string) {
	t.Helper()
	root = testutil.TempDir(t)
	for _, directory := range []string{"scripts", "compat", "src/plugin", "src/capsule", "src/localization", "dist/localization"} {
		if e := os.MkdirAll(filepath.Join(root, directory), 0755); e != nil {
			t.Fatal(e)
		}
	}
	for _, relative := range []string{"install-layout.json", "versions.json", "localization/profiles.json"} {
		data, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "compat", filepath.FromSlash(relative)))
		if err != nil {
			t.Fatal(err)
		}
		destination := filepath.Join(root, "compat", filepath.FromSlash(relative))
		if err := os.MkdirAll(filepath.Dir(destination), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(destination, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	install = filepath.Join(root, "app")
	server := "language_server"
	if runtime.GOOS == "windows" {
		server += ".exe"
	}
	lsBinary, e := os.ReadFile(filepath.Join("..", "..", "testdata", "check", "pe-x64.bin"))
	if e != nil {
		t.Fatal(e)
	}
	for name, content := range map[string][]byte{
		filepath.Join(install, "resources", "bin", server): lsBinary,
		filepath.Join(install, "resources", "app.asar"):    minimalAsar(t),
	} {
		if e := os.MkdirAll(filepath.Dir(name), 0755); e != nil {
			t.Fatal(e)
		}
		if e := os.WriteFile(name, content, 0600); e != nil {
			t.Fatal(e)
		}
	}
	return root, install
}

func TestCommandsReadOnlyTheirOwnCompatFiles(t *testing.T) {
	root := testutil.TempDir(t)
	if err := os.MkdirAll(filepath.Join(root, "compat"), 0755); err != nil {
		t.Fatal(err)
	}
	toolBinary := filepath.Join(root, "language_server.exe")
	if err := os.WriteFile(toolBinary, []byte("placeholder"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "compat", "install-layout.json"), []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	toolOutputStatus := []string{"tool-output", "status", "--binary", toolBinary, "--json"}
	if _, code, err := run(append([]string{"--root", root}, toolOutputStatus...)); code == 0 || err == nil {
		t.Fatalf("tool-output needs compat/tool-output.json: code=%d error=%v", code, err)
	}
	for _, relative := range []string{"install-layout.json", "tool-output.json"} {
		layout, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "compat", filepath.FromSlash(relative)))
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(root, "compat", filepath.FromSlash(relative)), layout, 0600); err != nil {
			t.Fatal(err)
		}
	}
	for _, args := range [][]string{{"locate", "--json"}, {"limit", "metadata", "--json"}, {"tool-output", "versions", "--binary", toolBinary, "--json"}} {
		if _, code, err := run(append([]string{"--root", root}, args...)); err != nil || code != 0 {
			t.Fatalf("%v without unrelated compat files: code=%d error=%v", args, code, err)
		}
	}
	if _, code, err := run([]string{"--root", root, "client", "target"}); code != 1 || err == nil || !strings.Contains(err.Error(), "--binary") {
		t.Fatalf("client target without a binary: code=%d error=%v", code, err)
	}
	if _, code, err := run([]string{"--root", root, "limit", "status"}); code == 0 || err == nil {
		t.Fatalf("limit needs compat/versions.json: code=%d error=%v", code, err)
	}

}

func TestCheckLocalReadsOnlyItsDeclaredCompatFiles(t *testing.T) {
	root, install := runtimeFixture(t)
	registry := filepath.Join(root, "compat", "versions.json")
	before, e := os.ReadFile(registry)
	if e != nil {
		t.Fatal(e)
	}
	got, _, e := run([]string{"--root", root, "check", "--reports-dir", filepath.Join(root, "reports"), "local", "--install-dir", install, "--json"})
	if e != nil {
		t.Fatal(e)
	}
	if got == nil {
		t.Fatal("no report returned")
	}
	after, e := os.ReadFile(registry)
	if e != nil || !bytes.Equal(before, after) {
		t.Fatalf("compat/versions.json was rewritten: %v", e)
	}
	if _, e := os.Stat(filepath.Join(root, "var")); !os.IsNotExist(e) {
		t.Fatalf("check local wrote outside its reports directory: %v", e)
	}
}
