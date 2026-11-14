package check

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha512"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"agyctl/internal/assets"
	"agyctl/internal/layout"
	"agyctl/internal/limit"
	"agyctl/internal/testutil"
)

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, e := os.ReadFile(filepath.Join("..", "..", "testdata", "check", name))
	if e != nil {
		t.Fatal(e)
	}
	return b
}

func fixtureObject(t *testing.T, name string) object {
	t.Helper()
	var m object
	if e := json.Unmarshal(fixture(t, name), &m); e != nil {
		t.Fatal(e)
	}
	return m
}

func jsonEqual(t *testing.T, got, want any) {
	t.Helper()
	g, e := json.Marshal(got)
	if e != nil {
		t.Fatal(e)
	}
	w, e := json.Marshal(want)
	if e != nil {
		t.Fatal(e)
	}
	if !bytes.Equal(g, w) {
		t.Fatalf("JSON differs\ngot: %s\nwant: %s", g, w)
	}
}

func put(t *testing.T, path string, b []byte) {
	t.Helper()
	if e := os.MkdirAll(filepath.Dir(path), 0755); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(path, b, 0600); e != nil {
		t.Fatal(e)
	}
}

func repoRoot(t *testing.T) string {
	t.Helper()
	r, e := filepath.Abs(filepath.Join("..", "..", "..", ".."))
	if e != nil {
		t.Fatal(e)
	}
	return r
}

// fuseWireExe emits a minimal fake Electron executable whose fuse wire
// qualifies capsule modification: schema 1, all indexed fuses disabled.
func fuseWireExe(t *testing.T) []byte {
	t.Helper()
	exe := bytes.Repeat([]byte{0x00}, 4096)
	wire := append([]byte(fuseSentinel), 0x01, 0x05)
	return append(exe, append(wire, []byte("00000")...)...)
}

func testOriginals(t *testing.T) [][]byte {
	t.Helper()
	known, e := limit.Originals(repoRoot(t), nil)
	if e != nil {
		t.Fatal(e)
	}
	return known
}

func checkerInputs(t *testing.T, root string) {
	t.Helper()
	for _, name := range []string{"compat/install-layout.json", "compat/versions.json", "compat/localization/profiles.json"} {
		data, err := os.ReadFile(filepath.Join(repoRoot(t), filepath.FromSlash(name)))
		if err != nil {
			t.Fatal(err)
		}
		put(t, filepath.Join(root, filepath.FromSlash(name)), data)
	}
}

func TestFrozenProbeContract(t *testing.T) {
	var rows []object
	if e := json.Unmarshal(fixture(t, "synthetic.json"), &rows); e != nil {
		t.Fatal(e)
	}
	known := testOriginals(t)
	for _, row := range rows {
		t.Run(str(row["file"]), func(t *testing.T) {
			path := filepath.Join("..", "..", "testdata", "check", str(row["file"]))
			data := fixture(t, str(row["file"]))
			probeData := data
			if bytes.HasPrefix(data, []byte("\x7fELF")) {
				// The historical oracle fixture omitted Go text-base metadata.
				// Make its intended runtime.text explicit without changing its bytes on disk.
				probeData = bytes.Clone(data)
				base := bytes.Index(probeData, []byte{0xf1, 0xff, 0xff, 0xff, 0, 0})
				binary.LittleEndian.PutUint64(probeData[base+24:], 0x1000)
				path = filepath.Join(testutil.TempDir(t), str(row["file"]))
				put(t, path, probeData)
			}
			got, e := probeLS(path, known)
			if e != nil {
				t.Fatal(e)
			}
			jsonEqual(t, got, row["result"])
			if hashBytes(data) != row["sha256"] {
				t.Fatal("Frozen input fixture digest changed")
			}
			name, arch, address, offset, size, e := LocateClamp(probeData)
			if e != nil {
				t.Fatal(e)
			}
			wantAddress := uint64(0x1000)
			if strings.HasPrefix(str(row["file"]), "pe-") {
				wantAddress = 0x140001000
			}
			if name != funcClamp || arch != obj(obj(row["result"])["fingerprint"])["arch"] || address != wantAddress || offset != 0x400 || size != 128 {
				t.Fatalf("unexpected location: %s %s %#x %#x %#x", name, arch, address, offset, size)
			}
			if str(row["file"]) == "macho-arm64.bin" {
				universal := make([]byte, 4096)
				binary.BigEndian.PutUint32(universal, 0xcafebabe)
				binary.BigEndian.PutUint32(universal[4:], 1)
				binary.BigEndian.PutUint32(universal[8:], 0x100000c)
				binary.BigEndian.PutUint32(universal[16:], 4096)
				binary.BigEndian.PutUint32(universal[20:], uint32(len(data)))
				binary.BigEndian.PutUint32(universal[24:], 12)
				_, selectedArch, selectedAddress, selectedOffset, selectedSize, err := LocateClamp(append(universal, data...))
				if err != nil || selectedArch != arch || selectedAddress != address || selectedOffset != offset+4096 || selectedSize != size {
					t.Fatalf("universal slice: %s %#x %#x %#x error=%v", selectedArch, selectedAddress, selectedOffset, selectedSize, err)
				}
			}
		})
	}
	for _, data := range [][]byte{nil, []byte("MZ"), fixture(t, "pe-x64.bin")[:80], []byte("\x7fELF"), []byte{0xcf, 0xfa, 0xed, 0xfe}} {
		_, _, _, _, _, e := LocateClamp(data)
		if e == nil || errorType(e) != "SymbolError" {
			t.Fatalf("truncated input: expected SymbolError, got %v", e)
		}
	}
}

func TestPclntabRejectsCorruptFunctions(t *testing.T) {
	for _, entry := range []struct {
		name   string
		change func([]byte, int, int) []byte
		want   string
	}{
		{"known clamp outside text", func(data []byte, base, table int) []byte {
			offset := len(data) - 0x400
			data = append(data, data[0x400:]...)
			for i := 0; i <= 4; i++ {
				entry := binary.LittleEndian.Uint32(data[table+i*8:])
				binary.LittleEndian.PutUint32(data[table+i*8:], entry+uint32(offset))
			}
			return data
		}, "outside .text"},
		{"invalid non-target name", func(data []byte, base, table int) []byte {
			names := base + int(binary.LittleEndian.Uint64(data[base+32:]))
			record := table + int(binary.LittleEndian.Uint32(data[table+3*8+4:]))
			name := names + int(int32(binary.LittleEndian.Uint32(data[record+4:])))
			data[name] = 0xff
			return data
		}, "function name"},
		{"unsorted non-target entry", func(data []byte, base, table int) []byte {
			binary.LittleEndian.PutUint32(data[table+3*8:], 1)
			return data
		}, "not sorted"},
		{"mismatched function record", func(data []byte, base, table int) []byte {
			record := table + int(binary.LittleEndian.Uint32(data[table+2*8+4:]))
			binary.LittleEndian.PutUint32(data[record:], 1)
			return data
		}, "entry mismatch"},
	} {
		t.Run(entry.name, func(t *testing.T) {
			data := fixture(t, "pe-x64.bin")
			base := bytes.Index(data, []byte{0xf1, 0xff, 0xff, 0xff, 0, 0})
			if base < 0 {
				t.Fatal("fixture has no pclntab")
			}
			table := base + int(binary.LittleEndian.Uint64(data[base+64:]))
			data = entry.change(data, base, table)
			_, _, _, _, _, err := LocateClamp(data)
			if err == nil || errorType(err) != "SymbolError" || !strings.Contains(err.Error(), entry.want) {
				t.Fatalf("corrupt table accepted or misdiagnosed: %v; want %q", err, entry.want)
			}
		})
	}
}

func TestPclntabCandidateValidation(t *testing.T) {
	for _, entry := range []struct {
		name   string
		change func([]byte, int, int) []byte
		query  string
		want   string
	}{
		{"decoy before complete table", func(data []byte, base, table int) []byte {
			copy(data[0x480:], data[base:base+72])
			binary.LittleEndian.PutUint64(data[0x480+8:], 1)
			copy(data[0x480+72:], []byte("decoy.Function\x00\x00\x00"))
			return data
		}, funcClamp, ""},
		{"UTF-8 function name", func(data []byte, base, table int) []byte {
			names := base + int(binary.LittleEndian.Uint64(data[base+32:]))
			record := table + int(binary.LittleEndian.Uint32(data[table+3*8+4:]))
			name := names + int(int32(binary.LittleEndian.Uint32(data[record+4:])))
			copy(data[name:], []byte("pkg.函式\x00"))
			return data
		}, "pkg.函式", ""},
		{"two complete tables", func(data []byte, base, table int) []byte {
			copyOfTable := bytes.Clone(data[base:])
			data = append(data, make([]byte, (8-len(data)%8)%8)...)
			data = append(data, copyOfTable...)
			section := 0x148
			binary.LittleEndian.PutUint32(data[section+8:], uint32(len(data)-0x400))
			binary.LittleEndian.PutUint32(data[section+16:], uint32(len(data)-0x400))
			return data
		}, funcClamp, "multiple valid tables"},
		{"unaligned embedded table", func(data []byte, base, table int) []byte {
			copyOfTable := bytes.Clone(data[base:])
			data = append(data, make([]byte, (8-len(data)%8)%8+1)...)
			data = append(data, copyOfTable...)
			section := 0x148
			binary.LittleEndian.PutUint32(data[section+8:], uint32(len(data)-0x400))
			binary.LittleEndian.PutUint32(data[section+16:], uint32(len(data)-0x400))
			return data
		}, funcClamp, ""},
	} {
		t.Run(entry.name, func(t *testing.T) {
			data := fixture(t, "pe-x64.bin")
			base := bytes.Index(data, []byte{0xf1, 0xff, 0xff, 0xff, 0, 0})
			table := base + int(binary.LittleEndian.Uint64(data[base+64:]))
			got, err := locateFunctions(entry.change(data, base, table), []string{entry.query})
			if entry.want != "" {
				if err == nil || errorType(err) != "SymbolError" || !strings.Contains(err.Error(), entry.want) {
					t.Fatalf("ambiguous table error = %v, want %q", err, entry.want)
				}
				return
			}
			if err != nil || got[entry.query] == nil || got[entry.query].Name != entry.query {
				t.Fatalf("valid function %q not resolved: %v (%v)", entry.query, got, err)
			}
		})
	}
}

