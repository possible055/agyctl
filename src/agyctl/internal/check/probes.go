package check

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"unicode/utf8"

	"agyctl/internal/assets"
)

const funcClamp = "utils.ClampCheckpointConfigForModelInfo"
const funcGate = "utils.GetCheckpointConfig"

var hookNames = []string{funcClamp, funcGate, "config.applyFeatureProviderCheckpointOverrideConfig", "config.selectCheckpointExperimentKey"}
var markerNames = []string{"MODEL_PLACEHOLDER", "model_profiles", "GetAvailableModels", "ListAvailableModels"}

const patchHex = "4885c0747a4885db74758b530881ea2605000083fa6577190fa315910c0000731081780c20a107007307c7400c20a1070083780c0075108b531481ea409c00007f0231d289500c8b531485d27e1189d629ca39f10f42f239700c760389700c488b48504885c9741780390074128b4b7085c97e0b8b501039ca0f47d1895010c3"

func classifyBody(body []byte, known [][]byte, arch string) (string, any) {
	if arch != "x86-64" {
		return "unknown", nil
	}
	for _, orig := range known {
		if bytes.Equal(body, orig) {
			return "original", nil
		}
	}
	if arch != "x86-64" || len(body) != 128 {
		return "unknown", nil
	}
	template, _ := hex.DecodeString(patchHex)
	normal := bytes.Clone(body)
	for _, span := range [][2]int{{15, 19}, {21, 22}, {27, 31}, {36, 40}, {45, 49}} {
		copy(normal[span[0]:span[1]], template[span[0]:span[1]])
	}
	limit := binary.LittleEndian.Uint32(body[36:])
	if !bytes.Equal(normal, template) || limit < 1 || limit >= 1<<31 || binary.LittleEndian.Uint32(body[45:]) != limit || body[21] >= 128 {
		return "unknown", nil
	}
	return "ours-patched", limit
}
func probeLS(path string, known [][]byte) (object, error) {
	data, e := os.ReadFile(path)
	if e != nil {
		return nil, e
	}
	im, e := imageText(data)
	if e != nil {
		return nil, e
	}
	infos, e := locateFunctions(data, hookNames)
	if e != nil {
		return nil, e
	}
	clamp := object{"kind": "missing", "size": nil, "body_sha256": nil, "body_hex": nil}
	if f := infos[funcClamp]; f != nil {
		body, e := region(data, im.offset+f.Entryoff, f.Size)
		if e != nil {
			return nil, e
		}
		kind, _ := classifyBody(body, known, im.arch)
		clamp = object{"kind": kind, "size": f.Size, "body_sha256": hashBytes(body), "body_hex": hex.EncodeToString(body)}
	}
	kind := str(clamp["kind"])
	size := num(clamp["size"])
	expected := 128
	if im.arch == "arm64" {
		expected = 144
	}
	verdict, note := "pass", ""
	switch {
	case kind == "missing":
		verdict = "fail"
		note = "patch target symbol not found — agyctl limit is unavailable on this build"
	case size != int64(expected):
		verdict = "fail"
		note = fmt.Sprintf("patch target size %#x != %#x — different build layout", size, expected)
	default:
		if kind != "original" && kind != "ours-patched" {
			verdict = "warn"
		}
		note = fmt.Sprintf("patch target ok (%s, size %#x)", kind, size)
		if kind == "unknown" {
			note += " — body unknown, needs re-analysis before patching"
		}
	}
	missing := []string{}
	present := 0
	symbols := object{}
	for i, n := range hookNames {
		f := infos[n]
		if f == nil {
			symbols[n] = nil
			if i > 0 {
				missing = append(missing, n)
			}
		} else {
			present++
			symbols[n] = object{"entryoff": f.Entryoff, "size": f.Size}
		}
	}
	checks := []string{note, fmt.Sprintf("context hooks present: %d/4", present)}
	if len(missing) > 0 {
		checks = append(checks, "advisory hooks absent on this binary: "+strings.Join(missing, ", "))
	}
	var gate any
	gateNote := "symbol missing"
	if im.arch != "x86-64" {
		gate = "n/a (arm64)"
		gateNote = str(gate)
	} else if f := infos[funcGate]; f != nil && f.Size > 0 {
		body, e := region(data, im.offset+f.Entryoff, f.Size)
		if e != nil {
			return nil, e
		}
		pair, _ := hex.DecodeString("81fa00e80300be00e80300")
		gate = bytes.Count(body, pair)
		gateNote = str(gate)
	}
	checks = append(checks, fmt.Sprintf("256000-clamp byte pair in %s: %s", funcGate, gateNote))
	markers := object{}
	modelChecks := []string{}
	for _, n := range markerNames {
		count := bytes.Count(data, []byte(n))
		markers[n] = count
		modelChecks = append(modelChecks, fmt.Sprintf("%s: %d", n, count))
	}
	modelsVerdict := "pass"
	if num(markers["MODEL_PLACEHOLDER"]) == 0 || num(markers["GetAvailableModels"]) == 0 {
		modelsVerdict = "fail"
	} else if num(markers["model_profiles"]) == 0 || num(markers["ListAvailableModels"]) == 0 {
		modelsVerdict = "warn"
	}
	format := binaryFormat(data)
	return object{"context": object{"verdict": verdict, "checks": checks, "patch_supported": im.arch == "x86-64" && (format == "pe" || format == "elf")}, "models": object{"verdict": modelsVerdict, "checks": modelChecks}, "fingerprint": object{"symbols": symbols, "arch": im.arch, "format": format, "clamp": clamp, "gate_3a_clamp256k": gate, "markers": markers}}, nil
}

