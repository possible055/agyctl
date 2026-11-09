package check

import (
	"agyctl/internal/assets"
	"agyctl/internal/layout"
	"agyctl/internal/limit"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

type options struct {
	targets                                                       layout.Config
	command, root, work, reports, channel, version, install, file string
	input                                                         string
	platforms                                                     []string
	snap                                                          *assets.Snapshot
	limit                                                         int
	matrix, skip, keep                                            bool
}

func parseOptions(root string, args []string) (options, error) {
	o := options{root: root, work: filepath.Join(root, "var", "update-check", "work"), reports: filepath.Join(root, "var", "update-check", "reports"), limit: 10}
	o.input = filepath.Join(root, "var", "update-check", "inputs")
	seen := []string{}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		key, value, hasValue := strings.Cut(arg, "=")
		if key == "--json" {
			if hasValue {
				return o, failure("ValueError", "%s does not take a value", key)
			}
			continue
		}
		if hasValue && contains([]string{"--matrix", "--skip-download", "--keep-work"}, key) {
			return o, failure("ValueError", "%s does not take a value", key)
		}
		if !strings.HasPrefix(arg, "-") {
			if o.command != "" {
				return o, failure("ValueError", "unexpected argument: %s", arg)
			}
			o.command = arg
			continue
		}
		seen = append(seen, key)
		take := func() (string, error) {
			if hasValue {
				return value, nil
			}
			i++
			if i >= len(args) {
				return "", failure("ValueError", "%s requires a value", key)
			}
			return args[i], nil
		}
		switch key {
		case "--matrix":
			o.matrix = true
		case "--skip-download":
			o.skip = true
		case "--keep-work":
			o.keep = true
		case "--work-dir", "--reports-dir", "--input-dir", "--channel", "--version", "--install-dir", "--file", "--limit", "--platform":
			v, e := take()
			if e != nil {
				return o, e
			}
			switch key {
			case "--work-dir":
				o.work = v
			case "--reports-dir":
				o.reports = v
			case "--input-dir":
				o.input = v
			case "--channel":
				o.channel = v
			case "--version":
				o.version = v
			case "--install-dir":
				o.install = v
			case "--file":
				o.file = v
			case "--limit":
				o.limit, e = strconv.Atoi(v)
				if e != nil {
					return o, failure("ValueError", "invalid limit: %s", v)
				}
			case "--platform":
				o.platforms = append(o.platforms, v)
			}
		default:
			return o, failure("ValueError", "unknown flag: %s", key)
		}
	}
	if !contains([]string{"versions", "local", "check", "files", "report"}, o.command) {
		return o, failure("ValueError", "expected versions, local, check, files or report")
	}
	allowed := map[string][]string{
		"versions": {"--channel", "--platform", "--version", "--limit"},
		"local":    {"--channel", "--install-dir"},
		"check":    {"--channel", "--platform", "--matrix", "--version", "--skip-download", "--keep-work"},
		"files":    {"--input-dir", "--keep-work"},
		"report":   {"--file"},
	}
	for _, key := range seen {
		if key != "--work-dir" && key != "--reports-dir" && !contains(allowed[o.command], key) {
			return o, failure("ValueError", "%s is not supported by %s", key, o.command)
		}
	}
	if o.command == "check" && o.channel == "" {
		o.channel = "hub"
	}
	validChannels := []string{"hub", "insiders"}
	if o.command == "local" {
		validChannels = []string{"insiders", "antigravity"}
	}
	if o.channel != "" && !contains(validChannels, o.channel) {
		return o, failure("ValueError", "unsupported channel: %s", o.channel)
	}
	return o, nil
}
func contains(values []string, v string) bool {
	for _, s := range values {
		if s == v {
			return true
		}
	}
	return false
}