func makeAsar(t *testing.T, members map[string][]byte) []byte {
	t.Helper()
	files := object{}
	blob := []byte{}
	for _, name := range orderedKeys(mapAny(members), []string{"package.json", "dist/main.js", "dist/preload.js"}) {
		content := members[name]
		parts := strings.Split(name, "/")
		node := files
		for _, part := range parts[:len(parts)-1] {
			if node[part] == nil {
				node[part] = object{"files": object{}}
			}
			node = obj(obj(node[part])["files"])
		}
		node[parts[len(parts)-1]] = object{"size": len(content), "offset": fmt.Sprint(len(blob))}
		blob = append(blob, content...)
	}
	raw, e := json.Marshal(object{"files": files})
	if e != nil {
		t.Fatal(e)
	}
	head := make([]byte, 16)
	binary.LittleEndian.PutUint32(head[12:], uint32(len(raw)))
	head = append(head, raw...)
	head = append(head, make([]byte, (4-len(raw)%4)%4)...)
	return append(head, blob...)
}

func mapAny(m map[string][]byte) object {
	out := object{}
	for k, v := range m {
		out[k] = v
	}
	return out
}

func validAsar(t *testing.T) []byte {
	return makeAsar(t, map[string][]byte{"package.json": []byte(`{"name":"fixture","version":"1","main":"dist/main.js"}`), "dist/main.js": []byte("main"), "dist/preload.js": []byte("webFrame.executeJavaScript")})
}

func TestASARContract(t *testing.T) {
	dir := testutil.TempDir(t)
	path := filepath.Join(dir, "app.asar")
	put(t, path, validAsar(t))
	a, e := openAsar(path)
	if e != nil {
		t.Fatal(e)
	}
	got, e := a.read("dist/main.js")
	if e != nil || string(got) != "main" {
		t.Fatalf("padded ASAR member = %q, %v", got, e)
	}
	if got, err := probeAsar(path, ""); err != nil || got["verdict"] != "pass" || obj(got["app"])["version"] != "1" {
		t.Fatalf("probe = %#v, %v", got, err)
	}
	_, e = a.read("dist")
	if e == nil || e.Error() != "dist is a directory" {
		t.Fatalf("directory error = %v", e)
	}
	_, e = a.read("missing")
	if e == nil || e.Error() != "no such member: missing" {
		t.Fatalf("missing error = %v", e)
	}
	put(t, path, validAsar(t))
	uiProbe, probeErr := probeAsar(path, "")
	if probeErr != nil {
		t.Fatal(probeErr)
	}
	evidence, present := uiProbe["staticHookEvidence"].(map[string]any)
	if !present || evidence["present"] != true {
		t.Fatalf("static hook evidence missing from ui probe: %#v", uiProbe["staticHookEvidence"])
	}
	if evidence["observed_via"] != "static dist/preload.js text" {
		t.Fatalf("static hook evidence source = %v", evidence["observed_via"])
	}
	put(t, path, makeAsar(t, map[string][]byte{"package.json": []byte(`{"name":"fixture","version":"1"}`), "dist/main.js": []byte("main"), "dist/preload.js": []byte("no hooks here")}))
	uiProbe, probeErr = probeAsar(path, "")
	if probeErr != nil {
		t.Fatal(probeErr)
	}
	evidence, present = uiProbe["staticHookEvidence"].(map[string]any)
	if !present || evidence["present"] != false || uiProbe["verdict"] != "fail" {
		t.Fatalf("missing hook markers must be static evidence with failing verdict: %#v / %v", uiProbe["staticHookEvidence"], uiProbe["verdict"])
	}
	header, _ := json.Marshal(object{"files": object{"native.node": object{"size": 2, "unpacked": true}}})
	raw := make([]byte, 16)
	binary.LittleEndian.PutUint32(raw[12:], uint32(len(header)))
	raw = append(raw, header...)
	put(t, path, raw)
	put(t, path+".unpacked/native.node", []byte{1, 2})
	a, e = openAsar(path)
	if e != nil {
		t.Fatal(e)
	}
	got, e = a.read("native.node")
	if e != nil || !bytes.Equal(got, []byte{1, 2}) {
		t.Fatalf("unpacked = %v, %v", got, e)
	}
	brokenHeader, e := json.Marshal(object{"files": object{"dist": object{"files": object{"main.js": object{"size": 0, "offset": "0"}, "preload.js": object{"size": 1, "unpacked": true}}}}})
	if e != nil {
		t.Fatal(e)
	}
	broken := make([]byte, 16)
	binary.LittleEndian.PutUint32(broken[12:], uint32(len(brokenHeader)))
	broken = append(broken, brokenHeader...)
	broken = append(broken, make([]byte, (4-len(brokenHeader)%4)%4)...)
	put(t, path, broken)
	if got, err := probeAsar(path, ""); got != nil || err == nil || errorType(err) != "FileNotFoundError" {
		t.Fatalf("unpacked I/O failure was swallowed: %#v, %v", got, err)
	}
	t.Run("unpacked member refuses symbolic links", func(t *testing.T) {
		put(t, path, raw)
		external := filepath.Join(dir, "outside.node")
		put(t, external, []byte("outside"))
		member := filepath.Join(path+".unpacked", "native.node")
		if err := os.Remove(member); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(external, member); err != nil {
			t.Skipf("symbolic links unavailable: %v", err)
		}
		archive, err := openAsar(path)
		if err != nil {
			t.Fatal(err)
		}
		if got, err := archive.read("native.node"); got != nil || err == nil || errorType(err) != "AsarError" || !strings.Contains(err.Error(), "regular file") {
			t.Fatalf("linked unpacked member = %q, %v", got, err)
		}
	})
}

func TestFeedAndDownloadContract(t *testing.T) {
	config, err := layout.Load(repoRoot(t), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range []struct{ channel, version, platform, suffix string }{{"hub", "2.29.0", "win-x64", "windows-x64/Antigravity-x64.exe"}, {"hub", "2.29.0", "darwin-arm64", "darwin-arm/Antigravity.dmg"}} {
		got, e := assetURL(config, row.channel, row.version, "execution", row.platform)
		if e != nil || !strings.HasSuffix(got, row.suffix) {
			t.Fatalf("asset = %q, %v", got, e)
		}
	}
	y, e := parseYAML("version: 1.0.1\nfiles:\n  - url: 1.0.1/app.AppImage\n    sha512: image\n    size: 100\n  - url: 1.0.1/Antigravity - Insiders-amd64.deb\n    sha512: deb\n    size: 50\npath: 1.0.1/app.AppImage\nsha512: image\n")
	if e != nil {
		t.Fatal(e)
	}
	a, e := insidersAsset("linux-x64", y)
	if e != nil {
		t.Fatal(e)
	}
	if a["sha512"] != "deb" || num(a["size"]) != 50 || !strings.HasSuffix(str(a["url"]), "Antigravity%20-%20Insiders-amd64.deb") {
		t.Fatalf("deb choice = %#v", a)
	}
	content := []byte("installer bytes")
	sum := sha512.Sum512(content)
	expected512 := base64.StdEncoding.EncodeToString(sum[:])
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("User-Agent") != userAgent {
			t.Errorf("missing user agent")
		}
		_, _ = w.Write(content)
	}))
	defer server.Close()
	path := filepath.Join(testutil.TempDir(t), "installer.zip")
	put(t, path, []byte("previous"))
	for _, row := range []struct {
		name     string
		size     int
		checksum string
		want     string
	}{{"size", len(content) + 1, expected512, "download truncated"}, {"sha512", len(content), "wrong", "download SHA-512"}, {"valid", len(content), expected512, ""}} {
		t.Run(row.name, func(t *testing.T) {
			sha, n, e := download(server.URL, path, row.size, row.checksum)
			if row.want != "" {
				if e == nil || !strings.Contains(e.Error(), row.want) {
					t.Fatalf("expected %s, got %v", row.want, e)
				}
				b, _ := os.ReadFile(path)
				if string(b) != "previous" {
					t.Fatal("failed download replaced existing destination")
				}
				return
			}
			if e != nil || sha != hashBytes(content) || n != int64(len(content)) {
				t.Fatalf("download = %s %d %v", sha, n, e)
			}
			if _, _, e = verifyDownload(path, sha, n, expected512); e != nil {
				t.Fatal(e)
			}
			put(t, path, []byte("tampered"))
			if _, _, e = verifyDownload(path, sha, nil, ""); e == nil || !strings.Contains(e.Error(), "SHA-256") {
				t.Fatalf("tamper error = %v", e)
			}
		})
	}
}