// binaryFormat sniffs the executable container from its magic bytes. The
// capability matrix needs the container as well as the architecture: matching
// recorded function bytes alone does not qualify another format/ISA pair.
func binaryFormat(data []byte) string {
	switch {
	case bytes.HasPrefix(data, []byte("MZ")):
		return "pe"
	case bytes.HasPrefix(data, []byte("\x7fELF")):
		return "elf"
	case bytes.HasPrefix(data, []byte("\xcf\xfa\xed\xfe")),
		bytes.HasPrefix(data, []byte("\xce\xfa\xed\xfe")),
		bytes.HasPrefix(data, []byte("\xca\xfe\xba\xbe")):
		return "macho"
	default:
		return "unknown"
	}
}
func worse(a, b string) string {
	order := map[string]int{"pass": 0, "warn": 1, "fail": 2}
	if order[b] > order[a] {
		return b
	}
	return a
}
func aggregate(caps object) string {
	v := "pass"
	for _, c := range caps {
		v = worse(v, str(obj(c)["verdict"]))
	}
	return map[string]string{"pass": "compatible", "warn": "needs-review", "fail": "incompatible"}[v]
}

func loadLocalizationProfiles(root string, snap *assets.Snapshot) ([]object, error) {
	data, err := assets.ReadFile(snap, root, "compat/localization/profiles.json")
	if err != nil {
		return nil, err
	}
	if !utf8.Valid(data) {
		return nil, failure("UnicodeDecodeError", "invalid UTF-8 JSON: compat/localization/profiles.json")
	}
	var registry object
	if err := json.Unmarshal(data, &registry); err != nil {
		return nil, err
	}
	rows, ok := registry["profiles"].([]any)
	if num(registry["schema"]) != 1 || !ok {
		return nil, failure("ValueError", "invalid localization profile store")
	}
	profiles := make([]object, 0, len(rows))
	for _, row := range rows {
		profile, ok := row.(map[string]any)
		if !ok || (profile["status"] != "verified" && profile["status"] != "probe-only") {
			return nil, failure("ValueError", "invalid localization profile entry")
		}
		profiles = append(profiles, profile)
	}
	return profiles, nil
}

func probeLocalization(asarPath, lsSHA, asarSHA string, profiles []object) (object, error) {
	archive, err := openAsar(asarPath)
	if err != nil {
		return object{"verdict": "fail", "checks": []string{"app.asar unreadable: " + err.Error()}}, nil
	}
	if archive.node("dist/preload.js") == nil {
		return object{"verdict": "fail", "checks": []string{"dist/preload.js missing — localization delivery has no preload entry point"}}, nil
	}
	if _, err := archive.read("dist/preload.js"); err != nil {
		return object{"verdict": "fail", "checks": []string{"dist/preload.js unreadable: " + err.Error()}}, nil
	}
	var matched object
	for _, profile := range profiles {
		if (lsSHA != "" && profile["lsSha256"] == lsSHA) || (asarSHA != "" && profile["asarSha256"] == asarSHA) {
			matched = profile
			if profile["status"] == "verified" {
				break
			}
		}
	}
	checks := []string{"dist/preload.js present and readable"}
	if matched == nil {
		return object{"verdict": "warn", "checks": append(checks, "no localization profile records this ASAR or language server identity; feature preflight remains authoritative")}, nil
	}
	verdict := "warn"
	if matched["status"] == "verified" {
		verdict = "pass"
	}
	checks = append(checks, fmt.Sprintf("localization profile %s: %s (ASAR or language server identity matched)", str(matched["profileId"]), str(matched["status"])))
	return object{"verdict": verdict, "checks": checks, "profileId": matched["profileId"], "profileStatus": matched["status"]}, nil
}

func localizationCapability(o options, asarPath, lsSHA, asarSHA string) (object, error) {
	profiles, err := loadLocalizationProfiles(o.root, o.snap)
	if err != nil {
		return nil, err
	}
	return probeLocalization(asarPath, lsSHA, asarSHA, profiles)
}
