package check

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"agyctl/internal/testutil"
)

func TestLocalInstallerFilesBatch(t *testing.T) {
	root := testutil.TempDir(t)
	checkerInputs(t, root)
	input := filepath.Join(root, "var", "update-check", "inputs")
	work := filepath.Join(root, "var", "update-check", "work")
	store := filepath.Join(root, "compat", "versions.json")
	registryBefore := mustRead(t, store)
	paths := []string{filepath.Join(input, "00-invalid.zip")}
	put(t, paths[0], []byte("not a zip archive"))
	for _, row := range []struct{ dir, fixture string }{
		{"a-linux-x64", "pe-x64.bin"},
		{"b-windows-x64", "elf-x64.bin"},
	} {
		var buffer bytes.Buffer
		archive := zip.NewWriter(&buffer)
		server := fixture(t, row.fixture)
		if bytes.HasPrefix(server, []byte("\x7fELF")) {
			base := bytes.Index(server, []byte{0xf1, 0xff, 0xff, 0xff, 0, 0})
			binary.LittleEndian.PutUint64(server[base+24:], 0x1000)
		}
		for _, member := range []struct {
			path string
			data []byte
		}{
			{"resources/app.asar", validAsar(t)},
			{"resources/bin/language_server", server},
			{"Antigravity.exe", fuseWireExe(t)},
		} {
			writer, e := archive.Create(member.path)
			if e != nil {
				t.Fatal(e)
			}
			if _, e = writer.Write(member.data); e != nil {
				t.Fatal(e)
			}
		}
		if e := archive.Close(); e != nil {
			t.Fatal(e)
		}
		path := filepath.Join(input, row.dir, "Antigravity.zip")
		put(t, path, buffer.Bytes())
		paths = append(paths, path)
	}
	before := map[string][]byte{}
	for _, path := range paths {
		before[path] = mustRead(t, path)
	}
	got, code, e := Run(root, nil, []string{"files"})
	if e != nil {
		t.Fatal(e)
	}
	batch := obj(got)
	results, reports := objects(batch["results"]), objects(batch["reports"])
	if code != 3 || num(batch["exit"]) != 3 || len(results) != 3 || len(reports) != 3 {
		t.Fatalf("batch result code=%d result=%#v", code, batch)
	}
	for i, row := range results {
		path := paths[i]
		if row["asset_path"] != path || obj(reports[i]["target"])["asset_path"] != path || row["asset_sha256"] != hashBytes(before[path]) || num(row["asset_size"]) != int64(len(before[path])) {
			t.Fatalf("input identity/order lost: %#v", row)
		}
		if !bytes.Equal(mustRead(t, path), before[path]) {
			t.Fatalf("input changed: %s", path)
		}
		saved, e := readJSON(str(row["report_path"]))
		if e != nil {
			t.Fatal(e)
		}
		jsonEqual(t, saved, reports[i])
		if _, found := reports[i]["live"]; found {
			t.Fatal("offline files command included live probes")
		}
		target := obj(reports[i]["target"])
		if target["source"] != "file" || target["channel"] != nil || target["asset_url"] != nil {
			t.Fatalf("local file received fabricated release metadata: %#v", target)
		}
		inspection := obj(reports[i]["installer_inspection"])
		if inspection["input_unchanged"] != true || inspection["publisher_authentication"] != "not-verified" {
			t.Fatalf("local input identity was mistaken for publisher authentication: %#v", inspection)
		}
		matrix := obj(reports[i]["capability_matrix"])
		if i == 0 {
			errs := objects(reports[i]["errors"])
			if row["overall"] != "error" || num(row["exit"]) != 3 || len(errs) != 1 || errs[0]["probe"] != "installer" || errs[0]["type"] != "ExtractError" || errs[0]["message"] != "zip extraction failed: zip: not a valid zip file" || obj(matrix["installer_inspection"])["capability"] != "unavailable" {
				t.Fatalf("invalid archive not represented as its own error: %#v", reports[i])
			}
			continue
		}
		platform := []string{"", "win-x64", "linux-x64"}[i]
		// Capability follows executable bytes, not the enclosing directory name.
		wantPatch := []string{"", "available", "available"}[i]
		maxExit := []int64{3, 2, 1}[i]
		if row["platform"] != platform || row["version"] != "1" || num(row["exit"]) > maxExit || obj(matrix["installer_inspection"])["capability"] != "available" || obj(matrix["limit_patching"])["capability"] != wantPatch {
			t.Fatalf("container/architecture inference or capability isolation failed: %#v", reports[i])
		}
	}
	if !bytes.Equal(mustRead(t, store), registryBefore) {
		t.Fatal("offline files check changed the original-byte registry")
	}
	if _, e := os.Stat(filepath.Join(work, "archive.json")); !errors.Is(e, os.ErrNotExist) {
		t.Fatalf("offline files check wrote a feed cache record: %v", e)
	}
	entries, e := os.ReadDir(filepath.Join(work, "extract", "files"))
	if e != nil || len(entries) != 0 {
		t.Fatalf("scratch cleanup failed: %v, %v", entries, e)
	}

}

func TestLocalInstallerFilesRejectsMissingEmptyAndOverlappingDirectories(t *testing.T) {
	root := testutil.TempDir(t)
	checkerInputs(t, root)
	input := filepath.Join(root, "inputs")
	args := []string{"files", "--input-dir", input}
	_, code, e := Run(root, nil, args)
	if code != 3 || !errors.Is(e, os.ErrNotExist) {
		t.Fatalf("missing input directory: code=%d error=%v", code, e)
	}
	if e := os.MkdirAll(input, 0755); e != nil {
		t.Fatal(e)
	}
	_, code, e = Run(root, nil, args)
	if code != 3 || e == nil || errorType(e) != "FileNotFoundError" || !strings.Contains(e.Error(), "no supported installer files") {
		t.Fatalf("empty input directory: code=%d error=%v", code, e)
	}
	path := filepath.Join(input, "app.zip")
	put(t, path, []byte("must remain untouched"))
	for _, flag := range []string{"--work-dir", "--reports-dir"} {
		_, code, e := Run(root, nil, append(append([]string{}, args...), flag, filepath.Join(input, "output")))
		if code != 3 || e == nil || errorType(e) != "ValueError" || !strings.Contains(e.Error(), "must not overlap") {
			t.Fatalf("overlapping %s: code=%d error=%v", flag, code, e)
		}
	}
	if got := string(mustRead(t, path)); got != "must remain untouched" {
		t.Fatalf("rejected output directory changed input: %q", got)
	}
}