func TestArchiveContainmentAndDigestIdentity(t *testing.T) {
	dir := testutil.TempDir(t)
	out := filepath.Join(dir, "out")
	if e := os.MkdirAll(out, 0755); e != nil {
		t.Fatal(e)
	}
	for _, name := range []string{"../escape.txt", "C:/escape.txt", "/escape.txt", "..\\escape.txt"} {
		_, e := trustedMember(out, name)
		if e == nil || !strings.Contains(e.Error(), "escapes extract dir") {
			t.Fatalf("unsafe member %q: %v", name, e)
		}
	}
	var payload bytes.Buffer
	gz := gzip.NewWriter(&payload)
	dataTar := tar.NewWriter(gz)
	for _, name := range []string{"resources/app.asar", "resources/bin/language_server"} {
		if e := dataTar.WriteHeader(&tar.Header{Name: name, Mode: 0600, Size: 3, Typeflag: tar.TypeReg}); e != nil {
			t.Fatal(e)
		}
		if _, e := dataTar.Write([]byte("deb")); e != nil {
			t.Fatal(e)
		}
	}
	if e := dataTar.Close(); e != nil {
		t.Fatal(e)
	}
	if e := gz.Close(); e != nil {
		t.Fatal(e)
	}
	var deb bytes.Buffer
	_, _ = deb.WriteString("!<arch>\n")
	for _, member := range []struct {
		name string
		data []byte
	}{{"debian-binary", []byte("2.0\n")}, {"control.tar.gz", []byte("odd")}, {"data.tar.gz", payload.Bytes()}} {
		fmt.Fprintf(&deb, "%-16s%-12d%-6d%-6d%-8s%-10d`\n", member.name+"/", 0, 0, 0, "100644", len(member.data))
		_, _ = deb.Write(member.data)
		if len(member.data)%2 != 0 {
			deb.WriteByte('\n')
		}
	}
	debPath := filepath.Join(dir, "app.deb")
	put(t, debPath, deb.Bytes())
	debTree, e := extractInstaller(debPath, out, filepath.Join(dir, "tools"), hashBytes(deb.Bytes()))
	if e != nil {
		t.Fatal(e)
	}
	if b, e := os.ReadFile(str(debTree["asar"])); e != nil || string(b) != "deb" {
		t.Fatalf("deb extracted content = %q, %v", b, e)
	}
	path := filepath.Join(dir, "app.zip")
	for _, value := range []string{"build A", "build B"} {
		var buffer bytes.Buffer
		z := zip.NewWriter(&buffer)
		for _, n := range []string{"resources/app.asar", "resources/bin/language_server"} {
			w, e := z.Create(n)
			if e != nil {
				t.Fatal(e)
			}
			_, _ = io.WriteString(w, value)
		}
		if e := z.Close(); e != nil {
			t.Fatal(e)
		}
		put(t, path, buffer.Bytes())
		tree, e := extractInstaller(path, out, filepath.Join(dir, "tools"), hashBytes(buffer.Bytes()))
		if e != nil {
			t.Fatal(e)
		}
		b, e := os.ReadFile(str(tree["asar"]))
		if e != nil || string(b) != value {
			t.Fatalf("digest-bound extraction = %q, %v", b, e)
		}
	}
	var buffer bytes.Buffer
	tr := tar.NewWriter(&buffer)
	if e := tr.WriteHeader(&tar.Header{Name: "escape", Typeflag: tar.TypeSymlink, Linkname: "../outside"}); e != nil {
		t.Fatal(e)
	}
	_ = tr.Close()
	path = filepath.Join(dir, "bad.tar")
	put(t, path, buffer.Bytes())
	if e := extractTAR(path, out, newExtractBudget()); e == nil || !strings.Contains(e.Error(), "link escapes") {
		t.Fatalf("tar symlink escape = %v", e)
	}
	buffer.Reset()
	z := zip.NewWriter(&buffer)
	w, _ := z.Create("../outside")
	_, _ = w.Write([]byte("bad"))
	_ = z.Close()
	path = filepath.Join(dir, "bad.zip")
	put(t, path, buffer.Bytes())
	if e := extractZIP(path, out, newExtractBudget()); e == nil || !strings.Contains(e.Error(), "escapes extract dir") {
		t.Fatalf("zip traversal = %v", e)
	}
	if isFile(filepath.Join(dir, "outside")) {
		t.Fatal("archive escaped extraction root")
	}
}

func TestLocalReportContract(t *testing.T) {
	for _, kind := range []string{"original", "ours-patched", "unknown"} {
		t.Run(kind, func(t *testing.T) {
			root := testutil.TempDir(t)
			checkerInputs(t, root)
			install := filepath.Join(root, "app")
			resources := "resources"
			server := "language_server"
			if runtime.GOOS == "windows" {
				server += ".exe"
			}
			if runtime.GOOS == "darwin" {
				resources = "Resources"
			}
			binaryData := fixture(t, "pe-x64.bin")
			switch kind {
			case "ours-patched":
				body, _ := hex.DecodeString(patchHex)
				copy(binaryData[0x400:], body)
			case "unknown":
				copy(binaryData[0x400:0x480], bytes.Repeat([]byte{0xcc}, 128))
			}
			lsPath := filepath.Join(install, resources, "bin", server)
			put(t, lsPath, binaryData)
			put(t, lsPath+".orig", fixture(t, "pe-x64.bin"))
			put(t, filepath.Join(install, resources, "app.asar"), validAsar(t))
			put(t, filepath.Join(install, "Antigravity.exe"), fuseWireExe(t))
			reports := filepath.Join(root, "reports")
			got, code, e := Run(root, nil, []string{"--reports-dir", reports, "local", "--install-dir", install, "--json"})
			if e != nil {
				t.Fatal(e)
			}
			rep := obj(got)
			if code != 1 || exitCode(rep) != 1 {
				t.Fatalf("exit=%d report=%#v", code, rep)
			}
			saved, e := latestReport(reports)
			if e != nil {
				t.Fatal(e)
			}
			stored, e := readJSON(saved)
			if e != nil {
				t.Fatal(e)
			}
			jsonEqual(t, rep, stored)
			if obj(rep["target"])["ls_sha256"] != hashBytes(binaryData) {
				t.Fatal("report input hash drift")
			}
		})
	}
	dir := testutil.TempDir(t)
	for _, row := range [][2]string{{"z-old.json", "2026-01-01T00:00:00+00:00"}, {"a-new.json", "2026-02-01T00:00:00+00:00"}} {
		if e := writeJSON(filepath.Join(dir, row[0]), object{"generated_at": row[1]}); e != nil {
			t.Fatal(e)
		}
	}
	got, e := latestReport(dir)
	if e != nil || filepath.Base(got) != "a-new.json" {
		t.Fatalf("latest report = %s, %v", got, e)
	}
}

func TestPatchedBodyClassification(t *testing.T) {
	body, _ := hex.DecodeString(patchHex)
	kind, patchLimit := classifyBody(body, nil, "x86-64")
	if kind != "ours-patched" || patchLimit != uint32(500000) {
		t.Fatalf("patch = %s %v", kind, patchLimit)
	}
	for _, offset := range []int{4, 45, 70, 127} {
		changed := bytes.Clone(body)
		changed[offset] ^= 1
		k, l := classifyBody(changed, nil, "x86-64")
		if k != "unknown" || l != nil {
			t.Fatalf("modified patch @%d = %s %v", offset, k, l)
		}
	}
	kind, patchLimit = classifyBody(body, nil, "arm64")
	if kind != "unknown" || patchLimit != nil {
		t.Fatalf("arm64 patch = %s %v", kind, patchLimit)
	}
}

func TestLinkedPatchScreening(t *testing.T) {
	data := fixture(t, "pe-x64.bin")
	im, err := imageText(data)
	if err != nil {
		t.Fatal(err)
	}
	functions, err := locateFunctions(data, []string{funcClamp})
	if err != nil {
		t.Fatal(err)
	}
	f := functions[funcClamp]
	if f == nil || f.Size != 128 || f.Entryoff+128+8 >= im.size-64 {
		t.Fatalf("fixture cannot hold linked patch: function=%+v text=%+v", f, im)
	}
	first, second := im.size-64, im.size-32
	body := linkedPatchTemplate()
	binary.LittleEndian.PutUint32(body[16:20], uint32(first-f.Entryoff-20))
	copy(data[im.offset+f.Entryoff:], body)
	for index, position := range []uint64{first, second} {
		node := data[im.offset+position-8 : im.offset+position+16]
		copy(node[:8], bytes.Repeat([]byte{0xcc}, 8))
		binary.LittleEndian.PutUint32(node[8:12], uint32(1318+index))
		binary.LittleEndian.PutUint32(node[12:16], uint32(300000+index*200000))
		binary.LittleEndian.PutUint32(node[16:20], 0)
		if index == 0 {
			binary.LittleEndian.PutUint32(node[16:20], uint32(second-first))
		}
		copy(node[20:24], "AGL2")
	}
	filename := filepath.Join(testutil.TempDir(t), "linked.bin")
	for _, row := range []struct {
		name string
		edit func([]byte)
		kind string
	}{
		{"valid", nil, "ours-patched"},
		{"duplicate id", func(b []byte) { binary.LittleEndian.PutUint32(b[im.offset+second:], 1318) }, "unknown"},
		{"cycle", func(b []byte) { binary.LittleEndian.PutUint32(b[im.offset+second+8:], ^uint32(31)) }, "unknown"},
		{"missing magic", func(b []byte) { b[im.offset+first+12] = 0 }, "unknown"},
		{"zero limit", func(b []byte) { binary.LittleEndian.PutUint32(b[im.offset+first+4:], 0) }, "unknown"},
		{"out of bounds", func(b []byte) { binary.LittleEndian.PutUint32(b[im.offset+f.Entryoff+16:], 0x7fffffff) }, "unknown"},
		{"changed body", func(b []byte) { b[im.offset+f.Entryoff+40] ^= 1 }, "unknown"},
	} {
		t.Run(row.name, func(t *testing.T) {
			input := bytes.Clone(data)
			if row.edit != nil {
				row.edit(input)
			}
			put(t, filename, input)
			result, err := probeLS(filename, nil)
			if err != nil {
				t.Fatal(err)
			}
			clamp := obj(obj(result["fingerprint"])["clamp"])
			if clamp["kind"] != row.kind {
				t.Fatalf("clamp=%+v", clamp)
			}
			if row.kind == "ours-patched" {
				jsonEqual(t, clamp["model_limits"], []object{{"id": 1318, "limit": 300000}, {"id": 1319, "limit": 500000}})
			}
		})
	}
}

