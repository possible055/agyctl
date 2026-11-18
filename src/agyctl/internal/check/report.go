package check

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

func orderedKeys(m object, preferred []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, k := range preferred {
		if _, ok := m[k]; ok {
			out = append(out, k)
			seen[k] = true
		}
	}
	rest := []string{}
	for k := range m {
		if !seen[k] {
			rest = append(rest, k)
		}
	}
	sort.Strings(rest)
	return append(out, rest...)
}
func newReport(target, caps, app, extra object) (object, error) {
	id := make([]byte, 16)
	if _, e := rand.Read(id); e != nil {
		return nil, e
	}
	m := object{"schema": 1, "report_id": hex.EncodeToString(id), "generated_at": time.Now().UTC().Format("2006-01-02T15:04:05.000000+00:00"), "target": target, "app": app, "capabilities": caps, "overall": aggregate(caps), "capability_matrix": capabilityMatrix(target, caps, extra)}
	for k, v := range extra {
		m[k] = v
	}
	return m, nil
}

// capabilityMatrix separates what the checker can do on this target from what
// it merely observed. Rejection reasons distinguish unsupported binary format
// or architecture (the limit patcher supports PE/ELF on x86-64),
// unknown or wrong-sized function bodies, and an unrecorded version whose
// bytes are recorded: a supported binary with identical recorded original
// bytes passes regardless of its version label, so the version label is
// advisory only.
func capabilityMatrix(target, caps, extra object) object {
	fingerprint := obj(extra["fingerprint"])
	arch := str(fingerprint["arch"])
	platform := str(target["platform"])
	if platform == "" && arch != "" {
		platform = arch
	}
	matrix := object{
		"platform":           platform,
		"arch":               arch,
		"version_label":      str(target["version"]),
		"version_label_note": "advisory only — a supported binary with identical recorded original bytes passes regardless of its version label",
	}
	mdl := obj(caps["models"])
	mdlV := str(mdl["verdict"])
	probeErr := ""
	if e := obj(mdl["error"]); e != nil {
		probeErr = str(e["message"])
	}
	switch {
	case mdlV == "":
		matrix["read_only_monitoring"] = object{"capability": "unknown", "reason": "no language server probe results in this report"}
	case probeErr != "":
		// The probe itself failed: there is no evidence about monitoring, not
		// evidence that monitoring works. The failure reason stays attached.
		matrix["read_only_monitoring"] = object{"capability": "unknown", "reason": "language server probe failed: " + probeErr}
	case mdlV == "fail":
		matrix["read_only_monitoring"] = object{"capability": "unavailable", "reason": "models probe failed"}
	case mdlV == "warn":
		matrix["read_only_monitoring"] = object{"capability": "needs-review", "reason": "models probe needs review"}
	default:
		matrix["read_only_monitoring"] = object{"capability": "available", "reason": "models probe passed; context patchability does not gate monitoring"}
	}
	if str(target["source"]) == "local" {
		matrix["installer_inspection"] = object{"capability": "not-applicable", "reason": "installed client inspected in place; no installer downloaded"}
	} else if str(target["source"]) == "file" {
		inspection := obj(extra["installer_inspection"])
		capability, reason := "unavailable", "local installer inspection failed; see structured errors"
		if inspection["extracted"] == true && inspection["input_unchanged"] == true {
			capability = "available"
			reason = "local installer SHA-256 recorded, input unchanged and extracted under budget; SHA-256 identifies bytes, not independent publisher authentication"
		}
		matrix["installer_inspection"] = object{"capability": capability, "reason": reason}
	} else if str(target["asset_url"]) != "" {
		matrix["installer_inspection"] = object{"capability": "available", "reason": "installer downloaded, hash-verified and extracted under budget"}
	} else {
		matrix["installer_inspection"] = object{"capability": "unknown", "reason": "no installer information in this report"}
	}
	ui := obj(caps["ui"])
	uiVerdict := str(ui["verdict"])
	verdictToCapability := map[string]string{"pass": "available", "warn": "needs-review", "fail": "unavailable"}
	localization := obj(caps["localization"])
	localizationCap := verdictToCapability[str(localization["verdict"])]
	if localizationCap == "" {
		localizationCap = "unknown"
	}
	matrix["localization_delivery"] = object{"capability": localizationCap, "reason": strings.Join(stringsOf(localization["checks"]), "; ")}
	injectionCap, known := verdictToCapability[uiVerdict]
	if !known {
		injectionCap = "unknown"
	}
	injectionReason := ""
	if hook := obj(ui["staticHookEvidence"]); hook["present"] != nil {
		if hook["present"] == true {
			injectionReason = "static hook evidence present in the patched preload; live mounting and activation evidence unknown"
		} else {
			injectionReason = "static hook evidence absent — capsule injection point missing or damaged"
		}
	}
	switch str(obj(ui["capsuleIntegrity"])["verdict"]) {
	case "blocked":
		injectionCap = "blocked"
		injectionReason = "fuse wire blocks capsule modification: " + str(obj(ui["capsuleIntegrity"])["reason"])
	case "needs-review":
		if injectionCap == "available" || injectionCap == "unknown" {
			injectionCap = "needs-review"
		}
		injectionReason = "fuse wire could not qualify capsule modification: " + str(obj(ui["capsuleIntegrity"])["reason"])
	}
	matrix["capsule_injection"] = object{"capability": injectionCap, "reason": injectionReason}
	clamp := obj(fingerprint["clamp"])
	kind := str(clamp["kind"])
	size := num(clamp["size"])
	format := str(fingerprint["format"])
	patchCap, patchReason := "unknown", "no language server fingerprint in this report"
	switch {
	case format == "macho" && arch == "arm64":
		patchCap, patchReason = "blocked", "macOS limit patching unavailable: original bytes, code placement and signing strategy are not qualified"
	case format != "" && format != "pe" && format != "elf":
		// Matching function bytes on a Mach-O container do not make the
		// patcher apply: the limit patcher supports PE and ELF only.
		patchCap, patchReason = "blocked", "unsupported binary format (limit patcher supports PE and ELF); probed "+format
	case arch != "" && arch != "x86-64":
		patchCap, patchReason = "blocked", "unsupported architecture (limit patcher supports x86-64)"
	case kind == "missing":
		patchCap, patchReason = "blocked", "patch target symbol not found — agyctl limit is unavailable on this build"
	case kind == "unknown":
		patchCap, patchReason = "blocked", "unknown function bytes — checker cannot verify; the limit patcher's own byte-signature preflight is authoritative"
	case kind == "original", kind == "ours-patched":
		// The patcher additionally refuses a function whose pclntab size is
		// not the admitted layout for the architecture; the matrix mirrors
		// that refusal instead of admitting bytes recorded for another arch.
		expectedSize := int64(128)
		if size == 352 && format == "pe" {
			expectedSize = 352
		}
		if size > 0 && size != expectedSize {
			patchCap, patchReason = "blocked", fmt.Sprintf("clamp size %#x != %#x — different build layout", size, expectedSize)
			break
		}
		if kind == "original" {
			patchCap = "available"
			patchReason = "clamp bytes match a recorded original; patching passes on the recorded original bytes regardless of the version label"
			break
		}
		patchCap, patchReason = "available", "already patched by this tool (clamp bytes recognized)"
	}
	matrix["limit_patching"] = object{"capability": patchCap, "reason": patchReason}
	return matrix
}