// Run executes the read-only compatibility checker and returns one JSON result.
// Compat data is parsed from the snapshot captured while the runtime assets
// were verified; a nil snapshot (only for direct library use in tests) falls
// back to reading compat files under root.
func Run(root string, snap *assets.Snapshot, args []string) (any, int, error) {
	o, e := parseOptions(root, args)
	if e != nil {
		return nil, 3, e
	}
	o.snap = snap
	if o.command != "report" {
		o.targets, e = layout.Load(root, snap)
		if e != nil {
			return nil, 3, e
		}
		for _, platform := range o.platforms {
			if _, e = o.targets.FeedTarget(platform); e != nil {
				return nil, 3, failure("ValueError", "%s", e)
			}
		}
	}
	switch o.command {
	case "versions":
		return runVersions(o)
	case "files":
		return runFiles(o)
	case "report":
		p := o.file
		if p == "" {
			p, e = latestReport(o.reports)
			if e != nil {
				return nil, 3, e
			}
		}
		if p == "" {
			return nil, 3, failure("FileNotFoundError", "no report found")
		}
		rep, e := readJSON(p)
		if e != nil {
			return nil, 3, e
		}
		render(rep)
		return rep, exitCode(rep), nil
	case "local":
		rep, e := runLocal(o)
		if e != nil {
			target := object{"source": "local", "channel": nil, "install_dir": nil}
			if o.channel != "" {
				target["channel"] = o.channel
			}
			if o.install != "" {
				target["install_dir"] = o.install
			}
			rep, saveErr := errorReport(o, target, e)
			if saveErr != nil {
				return nil, 3, errors.Join(e, saveErr)
			}
			return rep, 3, nil
		}
		return rep, exitCode(rep), nil
	default:
		return runCheck(o)
	}
}
func findInstall(o options) (layout.Target, error) {
	if o.install != "" {
		resources := "resources"
		server := "language_server"
		if runtime.GOOS == "darwin" {
			resources = "Resources"
		}
		if runtime.GOOS == "windows" {
			server += ".exe"
		}
		channel := o.channel
		if channel == "" {
			channel = "local"
		}
		t := layout.Target{Root: o.install, Asar: filepath.Join(o.install, resources, "app.asar"), LanguageServer: filepath.Join(o.install, resources, "bin", server), Channel: channel}
		candidates, err := layout.Candidates(o.root, o.snap)
		if err != nil {
			return t, err
		}
		selected, err := filepath.Abs(o.install)
		if err != nil {
			return t, err
		}
		for _, candidate := range candidates {
			root, err := filepath.Abs(candidate.Root)
			if err != nil {
				return t, err
			}
			if strings.EqualFold(filepath.Clean(root), filepath.Clean(selected)) {
				t.Channel, t.Product = candidate.Channel, candidate.Product
				break
			}
		}
		if !isFile(t.Asar) {
			return t, failure("FileNotFoundError", "no app.asar under %s", filepath.Join(o.install, resources))
		}
		return t, nil
	}
	targets, e := layout.LocateFrom(o.root, o.snap)
	if e != nil {
		return layout.Target{}, e
	}
	for _, t := range targets {
		ch := t.Channel
		if strings.Contains(ch, "insiders") {
			ch = "insiders"
		}
		if o.channel == "" || o.channel == ch {
			t.Channel = ch
			return t, nil
		}
	}
	return layout.Target{}, failure("FileNotFoundError", "no Antigravity installation found")
}
func runLocal(o options) (object, error) {
	t, e := findInstall(o)
	if e != nil {
		return nil, e
	}
	target := object{"source": "local", "channel": t.Channel, "install_dir": t.Root, "ls_sha256": ""}
	fail := func(e error) (object, error) { return errorReport(o, target, e) }
	sha, e := hashFile(t.Asar)
	if e != nil {
		return fail(e)
	}
	target["asar_sha256"] = sha
	lsSHA, lsInputErr := hashFile(t.LanguageServer)
	if lsInputErr == nil {
		target["ls_sha256"] = lsSHA
	}
	known, e := limit.Originals(o.root, o.snap)
	if e != nil {
		return fail(e)
	}
	errorsFound := []object{}
	ui, e := probeAsar(t.Asar, t.Asar+".unpacked")
	if e != nil {
		f := probeError("ui", e)
		errorsFound = append(errorsFound, f)
		ui = failedProbe(f)
	} else {
		attachCapsuleIntegrity(ui, t.Root)
	}
	var ls object
	e = lsInputErr
	if e == nil {
		ls, e = probeLS(t.LanguageServer, known)
	}
	if e != nil {
		f := probeError("language_server", e)
		errorsFound = append(errorsFound, f)
		ls = object{"context": failedProbe(f), "models": failedProbe(f), "fingerprint": object{}}
	}
	caps := object{"context": ls["context"], "models": ls["models"], "ui": ui}
	localization, e := localizationCapability(o, t.Asar, str(target["ls_sha256"]), str(target["asar_sha256"]))
	if e != nil {
		f := probeError("localization", e)
		errorsFound = append(errorsFound, f)
		localization = failedProbe(f)
	}
	caps["localization"] = localization
	fp := obj(ls["fingerprint"])
	extra := object{"errors": errorsFound, "fingerprint": fp}
	app := obj(ui["app"])
	for _, pair := range [][2]string{{"ls_sha256", t.LanguageServer}, {"asar_sha256", t.Asar}} {
		if str(target[pair[0]]) == "" {
			continue
		}
		sha, e := hashFile(pair[1])
		if e != nil {
			errorsFound = append(errorsFound, probeError(pair[0], e))
		} else if sha != target[pair[0]] {
			errorsFound = append(errorsFound, probeError(pair[0], failure("OSError", "input changed while probing")))
		}
	}
	extra["errors"] = errorsFound
	rep, e := newReport(target, caps, app, extra)
	if e != nil {
		return nil, e
	}
	if len(errorsFound) > 0 {
		rep["overall"] = "error"
	}
	p, e := saveReport(rep, o.reports)
	if e != nil {
		return nil, e
	}
	logf("[*] report: %s", p)
	render(rep)
	return rep, nil
}
func errorReport(o options, target object, e error) (object, error) {
	rep, err := newReport(target, object{}, object{}, object{"overall": "error", "errors": []object{probeError("checker", e)}})
	if err != nil {
		return nil, err
	}
	p, err := saveReport(rep, o.reports)
	if err != nil {
		return nil, err
	}
	logf("[x] %s: %s", errorType(e), e)
	logf("[*] report: %s", p)
	return rep, nil
}
func resolveCells(o options, channels, plats []string) []object {
	releases := map[string]object{}
	releaseErrs := map[string]error{}
	for _, ch := range channels {
		if ch == "insiders" {
			continue
		}
		rows, e := listReleases(ch)
		if e == nil {
			releases[ch], e = pickRelease(rows, o.version)
		}
		if e != nil {
			releaseErrs[ch] = e
		}
	}
	cache := map[string]object{}
	out := []object{}
	for _, ch := range channels {
		for _, p := range plats {
			var row object
			var e error
			if releaseErrs[ch] != nil {
				e = releaseErrs[ch]
			} else {
				row, e = resolveCell(o.targets, ch, p, o.version, releases[ch], cache)
			}
			if e != nil {
				row = object{"channel": ch, "platform": p, "version": "?", "url": "", "skip": true, "error": errorType(e) + ": " + e.Error()}
			}
			out = append(out, row)
		}
	}
	return out
}
func runVersions(o options) (any, int, error) {
	plats := o.platforms
	if len(plats) == 0 {
		plats = o.targets.Feeds()
	}
	channels := []string{"hub", "insiders"}
	if o.channel != "" {
		channels = []string{o.channel}
	}
	if o.channel == "" || o.channel == "insiders" {
		o.version = ""
	}
	if o.channel != "" && o.channel != "insiders" && len(plats) == 1 {
		releases, e := listReleases(o.channel)
		if e != nil {
			return nil, 3, e
		}
		rows := []object{}
		for i, r := range releases {
			if i >= o.limit {
				break
			}
			u, e := assetURL(o.targets, o.channel, str(r["version"]), str(r["execution_id"]), plats[0])
			if e != nil {
				return nil, 3, e
			}
			row := clone(r)
			row["url"] = u
			row["channel"] = o.channel
			row["platform"] = plats[0]
			rows = append(rows, row)
			logf("%s\t%s", str(r["version"]), u)
		}
		return object{"releases": rows}, 0, nil
	}
	rows := resolveCells(o, channels, plats)
	for _, r := range rows {
		logf("%-10s %-12s %-20s %s", str(r["channel"]), str(r["platform"]), str(r["version"]), str(r["url"]))
	}
	return object{"releases": rows}, 0, nil
}
func runCheck(o options) (any, int, error) {
	channels := []string{o.channel}
	plats := o.platforms
	if o.matrix {
		channels = []string{"hub", "insiders"}
		if len(plats) == 0 {
			plats = o.targets.Feeds()
		}
	} else if len(plats) == 0 {
		target, err := o.targets.Target(runtime.GOOS, runtime.GOARCH)
		if err != nil {
			return nil, 3, err
		}
		plats = []string{target.Feed}
	}
	cells := resolveCells(o, channels, plats)
	results := []object{}
	reports := []object{}
	worst := 0
	for i, cell := range cells {
		logf("=== [agyctl Update Check] %d/%d %s/%s ===", i+1, len(cells), str(cell["channel"]), str(cell["platform"]))
		rep, e := checkCell(o, cell)
		if e != nil {
			var saveErr error
			target := clone(cell)
			target["source"] = "feed"
			rep, saveErr = errorReport(o, target, e)
			if saveErr != nil {
				return nil, 3, errors.Join(e, saveErr)
			}
		}
		code := exitCode(rep)
		if code > worst {
			worst = code
		}
		row := clone(cell)
		row["exit"] = code
		row["overall"] = rep["overall"]
		results = append(results, row)
		reports = append(reports, rep)
	}
	if len(reports) == 1 {
		return reports[0], worst, nil
	}
	return object{"results": results, "reports": reports, "exit": worst}, worst, nil
}
func assetDest(work string, cell object, filename string) string {
	version := str(cell["version"])
	if e := str(cell["execution_id"]); e != "" {
		version += "-" + e
	}
	return filepath.Join(work, "downloads", str(cell["channel"]), version, str(cell["platform"]), filename)
}
func cachedArchive(work string, cell object, dest string) (object, error) {
	m, e := readJSON(filepath.Join(work, "archive.json"))
	if e != nil && !os.IsNotExist(e) {
		return nil, e
	}
	if e == nil {
		for _, r := range objects(m["assets"]) {
			match := r["url"] == cell["url"] && r["path"] == dest
			for _, k := range []string{"channel", "platform", "version", "execution_id"} {
				match = match && r[k] == cell[k]
			}
			if match {
				return r, nil
			}
		}
	}
	return nil, failure("OSError", "cached installer has no matching archive manifest; download again")
}
func upsertArchive(work string, cell object, dest, sha string, size int64) error {
	path := filepath.Join(work, "archive.json")
	m, e := readJSON(path)
	if os.IsNotExist(e) {
		m = object{"assets": []object{}}
	} else if e != nil {
		return e
	}
	assets := []object{}
	for _, a := range objects(m["assets"]) {
		same := true
		for _, k := range []string{"channel", "platform", "version", "execution_id"} {
			same = same && a[k] == cell[k]
		}
		if !same {
			assets = append(assets, a)
		}
	}
	entry := object{"channel": cell["channel"], "platform": cell["platform"], "version": cell["version"], "url": cell["url"], "path": dest, "sha256": sha, "size": size, "downloaded_at": time.Now().UTC().Format("2006-01-02T15:04:05+00:00")}
	if e := str(cell["execution_id"]); e != "" {
		entry["execution_id"] = e
	}
	m["assets"] = append(assets, entry)
	return writeJSON(path, m)
}