func TestCLIFlagsContract(t *testing.T) {
	o, e := parseOptions("assets", []string{"--json", "--work-dir", "work", "check", "--channel=hub", "--platform", "win-x64", "--platform=linux-x64", "--version", "2.29.0", "--matrix", "--skip-download", "--keep-work", "--reports-dir", "reports"})
	if e != nil {
		t.Fatal(e)
	}
	jsonEqual(t, object{"command": o.command, "work": o.work, "reports": o.reports, "channel": o.channel, "platforms": o.platforms, "version": o.version, "matrix": o.matrix, "skip": o.skip, "keep": o.keep}, object{"command": "check", "work": "work", "reports": "reports", "channel": "hub", "platforms": []string{"win-x64", "linux-x64"}, "version": "2.29.0", "matrix": true, "skip": true, "keep": true})
	for _, args := range [][]string{{"report", "--matrix"}, {"check", "--matrix=false"}, {"local", "--platform", "win-x64"}, {"check", "--channel", "unknown"}, {"versions", "--platform", "unsupported"}, {"report", "--file"}} {
		_, code, err := Run(repoRoot(t), nil, args)
		if code != 3 || err == nil || errorType(err) != "ValueError" {
			t.Fatalf("flags %v: code=%d err=%v", args, code, err)
		}
	}
	for _, args := range [][]string{{"files", "--channel", "hub"}, {"files", "--version", "1"}, {"files", "--platform", "win-x64"}, {"files", "--matrix"}, {"files", "--skip-download"}, {"files", "--install-dir", "client"}, {"check", "--input-dir", "inputs"}} {
		_, code, err := Run(repoRoot(t), nil, args)
		if code != 3 || err == nil || errorType(err) != "ValueError" || !strings.Contains(err.Error(), args[1]+" is not supported by "+args[0]) {
			t.Fatalf("incompatible flags %v: code=%d err=%v", args, code, err)
		}
	}
}

func TestExplicitInstallationProductBinding(t *testing.T) {
	t.Setenv("AGYCTL_APP_DIR", "invalid-relative-root")
	root := testutil.TempDir(t)
	install := filepath.Join(root, "selected")
	platform := runtime.GOOS
	resources := "resources"
	if platform == "windows" {
		platform = "win32"
	}
	if platform == "darwin" {
		resources = "Resources"
	}
	config, err := layout.Load(repoRoot(t), nil)
	if err != nil {
		t.Fatal(err)
	}
	selectedPlatform := config.Platforms[platform]
	selectedPlatform.Channels[0].Root = install
	config.Platforms[platform] = selectedPlatform
	data, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	put(t, filepath.Join(root, "compat", "install-layout.json"), data)
	put(t, filepath.Join(install, resources, "app.asar"), validAsar(t))
	selected, err := findInstall(options{root: root, install: install})
	if err != nil || selected.Channel != "insiders" || selected.Product != "Antigravity - Insiders" {
		t.Fatalf("selected=%+v error=%v", selected, err)
	}
	caseVariant := filepath.Join(root, "SELECTED")
	put(t, filepath.Join(caseVariant, resources, "app.asar"), validAsar(t))
	selected, err = findInstall(options{root: root, install: caseVariant})
	wantProduct := ""
	if runtime.GOOS == "windows" {
		wantProduct = "Antigravity - Insiders"
	}
	if err != nil || selected.Product != wantProduct {
		t.Fatalf("case-variant installation=%+v want product=%q error=%v", selected, wantProduct, err)
	}
	other := filepath.Join(root, "unknown")
	put(t, filepath.Join(other, resources, "app.asar"), validAsar(t))
	selected, err = findInstall(options{root: root, install: other, channel: "insiders"})
	if err != nil || selected.Product != "" {
		t.Fatalf("unknown root inferred product from channel: %+v error=%v", selected, err)
	}
}

func TestLocalDiscoveryRequiresOneInstallation(t *testing.T) {
	root := testutil.TempDir(t)
	config, err := layout.Load(repoRoot(t), nil)
	if err != nil {
		t.Fatal(err)
	}
	platform, err := config.Target(runtime.GOOS, runtime.GOARCH)
	if err != nil {
		t.Fatal(err)
	}
	p := config.Platforms[platform.NodePlatform]
	for index := range p.Channels {
		p.Channels[index].Root = filepath.Join(root, fmt.Sprintf("install-%d", index))
		put(t, filepath.Join(p.Channels[index].Root, p.Resources, "app.asar"), validAsar(t))
	}
	config.Platforms[platform.NodePlatform] = p
	data, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	put(t, filepath.Join(root, "compat", "install-layout.json"), data)
	if _, err = findInstall(options{root: root}); err == nil || !strings.Contains(err.Error(), "multiple Antigravity installations") {
		t.Fatalf("ambiguous discovery error=%v", err)
	}
	selected, err := findInstall(options{root: root, channel: "antigravity"})
	if err != nil || selected.Channel != "antigravity" || selected.Root != p.Channels[1].Root {
		t.Fatalf("channel selection=%+v error=%v", selected, err)
	}
}

func TestLocalizationCapabilityContract(t *testing.T) {
	for _, row := range []struct {
		name, status, matchedIdentity, verdict, delivery string
		missingPreload                                   bool
		code                                             int
	}{
		{"verified ASAR allows changed LS", "verified", "asar", "pass", "available", false, 0},
		{"verified LS allows changed ASAR", "verified", "ls", "pass", "available", false, 0},
		{"probe-only remains advisory", "probe-only", "asar", "warn", "needs-review", false, 1},
		{"unregistered profile remains advisory", "verified", "none", "warn", "needs-review", false, 1},
		{"missing preload fails even with identity", "verified", "asar", "fail", "unavailable", true, 2},
	} {
		t.Run(row.name, func(t *testing.T) {
			path := filepath.Join(testutil.TempDir(t), "app.asar")
			data := validAsar(t)
			if row.missingPreload {
				data = makeAsar(t, map[string][]byte{"package.json": []byte(`{}`)})
			}
			put(t, path, data)
			profile := object{"profileId": "fixture", "status": row.status, "asarSha256": "other-asar", "lsSha256": "other-ls"}
			if row.matchedIdentity == "asar" {
				profile["asarSha256"] = hashBytes(data)
			}
			if row.matchedIdentity == "ls" {
				profile["lsSha256"] = "selected-ls"
			}
			capability, err := probeLocalization(path, "selected-ls", hashBytes(data), []object{profile})
			if err != nil {
				t.Fatal(err)
			}
			caps := object{"context": object{"verdict": "pass"}, "models": object{"verdict": "pass"}, "ui": object{"verdict": "pass"}, "localization": capability}
			report, err := newReport(object{}, caps, object{}, object{})
			if err != nil {
				t.Fatal(err)
			}
			if capability["verdict"] != row.verdict || exitCode(report) != row.code || obj(obj(report["capability_matrix"])["localization_delivery"])["capability"] != row.delivery {
				t.Fatalf("report=%#v", report)
			}
		})
	}
}

func TestLocalVerdictContract(t *testing.T) {
	for _, row := range []struct {
		name                     string
		code                     int
		overall, context, models string
	}{
		{"unregistered-localization", 1, "needs-review", "pass", "pass"},
		{"unknown-body", 1, "needs-review", "warn", "pass"},
		{"missing-model-markers", 2, "incompatible", "pass", "fail"},
		{"truncated-binary", 3, "error", "fail", "fail"},
		{"missing-binary", 3, "error", "fail", "fail"},
	} {
		t.Run(row.name, func(t *testing.T) {
			root := testutil.TempDir(t)
			checkerInputs(t, root)
			resources := "resources"
			server := "language_server"
			if runtime.GOOS == "windows" {
				server += ".exe"
			}
			if runtime.GOOS == "darwin" {
				resources = "Resources"
			}
			install := filepath.Join(root, "app")
			data := fixture(t, "pe-x64.bin")
			switch row.name {
			case "unknown-body":
				copy(data[0x400:0x480], bytes.Repeat([]byte{0xcc}, 128))
			case "missing-model-markers":
				for _, marker := range markerNames {
					data = bytes.ReplaceAll(data, []byte(marker), bytes.Repeat([]byte{'X'}, len(marker)))
				}
			case "truncated-binary":
				data = []byte("MZ")
			}
			if row.name != "missing-binary" {
				put(t, filepath.Join(install, resources, "bin", server), data)
			}
			put(t, filepath.Join(install, resources, "app.asar"), validAsar(t))
			put(t, filepath.Join(install, "Antigravity.exe"), fuseWireExe(t))
			got, code, e := Run(root, nil, []string{"local", "--install-dir", install, "--reports-dir", filepath.Join(root, "reports")})
			if e != nil {
				t.Fatal(e)
			}
			rep := obj(got)
			caps := obj(rep["capabilities"])
			if code != row.code || rep["overall"] != row.overall || obj(caps["context"])["verdict"] != row.context || obj(caps["models"])["verdict"] != row.models || obj(caps["ui"])["verdict"] != "pass" {
				t.Fatalf("local verdict: code=%d report=%#v", code, rep)
			}
			if row.code == 3 {
				errs := objects(rep["errors"])
				expectedType := "SymbolError"
				if row.name == "missing-binary" {
					expectedType = "FileNotFoundError"
					if str(obj(rep["target"])["ls_sha256"]) != "" || obj(rep["target"])["asar_sha256"] != hashBytes(validAsar(t)) {
						t.Fatalf("partial report lost target binding: %#v", rep["target"])
					}
				}
				if len(errs) != 1 || errs[0]["probe"] != "language_server" || errs[0]["type"] != expectedType {
					t.Fatalf("static probe error: %#v", errs)
				}
			}
		})
	}
}

