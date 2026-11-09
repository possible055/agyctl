package check

import (
	"agyctl/internal/limit"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func installerFiles(dir string) ([]string, error) {
	info, e := os.Lstat(dir)
	if e != nil {
		return nil, e
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, failure("ValueError", "input directory must be a real directory: %s", dir)
	}
	files := []string{}
	e = filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type().IsRegular() && contains([]string{".exe", ".zip", ".deb", ".dmg", "tar.gz"}, archiveKind(path)) {
			files = append(files, path)
		}
		return nil
	})
	if e != nil {
		return nil, e
	}
	if len(files) == 0 {
		return nil, failure("FileNotFoundError", "no supported installer files found in %s", dir)
	}
	sort.Strings(files)
	return files, nil
}

// resolvedOutput resolves existing ancestors before comparing writable output
// directories with the read-only input tree, including paths not created yet.
func resolvedOutput(path string) (string, error) {
	path, e := filepath.Abs(path)
	if e != nil {
		return "", e
	}
	parts := []string{}
	for {
		resolved, e := filepath.EvalSymlinks(path)
		if e == nil {
			for i := len(parts) - 1; i >= 0; i-- {
				resolved = filepath.Join(resolved, parts[i])
			}
			return resolved, nil
		}
		if !os.IsNotExist(e) || filepath.Dir(path) == path {
			return "", e
		}
		parts = append(parts, filepath.Base(path))
		path = filepath.Dir(path)
	}
}

func separateFileOutputs(input string, outputs ...string) error {
	input, e := filepath.EvalSymlinks(input)
	if e != nil {
		return e
	}
	for _, output := range outputs {
		resolved, e := resolvedOutput(output)
		if e != nil {
			return e
		}
		if !strings.EqualFold(filepath.VolumeName(input), filepath.VolumeName(resolved)) {
			continue
		}
		for _, pair := range [][2]string{{input, resolved}, {resolved, input}} {
			rel, e := filepath.Rel(pair[0], pair[1])
			if e != nil {
				return e
			}
			if rel == "." || filepath.IsLocal(rel) {
				return failure("ValueError", "input and output directories must not overlap: %s and %s", input, output)
			}
		}
	}
	return nil
}

func runFiles(o options) (any, int, error) {
	input, e := filepath.Abs(o.input)
	if e != nil {
		return nil, 3, e
	}
	files, e := installerFiles(input)
	if e != nil {
		return nil, 3, e
	}
	if e = separateFileOutputs(input, o.work, o.reports); e != nil {
		return nil, 3, e
	}
	results, reports := []object{}, []object{}
	worst := 0
	for i, path := range files {
		logf("=== [agyctl Local Installer Check] %d/%d %s ===", i+1, len(files), path)
		target := object{"source": "file", "asset_path": path}
		rep, e := inspectInstallerFile(o, target)
		if e != nil {
			return nil, 3, e
		}
		reportPath, e := saveReport(rep, o.reports)
		if e != nil {
			return nil, 3, e
		}
		logf("[*] report: %s", reportPath)
		render(rep)
		code := exitCode(rep)
		if code > worst {
			worst = code
		}
		row := clone(target)
		row["overall"], row["exit"], row["report_path"] = rep["overall"], code, reportPath
		results = append(results, row)
		reports = append(reports, rep)
	}
	return object{"results": results, "reports": reports, "exit": worst}, worst, nil
}

func filePlatform(fp object) string {
	osName := map[string]string{"pe": "win", "elf": "linux", "macho": "darwin"}[str(fp["format"])]
	arch := map[string]string{"x86-64": "x64", "arm64": "arm64"}[str(fp["arch"])]
	if osName == "" || arch == "" {
		return ""
	}
	return osName + "-" + arch
}