// checkCell owns the digest-scoped scratch directory extract/<channel>-<platform>/<sha>
// and registers its removal before extraction can fail, so no failure path
// leaks scratch; downloads kept for --skip-download reuse, the archive
// manifest, and saved reports are never touched by the cleanup.
func checkCell(o options, cell object) (report object, err error) {
	if cell["skip"] == true {
		reason := str(cell["error"])
		if reason == "" {
			reason = str(cell["note"])
		}
		return nil, failure("LookupError", "%s", reason)
	}
	rawURL := str(cell["url"])
	u, e := url.Parse(rawURL)
	if e != nil {
		return nil, e
	}
	filename := filepath.Base(u.Path)
	for _, part := range []string{str(cell["channel"]), str(cell["version"]), str(cell["execution_id"]), str(cell["platform"]), filename} {
		if part != "" && (part == "." || part == ".." || strings.ContainsAny(part, "/\\:")) {
			return nil, failure("ValueError", "unsafe asset path component: %s", part)
		}
	}
	dest := assetDest(o.work, cell, filename)
	var sha string
	var size int64
	if o.skip && isFile(dest) {
		cached, e := cachedArchive(o.work, cell, dest)
		if e != nil {
			return nil, e
		}
		expectedSize, ok := cell["size"]
		if !ok {
			expectedSize = cached["size"]
		}
		sha, size, e = verifyDownload(dest, str(cached["sha256"]), expectedSize, str(cell["sha512"]))
		if e != nil {
			return nil, e
		}
	} else {
		sha, size, e = download(rawURL, dest, cell["size"], str(cell["sha512"]))
		if e != nil {
			return nil, e
		}
	}
	if e = upsertArchive(o.work, cell, dest, sha, size); e != nil {
		return nil, e
	}
	cell["asset_sha256"] = sha
	extractRoot := filepath.Join(o.work, "extract", str(cell["channel"])+"-"+str(cell["platform"]))
	scratch := filepath.Join(extractRoot, sha)
	if !o.keep {
		defer func() {
			if e := removeScratch(extractRoot, scratch); e != nil {
				err = errors.Join(err, e)
			}
		}()
	}
	tree, e := extractInstaller(dest, extractRoot, filepath.Join(o.work, "tools"), sha)
	if e != nil {
		return nil, e
	}
	if str(tree["ls_exe"]) == "" {
		return nil, failure("FileNotFoundError", "language server missing from extracted app tree")
	}
	for _, p := range [][2]string{{"ls_sha256", "ls_exe"}, {"asar_sha256", "asar"}} {
		sha, e := hashFile(str(tree[p[1]]))
		if e != nil {
			return nil, e
		}
		cell[p[0]] = sha
	}
	ui, e := probeAsar(str(tree["asar"]), str(tree["unpacked_dir"]))
	if e != nil {
		return nil, e
	}
	attachCapsuleIntegrity(ui, str(tree["app_root"]))
	known, e := limit.Originals(o.root, o.snap)
	if e != nil {
		return nil, e
	}
	ls, e := probeLS(str(tree["ls_exe"]), known)
	if e != nil {
		return nil, e
	}
	fp := obj(ls["fingerprint"])
	target := object{"source": "feed", "channel": cell["channel"], "platform": cell["platform"], "version": cell["version"], "asset_url": rawURL, "asset_sha256": sha, "ls_sha256": cell["ls_sha256"], "asar_sha256": cell["asar_sha256"]}
	for _, k := range []string{"execution_id", "note"} {
		if str(cell[k]) != "" {
			target[k] = cell[k]
		}
	}
	treeJSON := object{}
	for k, v := range tree {
		treeJSON[k] = py(v)
	}
	localization, e := localizationCapability(o, str(tree["asar"]), str(target["ls_sha256"]), str(target["asar_sha256"]))
	if e != nil {
		return nil, e
	}
	rep, e := newReport(target, object{"context": ls["context"], "models": ls["models"], "ui": ui, "localization": localization}, obj(ui["app"]), object{"tree": treeJSON, "fingerprint": fp})
	if e != nil {
		return nil, e
	}
	p, e := saveReport(rep, o.reports)
	if e != nil {
		return nil, e
	}
	logf("[*] report: %s", p)
	render(rep)
	return rep, nil
}