func normalizeReport(rep object, extractRoot string) object {
	// Phase 5 additive report fields (staticHookEvidence, capsuleIntegrity,
	// capability_matrix) are stripped until the golden is regenerated against
	// a real installer: re-run TestCachedInstallerFrozenReport with
	// AGYCTL_CHECK_INSTALLER and AGYCTL_CHECK_TOOLS set and re-pin
	// testdata/check/cached-hub-win-x64.json to include them.
	out := clone(rep)
	caps := clone(obj(out["capabilities"]))
	out["capabilities"] = caps
	if ui := obj(caps["ui"]); ui != nil {
		ui = clone(ui)
		caps["ui"] = ui
		delete(ui, "staticHookEvidence")
		delete(ui, "capsuleIntegrity")
	}
	// The frozen report projection excludes localization; assert its actual
	// capability and exit code separately from the older report projection.
	delete(caps, "localization")
	out["overall"] = aggregate(caps)
	delete(out, "capability_matrix")
	if _, ok := out["report_id"]; ok {
		out["report_id"] = "<REPORT_ID>"
	}
	if _, ok := out["generated_at"]; ok {
		out["generated_at"] = "<GENERATED_AT>"
	}
	if tree, ok := out["tree"].(map[string]any); ok {
		tree = clone(tree)
		for k, v := range tree {
			tree[k] = strings.ReplaceAll(strings.ReplaceAll(str(v), extractRoot, "<EXTRACT_ROOT>"), "\\", "/")
		}
		out["tree"] = tree
	}
	return out
}

func TestCachedInstallerFrozenReport(t *testing.T) {
	installer := os.Getenv("AGYCTL_CHECK_INSTALLER")
	if installer == "" {
		t.Skip("set AGYCTL_CHECK_INSTALLER to the cached Hub 2.29.0 Windows installer; no installer is downloaded")
	}
	tools := os.Getenv("AGYCTL_CHECK_TOOLS")
	if tools == "" {
		t.Skip("set AGYCTL_CHECK_TOOLS to the existing pinned 7-Zip cache")
	}
	expected := fixtureObject(t, "cached-hub-win-x64.json")
	input := fixtureObject(t, "cached-input.json")
	sha, e := hashFile(installer)
	if e != nil {
		t.Fatal(e)
	}
	if sha != input["installer_sha256"] {
		t.Fatalf("installer SHA-256 = %s, want %s", sha, input["installer_sha256"])
	}
	root := repoRoot(t)
	work := filepath.Join(testutil.TempDir(t), "work")
	o, e := parseOptions(root, []string{"check", "--work-dir", work, "--reports-dir", filepath.Join(testutil.TempDir(t), "reports"), "--skip-download", "--keep-work"})
	if e != nil {
		t.Fatal(e)
	}
	target := obj(expected["target"])
	cell := object{"channel": target["channel"], "platform": target["platform"], "version": target["version"], "execution_id": target["execution_id"], "url": target["asset_url"]}
	dest := assetDest(work, cell, filepath.Base(installer))
	if e = os.MkdirAll(filepath.Dir(dest), 0755); e != nil {
		t.Fatal(e)
	}
	src, e := os.Open(installer)
	if e != nil {
		t.Fatal(e)
	}
	dst, e := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		_ = src.Close()
		t.Fatal(e)
	}
	_, copyErr := io.Copy(dst, src)
	srcErr, dstErr := src.Close(), dst.Close()
	for _, err := range []error{copyErr, srcErr, dstErr} {
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, n := range []string{"7zr.exe", "7z2501-extra.7z", filepath.Join("7z-extra", "x64", "7za.exe")} {
		src := filepath.Join(tools, n)
		b, e := os.ReadFile(src)
		if e != nil {
			t.Fatal(e)
		}
		put(t, filepath.Join(work, "tools", n), b)
	}
	if e = upsertArchive(work, cell, dest, sha, num(input["installer_size"])); e != nil {
		t.Fatal(e)
	}
	got, e := checkCell(o, cell)
	if e != nil {
		t.Fatal(e)
	}
	if !regexp.MustCompile(`^[0-9a-f]{32}$`).MatchString(str(got["report_id"])) {
		t.Fatalf("invalid runtime report identity: %v", got["report_id"])
	}
	if _, e := time.Parse(time.RFC3339Nano, str(got["generated_at"])); e != nil {
		t.Fatal(e)
	}
	extractRoot := filepath.Join(work, "extract", "hub-win-x64")
	jsonEqual(t, normalizeReport(got, extractRoot), expected)
	if exitCode(got) != 1 || obj(obj(got["capabilities"])["localization"])["verdict"] != "warn" {
		t.Fatalf("cached report exit = %d", exitCode(got))
	}
	reportPaths, e := filepath.Glob(filepath.Join(o.reports, "*.json"))
	if e != nil || len(reportPaths) != 1 {
		t.Fatalf("saved reports = %v, %v", reportPaths, e)
	}
	saved, e := readJSON(reportPaths[0])
	if e != nil {
		t.Fatal(e)
	}
	jsonEqual(t, got, saved)
}

func TestCheckerInputsComeFromVerifiedSnapshot(t *testing.T) {
	root := testutil.TempDir(t)
	checkerInputs(t, root)
	install := filepath.Join(root, "app")
	resources, server := "resources", "language_server"
	if runtime.GOOS == "windows" {
		server += ".exe"
	}
	if runtime.GOOS == "darwin" {
		resources = "Resources"
	}
	put(t, filepath.Join(install, resources, "bin", server), fixture(t, "pe-x64.bin"))
	put(t, filepath.Join(install, resources, "app.asar"), validAsar(t))
	profilesPath := filepath.Join(root, "compat", "localization", "profiles.json")
	profile := object{"profileId": "snapshot-fixture", "status": "verified", "asarSha256": hashBytes(validAsar(t))}
	if err := writeJSON(profilesPath, object{"schema": 1, "profiles": []object{profile}}); err != nil {
		t.Fatal(err)
	}
	snap, e := assets.Capture(root, "check", "layout")
	if e != nil {
		t.Fatal(e)
	}
	registry := filepath.Join(root, "compat", "versions.json")
	if e = os.Remove(registry); e != nil {
		t.Fatal(e)
	}
	profile["status"] = "probe-only"
	if err := writeJSON(profilesPath, object{"schema": 1, "profiles": []object{profile}}); err != nil {
		t.Fatal(err)
	}
	args := []string{"local", "--install-dir", install, "--reports-dir", filepath.Join(root, "reports")}
	got, _, e := Run(root, snap, args)
	if e != nil {
		t.Fatal(e)
	}
	if clamp := obj(obj(obj(got)["capabilities"])["context"]); clamp["verdict"] != "pass" {
		t.Fatalf("original registry must come from the verified snapshot, not a reread of the removed file: %#v", clamp)
	}
	if cap := obj(obj(obj(got)["capabilities"])["localization"]); cap["verdict"] != "pass" || cap["profileStatus"] != "verified" {
		t.Fatalf("localization did not use captured profiles: %#v", cap)
	}
	if _, code, _ := Run(root, nil, args); code != 3 {
		t.Fatalf("nil snapshot must read the removed registry from disk and fail, exit=%d", code)
	}
}

func TestExtractionFailureCleansScratch(t *testing.T) {
	dir := testutil.TempDir(t)
	work := filepath.Join(dir, "work")
	reports := filepath.Join(dir, "reports")
	var buffer bytes.Buffer
	z := zip.NewWriter(&buffer)
	w, e := z.Create("../outside")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = w.Write([]byte("bad")); e != nil {
		t.Fatal(e)
	}
	if e = z.Close(); e != nil {
		t.Fatal(e)
	}
	cell := object{"channel": "hub", "platform": "win-x64", "version": "2.29.0", "url": "https://feed.example/Antigravity-x64.exe"}
	dest := assetDest(work, cell, "Antigravity-x64.exe")
	put(t, dest, buffer.Bytes())
	sha := hashBytes(buffer.Bytes())
	if e = upsertArchive(work, cell, dest, sha, int64(buffer.Len())); e != nil {
		t.Fatal(e)
	}
	kept := filepath.Join(reports, "retained.json")
	put(t, kept, []byte("{}"))
	o, e := parseOptions(dir, []string{"--work-dir", work, "--reports-dir", reports, "--skip-download", "check"})
	if e != nil {
		t.Fatal(e)
	}
	_, e = checkCell(o, cell)
	if e == nil || errorType(e) != "ExtractError" {
		t.Fatalf("traversal installer must fail extraction, got %v", e)
	}
	if _, err := os.Stat(filepath.Join(work, "extract", "hub-win-x64", sha)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("failed extraction left scratch behind: %v", err)
	}
	if !isFile(dest) {
		t.Fatal("failed extraction removed the cached download kept for --skip-download reuse")
	}
	if b, err := os.ReadFile(kept); err != nil || string(b) != "{}" {
		t.Fatalf("retained report was touched: %q, %v", b, err)
	}
}

func TestDownloadSizeCapAbortsEarly(t *testing.T) {
	payload := bytes.Repeat([]byte{0x41}, 8<<20)
	var written atomic.Int64
	var handlerDone sync.WaitGroup
	handlerDone.Add(1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer handlerDone.Done()
		controller := http.NewResponseController(w)
		for offset := 0; offset < len(payload); offset += 64 << 10 {
			end := offset + 64<<10
			if end > len(payload) {
				end = len(payload)
			}
			if _, e := w.Write(payload[offset:end]); e != nil {
				return
			}
			_ = controller.Flush()
			written.Add(int64(end - offset))
		}
	}))
	defer server.Close()
	path := filepath.Join(testutil.TempDir(t), "installer.zip")
	_, _, e := download(server.URL, path, 1024, "")
	if e == nil || !strings.Contains(e.Error(), "expected size") {
		t.Fatalf("oversized body must abort at the size cap, got %v", e)
	}
	if _, statErr := os.Stat(path); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("oversized download published a file: %v", statErr)
	}
	if _, statErr := os.Stat(path + ".part"); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("oversized download left a partial file: %v", statErr)
	}
	handlerDone.Wait()
	if got := written.Load(); got >= int64(len(payload)) {
		t.Fatalf("size cap did not stop the read early: server sent %d of %d bytes", got, len(payload))
	}
}