var reportName = regexp.MustCompile(`[^a-zA-Z0-9_.-]`)

func saveReport(rep object, dir string) (string, error) {
	target, app := obj(rep["target"]), obj(rep["app"])
	version := str(app["version"])
	if version == "" {
		version = str(target["version"])
	}
	if version == "" {
		version = "unknown"
	}
	hashes := []string{}
	for _, k := range []string{"ls_sha256", "asar_sha256", "asset_sha256"} {
		hashes = append(hashes, str(target[k]))
	}
	channel := str(target["channel"])
	if channel == "" {
		channel = "unknown"
	}
	bits := []string{channel}
	if p := str(target["platform"]); p != "" {
		bits = append(bits, p)
	}
	bits = append(bits, version, hashBytes([]byte(strings.Join(hashes, "/")))[:16], str(rep["report_id"]))
	path := filepath.Join(dir, reportName.ReplaceAllString(strings.Join(bits, "-"), "_")+".json")
	return path, writeJSON(path, rep)
}
func latestReport(dir string) (string, error) {
	paths, e := filepath.Glob(filepath.Join(dir, "*.json"))
	if e != nil {
		return "", e
	}
	var newest string
	var generation, timeModified time.Time
	for _, p := range paths {
		rep, e := readJSON(p)
		if e != nil {
			return "", e
		}
		stat, e := os.Stat(p)
		if e != nil {
			return "", e
		}
		generated := stat.ModTime()
		if v := str(rep["generated_at"]); v != "" {
			generated, e = time.Parse(time.RFC3339Nano, v)
			if e != nil {
				return "", e
			}
		}
		if newest == "" || generated.After(generation) || (generated.Equal(generation) && stat.ModTime().After(timeModified)) {
			newest = p
			generation = generated
			timeModified = stat.ModTime()
		}
	}
	return newest, nil
}
func exitCode(rep object) int {
	switch rep["overall"] {
	case "compatible":
		return 0
	case "needs-review":
		return 1
	case "incompatible":
		return 2
	default:
		return 3
	}
}
func render(rep object) {
	t, a := obj(rep["target"]), obj(rep["app"])
	version := str(a["version"])
	if version == "" {
		version = str(t["version"])
	}
	if version == "" {
		version = "?"
	}
	loc := str(t["channel"])
	if loc == "" {
		loc = "?"
	}
	if p := str(t["platform"]); p != "" {
		loc += "/" + p
	}
	logf("=== [agyctl Update Check] %s (%s, %s) ===", version, loc, str(t["source"]))
	if u := str(t["asset_url"]); u != "" {
		logf("[*] asset: %s", u)
	}
	if sha := str(t["ls_sha256"]); sha != "" {
		logf("[*] language_server sha256: %s", sha)
	}
	caps := obj(rep["capabilities"])
	for _, n := range orderedKeys(caps, []string{"context", "models", "ui", "localization"}) {
		cap := obj(caps[n])
		badge := map[string]string{"pass": "[OK]", "warn": "[!!]", "fail": "[XX]"}[str(cap["verdict"])]
		logf("%s %-8s %s", badge, strings.ToUpper(n), str(cap["verdict"]))
		for _, c := range stringsOf(cap["checks"]) {
			logf("         - %s", c)
		}
	}
	for _, e := range objects(rep["errors"]) {
		logf("[x] %s: %s: %s", str(e["probe"]), str(e["type"]), str(e["message"]))
	}
	logf("OVERALL: %s", str(rep["overall"]))
}