func inspectInstallerFile(o options, target object) (object, error) {
	path := str(target["asset_path"])
	caps, app := object{}, object{}
	errorsFound := []object{}
	inspection := object{"extracted": false, "input_unchanged": false, "publisher_authentication": "not-verified", "identity_note": "SHA-256 identifies the local input bytes; it does not independently authenticate the publisher"}
	extra := object{"installer_inspection": inspection}
	inspectErr := func() (err error) {
		info, e := os.Lstat(path)
		if e != nil {
			return e
		}
		if !info.Mode().IsRegular() {
			return failure("ValueError", "installer is not a regular file: %s", path)
		}
		sha, e := hashFile(path)
		if e != nil {
			return e
		}
		target["asset_sha256"], target["asset_size"] = sha, info.Size()
		defer func() {
			after, e := os.Lstat(path)
			if e != nil {
				err = errors.Join(err, e)
				return
			}
			if !after.Mode().IsRegular() || !os.SameFile(info, after) || after.Size() != info.Size() {
				err = errors.Join(err, failure("OSError", "local installer changed while probing: %s", path))
				return
			}
			afterSHA, e := hashFile(path)
			if e != nil {
				err = errors.Join(err, e)
			} else if afterSHA != sha {
				err = errors.Join(err, failure("OSError", "local installer changed while probing: %s", path))
			} else {
				inspection["input_unchanged"] = true
			}
		}()
		extractRoot := filepath.Join(o.work, "extract", "files")
		scratch := filepath.Join(extractRoot, sha)
		if !o.keep {
			defer func() { err = errors.Join(err, removeScratch(extractRoot, scratch)) }()
		}
		budget := newExtractBudget()
		budget.offline = true
		tree, e := extractInstallerBudgeted(path, extractRoot, filepath.Join(o.work, "tools"), sha, budget)
		if e != nil {
			return e
		}
		inspection["extracted"] = true
		treeJSON := object{}
		for k, v := range tree {
			treeJSON[k] = py(v)
		}
		extra["tree"] = treeJSON
		for _, pair := range [][2]string{{"asar_sha256", "asar"}, {"ls_sha256", "ls_exe"}} {
			p := str(tree[pair[1]])
			if p == "" {
				continue
			}
			sha, e := hashFile(p)
			if e != nil {
				return e
			}
			target[pair[0]] = sha
		}
		ui, e := probeAsar(str(tree["asar"]), str(tree["unpacked_dir"]))
		if e != nil {
			f := probeError("ui", e)
			errorsFound = append(errorsFound, f)
			ui = failedProbe(f)
		} else {
			attachCapsuleIntegrity(ui, str(tree["app_root"]))
		}
		caps["ui"], app = ui, obj(ui["app"])
		localization, e := localizationCapability(o, str(tree["asar"]), str(target["ls_sha256"]), str(target["asar_sha256"]))
		if e != nil {
			f := probeError("localization", e)
			errorsFound = append(errorsFound, f)
			localization = failedProbe(f)
		}
		caps["localization"] = localization
		if str(app["version"]) != "" {
			target["version"] = app["version"]
		}
		lsPath := str(tree["ls_exe"])
		if lsPath == "" {
			return failure("FileNotFoundError", "language server missing from extracted app tree")
		}
		known, e := limit.Originals(o.root, o.snap)
		if e != nil {
			return e
		}
		ls, e := probeLS(lsPath, known)
		fp := obj(ls["fingerprint"])
		if e != nil {
			f := probeError("language_server", e)
			errorsFound = append(errorsFound, f)
			ls = object{"context": failedProbe(f), "models": failedProbe(f)}
			// Container and architecture remain observable when Go symbols cannot
			// be parsed; neither filename nor input directory is platform evidence.
			data, readErr := os.ReadFile(lsPath)
			if readErr != nil {
				return readErr
			}
			im, imageErr := imageText(data)
			if imageErr == nil {
				fp = object{"format": binaryFormat(data), "arch": im.arch}
			}
		}
		if platform := filePlatform(fp); platform != "" {
			target["platform"] = platform
		}
		caps["context"], caps["models"] = ls["context"], ls["models"]
		extra["fingerprint"] = fp
		return nil
	}()
	if inspectErr != nil {
		errorsFound = append(errorsFound, probeError("installer", inspectErr))
	}
	extra["errors"] = errorsFound
	if len(errorsFound) > 0 {
		extra["overall"] = "error"
	}
	return newReport(target, caps, app, extra)
}