func TestDownloadBudgetsStopStallAndBoundTotal(t *testing.T) {
	for _, row := range []struct {
		name    string
		total   time.Duration
		idle    time.Duration
		handler func(w http.ResponseWriter, r *http.Request)
		wantErr string
	}{
		{
			name:  "stalled body aborts within the idle budget",
			total: 10 * time.Second, idle: 200 * time.Millisecond,
			handler: func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write(bytes.Repeat([]byte{1}, 2048))
				controller := http.NewResponseController(w)
				_ = controller.Flush()
				_, _ = w.Write(bytes.Repeat([]byte{2}, 2048))
				_ = controller.Flush()
				<-r.Context().Done()
			},
			wantErr: "no data for",
		},
		{
			name:  "progressing body exceeding the total budget aborts",
			total: 300 * time.Millisecond, idle: 1 * time.Second,
			handler: func(w http.ResponseWriter, r *http.Request) {
				controller := http.NewResponseController(w)
				for i := 0; i < 8; i++ {
					if _, e := w.Write(bytes.Repeat([]byte{3}, 2048)); e != nil {
						return
					}
					_ = controller.Flush()
					time.Sleep(60 * time.Millisecond)
				}
			},
			wantErr: "total budget",
		},
	} {
		t.Run(row.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				row.handler(w, r)
			}))
			defer server.Close()
			dest := filepath.Join(testutil.TempDir(t), "installer.zip")
			put(t, dest, []byte("previous"))
			start := time.Now()
			sha, n, e := downloadBudgeted(server.URL, dest, nil, "", downloadBudgets{total: row.total, idle: row.idle, bytes: downloadByteBudget})
			elapsed := time.Since(start)
			if e == nil || !strings.Contains(e.Error(), row.wantErr) {
				t.Fatalf("error = %v, want %q", e, row.wantErr)
			}
			if sha != "" {
				t.Fatalf("failed download published a verified hash: %s (%d bytes)", sha, n)
			}
			if row.idle < row.total && elapsed > 5*time.Second {
				t.Fatalf("stall was not cut by the idle budget: took %s", elapsed)
			}
			if b, readErr := os.ReadFile(dest); readErr != nil || string(b) != "previous" {
				t.Fatalf("failed download disturbed the destination: %q, %v", b, readErr)
			}
			if _, statErr := os.Stat(dest + ".part"); !errors.Is(statErr, os.ErrNotExist) {
				t.Fatalf("aborted download left a partial file: %v", statErr)
			}
		})
	}
	t.Run("slow but progressing body completes within the total budget", func(t *testing.T) {
		content := bytes.Repeat([]byte{7}, 12<<20)
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			controller := http.NewResponseController(w)
			for offset := 0; offset < len(content); offset += 1 << 20 {
				if _, e := w.Write(content[offset : offset+(1<<20)]); e != nil {
					return
				}
				_ = controller.Flush()
				time.Sleep(40 * time.Millisecond)
			}
		}))
		defer server.Close()
		dest := filepath.Join(testutil.TempDir(t), "installer.zip")
		sha, n, e := downloadBudgeted(server.URL, dest, nil, "", downloadBudgets{total: 10 * time.Second, idle: 1 * time.Second, bytes: downloadByteBudget})
		if e != nil || sha != hashBytes(content) || n != int64(len(content)) {
			t.Fatalf("progressing download = %s %d %v", sha, n, e)
		}
	})
}

func TestDownloadIsBoundedByTheByteBudget(t *testing.T) {
	for _, row := range []struct {
		name    string
		size    any
		handler http.HandlerFunc
		want    string
	}{
		{
			name: "unrecorded size and a streamed body past the budget",
			handler: func(w http.ResponseWriter, r *http.Request) {
				controller := http.NewResponseController(w)
				for i := 0; i < 64; i++ {
					if _, e := w.Write(bytes.Repeat([]byte{1}, 1024)); e != nil {
						return
					}
					_ = controller.Flush()
				}
			},
			want: "byte limit",
		},
		{
			name: "recorded size past the budget is refused before any body is read",
			size: int64(1 << 20),
			handler: func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write([]byte("never read"))
			},
			want: "exceeds the",
		},
	} {
		t.Run(row.name, func(t *testing.T) {
			server := httptest.NewServer(row.handler)
			defer server.Close()
			dest := filepath.Join(testutil.TempDir(t), "installer.zip")
			sha, _, e := downloadBudgeted(server.URL, dest, row.size, "", downloadBudgets{total: 10 * time.Second, idle: time.Second, bytes: 4096})
			if e == nil || !strings.Contains(e.Error(), row.want) || sha != "" {
				t.Fatalf("download = %q, %v; want error containing %q", sha, e, row.want)
			}
			for _, leftover := range []string{dest, dest + ".part"} {
				if _, statErr := os.Stat(leftover); !errors.Is(statErr, os.ErrNotExist) {
					t.Fatalf("refused download left %s: %v", leftover, statErr)
				}
			}
		})
	}
}

func TestDownloadFailureKeepsReusableStoreClean(t *testing.T) {
	payload := bytes.Repeat([]byte{0x42}, 4<<20)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(payload)
	}))
	defer server.Close()
	dir := testutil.TempDir(t)
	work := filepath.Join(dir, "work")
	cell := object{"channel": "hub", "platform": "win-x64", "version": "2.29.0", "url": server.URL + "/Antigravity-x64.exe", "size": 1024}
	o, e := parseOptions(dir, []string{"--work-dir", work, "check"})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = checkCell(o, cell); e == nil {
		t.Fatal("oversized installer must fail the check")
	}
	if _, statErr := os.Stat(filepath.Join(work, "archive.json")); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("failed download published an archive manifest: %v", statErr)
	}
	published := []string{}
	if e = filepath.WalkDir(filepath.Join(work, "downloads"), func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type().IsRegular() {
			published = append(published, path)
		}
		return nil
	}); e != nil && !errors.Is(e, os.ErrNotExist) {
		t.Fatal(e)
	}
	if len(published) != 0 {
		t.Fatalf("failed download published into the reusable store: %v", published)
	}
}

func TestDeepArchivePathsAreRejected(t *testing.T) {
	dir := testutil.TempDir(t)
	out := filepath.Join(dir, "out")
	name := "l0"
	for i := 1; i < 40; i++ {
		name = name + fmt.Sprintf("/l%d", i)
	}
	name += "/resources/app.asar"
	var buffer bytes.Buffer
	z := zip.NewWriter(&buffer)
	w, e := z.Create(name)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = w.Write(validAsar(t)); e != nil {
		t.Fatal(e)
	}
	if e = z.Close(); e != nil {
		t.Fatal(e)
	}
	path := filepath.Join(dir, "app.zip")
	put(t, path, buffer.Bytes())
	if _, e = extractInstaller(path, out, filepath.Join(dir, "tools"), hashBytes(buffer.Bytes())); e == nil || !strings.Contains(e.Error(), "nesting depth") {
		t.Fatalf("deep archive path must be rejected by the depth budget, got %v", e)
	}
}

type extractionWriteFunc func([]byte) (int, error)

func (w extractionWriteFunc) Write(p []byte) (int, error) { return w(p) }

func TestExtractionDeadlineStopsWrites(t *testing.T) {
	for _, row := range []struct {
		name          string
		expiredBefore bool
		written       int
	}{
		{"expired before write", true, 0},
		{"expires during final write", false, 4},
		{"expires during zero-progress write", false, 0},
	} {
		t.Run(row.name, func(t *testing.T) {
			b := newExtractBudget()
			remaining := b.bytes
			if row.expiredBefore {
				b.deadline = time.Time{}
			}
			writes := 0
			dst := extractionWriteFunc(func(p []byte) (int, error) {
				writes++
				b.deadline = time.Time{}
				return row.written, nil
			})
			n, err := io.Copy(budgetWriter{w: dst, b: b}, strings.NewReader("last"))
			if err == nil || errorType(err) != "ExtractError" || !strings.Contains(err.Error(), "elapsed time budget") {
				t.Fatalf("copy after deadline: bytes=%d error=%v", n, err)
			}
			if n != int64(row.written) || b.bytes != remaining-int64(row.written) {
				t.Fatalf("copy accounting: bytes=%d remaining=%d", n, b.bytes)
			}
			if row.expiredBefore && writes != 0 {
				t.Fatalf("expired copy reached the output writer %d times", writes)
			}
		})
	}
}

