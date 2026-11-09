package check

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf8"
)

type asarArchive struct {
	path   string
	header object
	base   int64
}

func openAsar(path string) (*asarArchive, error) {
	f, e := os.Open(path)
	if e != nil {
		return nil, failure("AsarError", "cannot open %s: %s", path, e)
	}
	defer func() { _ = f.Close() }()
	pre := make([]byte, 16)
	if _, e = io.ReadFull(f, pre); e != nil {
		return nil, failure("AsarError", "truncated asar header: %s", path)
	}
	size := int64(binary.LittleEndian.Uint32(pre[12:]))
	stat, e := f.Stat()
	if e != nil {
		return nil, e
	}
	if size > stat.Size()-16 {
		return nil, failure("AsarError", "truncated asar json header")
	}
	raw := make([]byte, size)
	if _, e = io.ReadFull(f, raw); e != nil {
		return nil, failure("AsarError", "truncated asar json header")
	}
	var header object
	if !utf8.Valid(raw) {
		return nil, failure("AsarError", "bad asar json header: invalid UTF-8")
	}
	if e = json.Unmarshal(raw, &header); e != nil {
		return nil, failure("AsarError", "bad asar json header: %s", e)
	}
	if _, ok := header["files"].(map[string]any); !ok {
		return nil, failure("AsarError", "asar header has no files entry")
	}
	return &asarArchive{path, header, 16 + size + (4-size%4)%4}, nil
}
func (a *asarArchive) node(name string) object {
	node := a.header
	for _, part := range strings.Split(name, "/") {
		if part == "" {
			continue
		}
		v, ok := obj(node["files"])[part]
		if !ok {
			return nil
		}
		node, ok = v.(map[string]any)
		if !ok {
			return nil
		}
	}
	return node
}
func (a *asarArchive) read(name string) ([]byte, error) {
	n := a.node(name)
	if n == nil {
		return nil, failure("AsarError", "no such member: %s", name)
	}
	if _, ok := n["files"]; ok {
		return nil, failure("AsarError", "%s is a directory", name)
	}
	if n["unpacked"] == true {
		dest, e := trustedMember(a.path+".unpacked", name)
		if e != nil {
			return nil, e
		}
		return os.ReadFile(dest)
	}
	off, e := strconv.ParseInt(str(n["offset"]), 10, 64)
	if e != nil || off < 0 {
		return nil, failure("AsarError", "invalid offset for member %s", name)
	}
	sizeValue, ok := n["size"].(float64)
	if !ok || sizeValue < 0 || sizeValue != float64(int64(sizeValue)) {
		return nil, failure("AsarError", "invalid size for member %s", name)
	}
	size := int64(sizeValue)
	f, e := os.Open(a.path)
	if e != nil {
		return nil, e
	}
	defer func() { _ = f.Close() }()
	stat, e := f.Stat()
	if e != nil {
		return nil, e
	}
	if size < 0 || a.base > stat.Size() || off > stat.Size()-a.base || size > stat.Size()-a.base-off {
		return nil, failure("AsarError", "truncated member %s", name)
	}
	b := make([]byte, size)
	_, e = f.ReadAt(b, a.base+off)
	if e != nil {
		return nil, failure("AsarError", "truncated member %s", name)
	}
	return b, nil
}

func probeAsar(path, unpacked string) (object, error) {
	a, e := openAsar(path)
	if e != nil {
		return object{"verdict": "fail", "checks": []string{"app.asar unreadable: " + e.Error()}, "app": nil, "staticHookEvidence": object{"present": false, "observed_via": "static dist/preload.js text", "markers": object{}}}, nil
	}
	checks := []string{}
	verdict := "pass"
	var app any
	if a.node("package.json") == nil {
		checks = append(checks, "package.json missing from asar")
		verdict = "fail"
	} else {
		b, e := a.read("package.json")
		if e != nil && errorType(e) != "AsarError" {
			return nil, e
		}
		var pkg object
		if e == nil && !utf8.Valid(b) {
			e = failure("UnicodeDecodeError", "invalid UTF-8 package.json")
		}
		if e == nil {
			e = json.Unmarshal(b, &pkg)
		}
		if e != nil {
			checks = append(checks, "package.json unreadable: "+e.Error())
			verdict = "fail"
		} else {
			app = object{"name": pkg["name"], "version": pkg["version"], "main": pkg["main"]}
			checks = append(checks, fmt.Sprintf("package.json: name=%s version=%s main=%s", py(pkg["name"]), py(pkg["version"]), py(pkg["main"])))
		}
	}
	if a.node("dist/main.js") != nil {
		checks = append(checks, "dist/main.js present")
	} else {
		checks = append(checks, "dist/main.js missing")
		verdict = "fail"
	}
	if a.node("dist/preload.js") == nil {
		return object{"verdict": "fail", "checks": append(checks, "dist/preload.js missing — capsule hook has no injection point"), "app": app, "staticHookEvidence": object{"present": false, "observed_via": "static dist/preload.js text", "markers": object{}}}, nil
	}
	code, e := a.read("dist/preload.js")
	if e != nil {
		if errorType(e) != "AsarError" {
			return nil, e
		}
		return object{"verdict": "fail", "checks": append(checks, "dist/preload.js unreadable: "+e.Error()), "app": app, "staticHookEvidence": object{"present": false, "observed_via": "static dist/preload.js text", "markers": object{}}}, nil
	}
	missing := []string{}
	markers := object{}
	for _, n := range []string{"webFrame", "executeJavaScript"} {
		present := strings.Contains(string(code), n)
		markers[n] = present
		if !present {
			missing = append(missing, n)
		}
	}
	staticEvidence := object{"present": len(missing) == 0, "observed_via": "static dist/preload.js text", "markers": markers}
	if len(missing) > 0 {
		checks = append(checks, "dist/preload.js lacks "+strings.Join(missing, ", ")+" — webFrame.executeJavaScript hook surface gone")
		verdict = "fail"
	} else {
		checks = append(checks, "dist/preload.js exposes the webFrame.executeJavaScript hook surface")
	}
	if unpacked != "" && isDir(unpacked) {
		count := 0
		err := filepath.WalkDir(unpacked, func(path string, d os.DirEntry, e error) error {
			if e != nil {
				return e
			}
			if !d.IsDir() {
				info, e := d.Info()
				if e != nil {
					return e
				}
				if info.Mode().IsRegular() {
					count++
				}
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
		checks = append(checks, fmt.Sprintf(".unpacked sidecar present (%d files) — repack unpack options rebuildable", count))
	} else {
		checks = append(checks, "no .unpacked sidecar (repack would run without unpack options)")
	}
	// The live probes of this checker cannot observe the capsule actually
	// mounting or activating in a running client, so liveMountingEvidence and
	// activation stay absent (= unknown); static hook text alone must never
	// read as an activation claim.
	checks = append(checks, "activation evidence: unknown — hook text is static; live mounting is not observable by this probe")
	return object{"verdict": verdict, "checks": checks, "app": app, "staticHookEvidence": staticEvidence}, nil
}
