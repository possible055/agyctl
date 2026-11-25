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

// This screening template is intentionally independent of the limit assembler.
const summaryPatchHex = "493b66100f86fc000000554889e54883ec20488944243048895c24380f1f40004885c974744885ff746f8b57084c8d0500000000413910740e4d6348084585c974114d01c8ebed418b500439510c730389510c83790c007512486357144881ea409c0000790231d289510c8b571485d27e0e39f2760229f239510c760389510c837940037418488b51504885d2740a803a0074058b5770eb4ee96400000048894c2440e8b8fdffff4885db75554885c07450837814007e278b50704531c085d2410f4ed03950147e16448b40144129d0488b4c24404439410c76044489410c488b4c24408b507085d27e173951107612895110909090909090909090909090909090c9c3c9c3488944240848895c241048894c241848897c2420897424286690e85b5087fe488b442408488b5c2410488b4c2418488b7c24208b7424280f1f00e9bbfeffffcccccccccccccccccccccccccccccccccccccccccccccccccccccc"

func linkedPatchTemplate() []byte {
	head, _ := hex.DecodeString("4885c074794885db74748b5308488d35000000003916740d48637e0885ff74104801feebef8b560439500c730389500c")
	legacy, _ := hex.DecodeString(patchHex)
	return append(append(head, legacy[49:]...), 0xcc)
}

func isLinkedPatchBody(body []byte) bool {
	if len(body) != 128 && len(body) != 352 {
		return false
	}
	template := linkedPatchTemplate()
	displacement := 16
	if len(body) == 352 {
		template, _ = hex.DecodeString(summaryPatchHex)
		displacement = 0x30
		for _, morestack := range [][3]byte{{0x5b, 0x50, 0x87}, {0x3b, 0xcd, 0x85}, {0x3b, 0xd9, 0x85}} {
			candidate := bytes.Clone(template)
			copy(candidate[289:292], morestack[:])
			normal := bytes.Clone(body)
			copy(normal[displacement:displacement+4], candidate[displacement:displacement+4])
			if bytes.Equal(normal, candidate) {
				return true
			}
		}
		return false
	}
	normal := bytes.Clone(body)
	copy(normal[displacement:displacement+4], template[displacement:displacement+4])
	return bytes.Equal(normal, template)
}

// Reads the linked per-model table independently; this is not the patcher's
// original-byte, placement, or recovery gate.
func linkedPatchLimits(data []byte, im image, f *Function, body []byte) ([]object, bool) {
	if !isLinkedPatchBody(body) || f.Entryoff > uint64(len(data)) {
		return nil, false
	}
	displacement, relative := 16, 20
	if len(body) == 352 {
		displacement, relative = 0x30, 0x34
	}
	position := int64(f.Entryoff) + int64(relative) + int64(int32(binary.LittleEndian.Uint32(body[displacement:displacement+4])))
	limits := []object{}
	lastID := uint32(0)
	for len(limits) < 128 {
		if position < int64(f.Entryoff)+int64(len(body))+8 || uint64(position) > im.size || im.size-uint64(position) < 16 {
			return nil, false
		}
		guard, err := region(data, im.offset+uint64(position)-8, 24)
		if err != nil || !bytes.Equal(guard[:8], bytes.Repeat([]byte{0xcc}, 8)) {
			return nil, false
		}
		node := guard[8:]
		id, target := binary.LittleEndian.Uint32(node), binary.LittleEndian.Uint32(node[4:])
		if string(node[12:]) != "AGL2" || id <= lastID || id >= 1<<31 || target < 1 || target >= 1<<31 {
			return nil, false
		}
		limits = append(limits, object{"id": id, "limit": target})
		lastID = id
		next := int32(binary.LittleEndian.Uint32(node[8:]))
		if next == 0 {
			return limits, true
		}
		if next < 24 {
			return nil, false
		}
		position += int64(next)
	}
	return nil, false
}

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
		if im.arch == "x86-64" && isLinkedPatchBody(body) {
			if limits, valid := linkedPatchLimits(data, im, f, body); valid {
				clamp["kind"], clamp["patch_format"], clamp["model_limits"] = "ours-patched", "linked-v2", limits
				if len(body) == 352 {
					clamp["patch_format"] = "linked-v3-summary"
				}
			}
		}
	}
	kind := str(clamp["kind"])
	size := num(clamp["size"])
	expected := 128
	if im.arch == "x86-64" && binaryFormat(data) == "pe" && size == 352 && (kind == "original" || kind == "ours-patched") {
		expected = 352
	}
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