func TestExtractionBudgetsRejectBombs(t *testing.T) {
	payload := bytes.Repeat([]byte{0}, 64<<20)
	dir := testutil.TempDir(t)
	out := filepath.Join(dir, "out")
	if e := os.MkdirAll(out, 0755); e != nil {
		t.Fatal(e)
	}
	for _, row := range []struct {
		name   string
		budget *extractBudget
		want   string
	}{
		{name: "per-entry cap", budget: func() *extractBudget { b := newExtractBudget(); b.maxEntry = 1 << 20; return b }(), want: "per-entry bytes budget"},
		{name: "expanded bytes cap", budget: func() *extractBudget { b := newExtractBudget(); b.maxEntry = 128 << 20; b.bytes = 1 << 20; return b }(), want: "expanded bytes budget"},
		{name: "elapsed time cap", budget: func() *extractBudget {
			b := newExtractBudget()
			b.maxEntry = 128 << 20
			b.bytes = 128 << 20
			b.deadline = time.Now().Add(-time.Second)
			return b
		}(), want: "elapsed time budget"},
	} {
		t.Run(row.name, func(t *testing.T) {
			rowOut := filepath.Join(dir, "row-"+strings.ReplaceAll(row.name, " ", "-"))
			if e := os.MkdirAll(rowOut, 0755); e != nil {
				t.Fatal(e)
			}
			var buffer bytes.Buffer
			z := zip.NewWriter(&buffer)
			w, e := z.Create("resources/app.asar")
			if e != nil {
				t.Fatal(e)
			}
			if _, e = w.Write(payload); e != nil {
				t.Fatal(e)
			}
			if e = z.Close(); e != nil {
				t.Fatal(e)
			}
			path := filepath.Join(dir, row.name+".zip")
			put(t, path, buffer.Bytes())
			if e = extractZIP(path, rowOut, row.budget); e == nil || !strings.Contains(e.Error(), row.want) {
				t.Fatalf("budget %s: error = %v, want %q", row.name, e, row.want)
			}
			if isFile(filepath.Join(rowOut, "resources", "app.asar")) {
				t.Fatalf("budget %s wrote payload bytes before refusing", row.name)
			}
		})
	}
	t.Run("entry budget stops mid-archive", func(t *testing.T) {
		var buffer bytes.Buffer
		z := zip.NewWriter(&buffer)
		for _, n := range []string{"resources/app.asar", "resources/bin/language_server", "extra1", "extra2"} {
			w, e := z.Create(n)
			if e != nil {
				t.Fatal(e)
			}
			if _, e = w.Write([]byte("data")); e != nil {
				t.Fatal(e)
			}
		}
		if e := z.Close(); e != nil {
			t.Fatal(e)
		}
		path := filepath.Join(dir, "entries.zip")
		put(t, path, buffer.Bytes())
		b := newExtractBudget()
		b.entries = 3
		if e := extractZIP(path, out, b); e == nil || !strings.Contains(e.Error(), "entry budget") {
			t.Fatalf("entry overflow error = %v", e)
		}
	})
	t.Run("tar header declaring a bomb size is refused before reading data", func(t *testing.T) {
		path := filepath.Join(dir, "huge.tar.gz")
		put(t, path, declaredHugeTarGz(t, 3<<30))
		b := newExtractBudget()
		if e := extractTAR(path, out, b); e == nil || !strings.Contains(e.Error(), "per-entry bytes budget") {
			t.Fatalf("declared bomb size error = %v", e)
		}
	})
	t.Run("tar EOF checks the elapsed time budget", func(t *testing.T) {
		var buffer bytes.Buffer
		if e := tar.NewWriter(&buffer).Close(); e != nil {
			t.Fatal(e)
		}
		path := filepath.Join(dir, "empty.tar")
		put(t, path, buffer.Bytes())
		b := newExtractBudget()
		b.deadline = time.Time{}
		if e := extractTAR(path, out, b); e == nil || errorType(e) != "ExtractError" || !strings.Contains(e.Error(), "elapsed time budget") {
			t.Fatalf("expired tar EOF error = %v", e)
		}
	})
}

func TestBudgetFailureCleansScratch(t *testing.T) {
	dir := testutil.TempDir(t)
	work := filepath.Join(dir, "work")
	reports := filepath.Join(dir, "reports")
	cell := object{"channel": "hub", "platform": "win-x64", "version": "2.29.0", "url": "https://feed.example/Antigravity.tar.gz"}
	dest := assetDest(work, cell, "Antigravity.tar.gz")
	put(t, dest, declaredHugeTarGz(t, 3<<30))
	sha := hashBytes(mustRead(t, dest))
	if e := upsertArchive(work, cell, dest, sha, mustSize(t, dest)); e != nil {
		t.Fatal(e)
	}
	o, e := parseOptions(dir, []string{"--work-dir", work, "--reports-dir", reports, "--skip-download", "check"})
	if e != nil {
		t.Fatal(e)
	}
	_, e = checkCell(o, cell)
	if e == nil || errorType(e) != "ExtractError" || !strings.Contains(e.Error(), "per-entry bytes budget") {
		t.Fatalf("budget failure must surface the specific limit, got %v", e)
	}
	if _, statErr := os.Stat(filepath.Join(work, "extract", "hub-win-x64", sha)); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("budget failure left scratch behind: %v", statErr)
	}
	if !isFile(dest) {
		t.Fatal("budget failure removed the cached download kept for --skip-download reuse")
	}
}
func TestSevenListingPreflightAndWatchdog(t *testing.T) {
	listing := "----------\nPath = resources/app.asar\nSize = 50\nPath = resources/bin/language_server.exe\nSize = 60\n"
	b := newExtractBudget()
	if _, e := checkSevenListing(listing, "out", b); e != nil {
		t.Fatal(e)
	}
	if b.entries != newExtractBudget().entries-2 {
		t.Fatalf("listing preflight did not charge entries: %d", b.entries)
	}
	b = newExtractBudget()
	b.bytes = 100
	if _, e := checkSevenListing(listing, "out", b); e == nil || !strings.Contains(e.Error(), "expanded bytes budget") {
		t.Fatalf("listing byte charge error = %v", e)
	}
	b = newExtractBudget()
	b.entries = 1
	if _, e := checkSevenListing(listing, "out", b); e == nil || !strings.Contains(e.Error(), "entry budget") {
		t.Fatalf("listing entry charge error = %v", e)
	}
	b = newExtractBudget()
	if _, e := checkSevenListing("----------\nPath = a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u/v/w/x/y/aa/ab/deep\nSize = 1\n", "out", b); e == nil || !strings.Contains(e.Error(), "nesting depth") {
		t.Fatalf("listing depth error = %v", e)
	}
	if _, e := checkSevenListing("----------\nPath = resources/link\nSymbolic Link = ../outside\n", "out", newExtractBudget()); e == nil || !strings.Contains(e.Error(), "unsupported links") {
		t.Fatalf("listing link error = %v", e)
	}
	t.Run("watchdog cancels the process when output grows past the budget", func(t *testing.T) {
		dir := testutil.TempDir(t)
		out := filepath.Join(dir, "out")
		if e := os.MkdirAll(out, 0755); e != nil {
			t.Fatal(e)
		}
		if e := os.WriteFile(filepath.Join(out, "blob"), bytes.Repeat([]byte{0}, 16<<20), 0600); e != nil {
			t.Fatal(e)
		}
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		exceeded := make(chan struct{})
		var recorded int64
		stop := watchExtractedBytes(ctx, out, 1<<20, func(size int64) { recorded = size; exceeded <- struct{}{} })
		defer stop()
		select {
		case <-exceeded:
		case <-ctx.Done():
			t.Fatal("watchdog never fired")
		case <-time.After(5 * time.Second):
			t.Fatal("watchdog did not react within its polling window")
		}
		if recorded < 16<<20 {
			t.Fatalf("watchdog size = %d", recorded)
		}
		cancel()
		stop()
	})
	t.Run("capped output capture fails visibly", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		sink := newCappedSink(cancel, 16)
		for i := 0; i < 4; i++ {
			if _, e := sink.Write(bytes.Repeat([]byte{0}, 8)); e == nil && i > 1 {
				t.Fatalf("capped sink accepted more than its limit at chunk %d", i)
			}
		}
		if sink.err == nil {
			t.Fatal("capped sink did not record the overflow")
		}
		if ctx.Err() == nil {
			t.Fatal("capped sink did not cancel the command context")
		}
	})
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	b, e := os.ReadFile(path)
	if e != nil {
		t.Fatal(e)
	}
	return b
}

func mustSize(t *testing.T, path string) int64 {
	t.Helper()
	info, e := os.Stat(path)
	if e != nil {
		t.Fatal(e)
	}
	return info.Size()
}

func declaredHugeTarGz(t *testing.T, declared int64) []byte {
	t.Helper()
	header := make([]byte, 512)
	copy(header, "huge.bin")
	copy(header[124:136], fmt.Sprintf("%011o\x00", declared))
	header[156] = '0'
	space := bytes.Clone(header)
	for i := 148; i < 156; i++ {
		space[i] = ' '
	}
	checksum := 0
	for _, b := range space {
		checksum += int(b)
	}
	copy(header[148:156], fmt.Sprintf("%06o\x00 ", checksum))
	tarball := append(header, []byte("deb\n")...)
	tarball = append(tarball, make([]byte, 1024)...)
	var buffer bytes.Buffer
	gz := gzip.NewWriter(&buffer)
	if _, e := gz.Write(tarball); e != nil {
		t.Fatal(e)
	}
	if e := gz.Close(); e != nil {
		t.Fatal(e)
	}
	return buffer.Bytes()
}

func TestCapabilityMatrixDistinguishesRejectionReasons(t *testing.T) {
	known := testOriginals(t)
	for _, row := range []struct {
		name        string
		want        string
		wantReason  string
		fingerprint object
	}{
		{name: "macho container", fingerprint: object{"arch": "x86-64", "format": "macho", "clamp": object{"kind": "original", "size": 128, "body_sha256": hashBytes(known[0])}}, want: "blocked", wantReason: "unsupported binary format (limit patcher supports PE and ELF); probed macho"},
		{name: "unsupported architecture", fingerprint: object{"arch": "mips", "clamp": object{"kind": "original", "size": 128, "body_sha256": "x"}}, want: "blocked", wantReason: "unsupported architecture (limit patcher supports x86-64)"},
		{name: "elf container with matching bytes", fingerprint: object{"arch": "x86-64", "format": "elf", "clamp": object{"kind": "original", "size": 128, "body_sha256": hashBytes(known[0])}}, want: "available", wantReason: "recorded original bytes"},
		{name: "arm64 original bytes", fingerprint: object{"arch": "arm64", "clamp": object{"kind": "original", "size": 144, "body_sha256": "x"}}, want: "blocked", wantReason: "unsupported architecture"},
		{name: "arm64 clamp with x86 size", fingerprint: object{"arch": "arm64", "clamp": object{"kind": "original", "size": 128, "body_sha256": "x"}}, want: "blocked", wantReason: "unsupported architecture"},
		{name: "unknown function bytes", fingerprint: object{"arch": "x86-64", "clamp": object{"kind": "unknown", "size": 128, "body_sha256": "x"}}, want: "blocked", wantReason: "unknown function bytes"},
		{name: "recorded original bytes", fingerprint: object{"arch": "x86-64", "clamp": object{"kind": "original", "size": 128, "body_sha256": hashBytes(known[0])}}, want: "available", wantReason: "recorded original bytes"},
		{name: "already patched", fingerprint: object{"arch": "x86-64", "clamp": object{"kind": "ours-patched", "size": 128, "body_sha256": "x"}}, want: "available", wantReason: "already patched"},
	} {
		t.Run(row.name, func(t *testing.T) {
			caps := object{"context": object{"verdict": "pass", "checks": []string{}}, "models": object{"verdict": "pass", "checks": []string{}}, "ui": object{"verdict": "pass", "checks": []string{}}}
			rep, e := newReport(object{"source": "local"}, caps, object{}, object{"fingerprint": row.fingerprint})
			if e != nil {
				t.Fatal(e)
			}
			matrix := obj(rep["capability_matrix"])
			patching := obj(matrix["limit_patching"])
			if patching["capability"] != row.want || !strings.Contains(str(patching["reason"]), row.wantReason) {
				t.Fatalf("limit_patching row = %#v, want %s with %q", patching, row.want, row.wantReason)
			}
			if !strings.Contains(str(matrix["version_label_note"]), "regardless of its version label") {
				t.Fatalf("version label note missing: %#v", matrix)
			}
		})
	}
	t.Run("monitoring and inspection rows", func(t *testing.T) {
		caps := object{"context": object{"verdict": "fail", "checks": []string{}, "error": object{"message": "context patch target unavailable"}}, "models": object{"verdict": "pass", "checks": []string{}}, "ui": object{"verdict": "pass", "checks": []string{}}}
		rep, e := newReport(object{"source": "feed", "platform": "win-x64", "version": "2.29.0", "asset_url": "https://feed.example/Antigravity-x64.exe"}, caps, object{}, object{"fingerprint": object{"arch": "x86-64", "clamp": object{"kind": "original", "size": 128}}})
		if e != nil {
			t.Fatal(e)
		}
		matrix := obj(rep["capability_matrix"])
		if obj(matrix["read_only_monitoring"])["capability"] != "available" {
			t.Fatalf("monitoring row = %#v", matrix["read_only_monitoring"])
		}
		if obj(matrix["installer_inspection"])["capability"] != "available" {
			t.Fatalf("inspection row = %#v", matrix["installer_inspection"])
		}
		if matrix["platform"] != "win-x64" || matrix["arch"] != "x86-64" {
			t.Fatalf("matrix dims = %#v", matrix)
		}
		local, e := newReport(object{"source": "local"}, caps, object{}, object{"fingerprint": object{"arch": "x86-64", "clamp": object{"kind": "original", "size": 128}}})
		if e != nil {
			t.Fatal(e)
		}
		if obj(obj(local["capability_matrix"])["installer_inspection"])["capability"] != "not-applicable" {
			t.Fatalf("local inspection row = %#v", obj(local["capability_matrix"])["installer_inspection"])
		}
	})
	t.Run("monitoring row on a failed probe stays unknown with the reason", func(t *testing.T) {
		failed := object{"verdict": "fail", "checks": []string{"SymbolError: truncated binary"}, "error": object{"probe": "language_server", "type": "SymbolError", "message": "truncated binary"}}
		caps := object{"context": failed, "models": failed, "ui": object{"verdict": "pass", "checks": []string{}}}
		rep, e := newReport(object{"source": "local"}, caps, object{}, object{"fingerprint": object{}})
		if e != nil {
			t.Fatal(e)
		}
		monitoring := obj(obj(rep["capability_matrix"])["read_only_monitoring"])
		if monitoring["capability"] != "unknown" || !strings.Contains(str(monitoring["reason"]), "truncated binary") {
			t.Fatalf("monitoring row = %#v", monitoring)
		}
	})
}

func fuseWireBytes(states map[int]byte) []byte {
	wire := []byte(fuseSentinel)
	wire = append(wire, 1, 8)
	for i := 0; i < 8; i++ {
		wire = append(wire, states[i])
	}
	return wire
}

func TestCapsuleIntegrityBlockedWhenAsarFuseEnabled(t *testing.T) {
	for _, row := range []struct {
		name           string
		integrity      byte
		wantVerdict    string
		wantFuseState  string
		wantCapVerdict string
	}{
		{name: "enabled integrity blocks capsule modification", integrity: '1', wantVerdict: "blocked", wantFuseState: "enabled", wantCapVerdict: "fail"},
		{name: "disabled integrity allows qualification", integrity: '0', wantVerdict: "allowed", wantFuseState: "disabled", wantCapVerdict: "pass"},
	} {
		t.Run(row.name, func(t *testing.T) {
			root := testutil.TempDir(t)
			checkerInputs(t, root)
			install := filepath.Join(root, "app")
			server := "language_server"
			if runtime.GOOS == "windows" {
				server += ".exe"
			}
			put(t, filepath.Join(install, "resources", "bin", server), fixture(t, "pe-x64.bin"))
			put(t, filepath.Join(install, "resources", "app.asar"), validAsar(t))
			put(t, filepath.Join(install, "Antigravity.exe"), fuseWireBytes(map[int]byte{0: '1', 1: 'r', 2: 'r', 3: '0', 4: row.integrity, 5: 'r', 6: 'r', 7: 'r'}))
			got, code, e := Run(root, nil, []string{"local", "--install-dir", install, "--reports-dir", filepath.Join(root, "reports")})
			if e != nil {
				t.Fatal(e)
			}
			rep := obj(got)
			ui := obj(obj(rep["capabilities"])["ui"])
			integrity, present := ui["capsuleIntegrity"].(map[string]any)
			if !present {
				t.Fatalf("fuse qualification missing from ui capability: %#v", ui)
			}
			if integrity["verdict"] != row.wantVerdict || obj(integrity["fuses"])["asar_integrity"] != row.wantFuseState {
				t.Fatalf("fuse qualification = %#v", integrity)
			}
			if ui["verdict"] != row.wantCapVerdict {
				t.Fatalf("ui verdict = %v, want %v", ui["verdict"], row.wantCapVerdict)
			}
			matrix := obj(rep["capability_matrix"])
			injection := obj(matrix["capsule_injection"])
			if row.wantVerdict == "blocked" && injection["capability"] != "blocked" {
				t.Fatalf("capsule injection row = %#v", injection)
			}
			if row.integrity == '1' && exitCode(rep) != 2 {
				t.Fatalf("blocked capsule modification must yield incompatible exit, got %d", code)
			}
		})
	}
}

func TestFuseWireParsing(t *testing.T) {
	for _, row := range []struct {
		name        string
		data        []byte
		wantVerdict string
		wantState   string
		wantFound   bool
	}{
		{name: "enabled integrity", data: append([]byte("MZ"), fuseWireBytes(map[int]byte{0: '1', 1: '0', 2: '0', 3: '0', 4: '1', 5: '0', 6: '0', 7: '0'})...), wantVerdict: "blocked", wantState: "enabled", wantFound: true},
		{name: "disabled integrity", data: append([]byte("MZ"), fuseWireBytes(map[int]byte{0: '0', 1: '0', 2: '0', 3: '1', 4: '0', 5: '0', 6: '0', 7: '0'})...), wantVerdict: "allowed", wantState: "disabled", wantFound: true},
		{name: "removed integrity fuse", data: append([]byte("MZ"), fuseWireBytes(map[int]byte{0: '1', 1: '0', 2: '0', 3: '0', 4: 'r', 5: '0', 6: '0', 7: '0'})...), wantVerdict: "allowed", wantState: "removed", wantFound: true},
		{name: "unknown state byte", data: append([]byte("MZ"), fuseWireBytes(map[int]byte{0: '1', 1: '0', 2: '0', 3: '0', 4: 'x', 5: '0', 6: '0', 7: '0'})...), wantVerdict: "needs-review", wantState: "unknown", wantFound: true},
		{name: "truncated wire", data: append([]byte("MZ"), []byte(fuseSentinel+"\x01\x08\x31\x30")...), wantVerdict: "needs-review", wantFound: true},
		{name: "sentinel missing", data: []byte("MZ no fuse wire here"), wantVerdict: "needs-review", wantFound: false},
	} {
		t.Run(row.name, func(t *testing.T) {
			report := parseFuseWire(row.data)
			if report["wire_found"] != row.wantFound || report["verdict"] != row.wantVerdict {
				t.Fatalf("report = %#v", report)
			}
			if row.wantFound && row.wantState != "" && obj(report["fuses"])["asar_integrity"] != row.wantState {
				t.Fatalf("asar integrity state = %#v, want %s", report["fuses"], row.wantState)
			}
			if row.wantFound && row.wantVerdict == "allowed" && obj(report["fuses"])["run_as_node"] == "enabled" {
				fuses := obj(report["fuses"])
				if fuses["node_cli_inspect"] == nil {
					t.Fatalf("node cli inspect capability missing: %#v", fuses)
				}
			}
		})
	}
	t.Run("streamed scan finds the wire past the first window", func(t *testing.T) {
		pad := bytes.Repeat([]byte{0x90}, 3<<20)
		data := append(append(bytes.Clone(pad), fuseWireBytes(map[int]byte{0: '1', 1: '0', 2: '0', 3: '0', 4: '0', 5: '0', 6: '0', 7: '0'})...), pad...)
		dir := testutil.TempDir(t)
		path := filepath.Join(dir, "Antigravity.exe")
		put(t, path, data)
		if e := os.WriteFile(filepath.Join(dir, "small.txt"), []byte("junk"), 0600); e != nil {
			t.Fatal(e)
		}
		report, found := qualifyCapsuleIntegrity(dir)
		if !found || report["verdict"] != "allowed" || report["executable"] != path {
			t.Fatalf("scan report = %#v (%v)", report, found)
		}
		if _, found = qualifyCapsuleIntegrity(filepath.Join(dir, "empty")); found {
			t.Fatal("directory without executables must report no qualification target")
		}
	})
}
