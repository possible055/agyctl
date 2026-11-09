package check

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
)

// The Electron fuse wire (electronjs.org/docs/latest/tutorial/fuses): the
// 32-byte ASCII sentinel, then the fuse schema version byte, the wire length
// (fuse count) byte, then one ASCII state byte per fuse: '0' = DISABLED,
// '1' = ENABLED, 'r' = REMOVED. Indexes follow the documented FuseV1Options
// schema: 0 RunAsNode, 1 EnableCookieEncryption, 2 EnableNodeOptionsEnvironmentVariable,
// 3 EnableNodeCliInspectArguments, 4 EnableEmbeddedAsarIntegrityValidation.
const fuseSentinel = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"

const (
	fuseRunAsNode      = 0
	fuseNodeCliInspect = 3
	fuseAsarIntegrity  = 4
)

var fuseNames = map[int]string{fuseRunAsNode: "run_as_node", fuseNodeCliInspect: "node_cli_inspect", fuseAsarIntegrity: "asar_integrity"}

// qualifyCapsuleIntegrity is a STATIC, read-only qualification of the
// application executable: it never modifies fuses and never weakens client
// integrity. It reports whether capsule modification is likely blocked. The
// second result is false when no application executable exists at all (for
// example fixture layouts), in which case the caller reports unknown and must
// not change the capability verdict.
func qualifyCapsuleIntegrity(root string) (object, bool) {
	candidates, e := rootExecutables(root)
	if e != nil || len(candidates) == 0 {
		return nil, false
	}
	// The fuse wire's host binary differs per platform (main executable on
	// Windows, Electron Framework on darwin), so scan every candidate in size
	// order and qualify from the first binary that carries the wire.
	for _, exe := range candidates {
		report, e := scanFuseWire(exe)
		if e != nil {
			return object{"wire_found": false, "verdict": "needs-review", "reason": e.Error(), "executable": exe}, true
		}
		if report["wire_found"] == true {
			report["executable"] = exe
			return report, true
		}
	}
	return object{"wire_found": false, "verdict": "needs-review", "reason": fmt.Sprintf("fuse wire sentinel not found in any of %d application binaries — capsule modification cannot be qualified", len(candidates)), "executable": candidates[0]}, true
}

// rootExecutables lists candidate application executables, largest first: the
// Electron main binary carries the fuse wire and dominates its directory in
// size. Layouts differ per platform — a bare root file (Windows/Linux), the
// macOS bundle's MacOS directory, and an .app bundle nested below the root
// are all known shapes the checker can read without executing anything. On
// darwin the fuse wire lives in the Electron Framework, not the launcher
// executable, so framework version directories are candidates too.
func rootExecutables(root string) ([]string, error) {
	directories := []string{root, filepath.Join(root, "MacOS")}
	if bundleRoots, e := filepath.Glob(filepath.Join(root, "*.app", "Contents", "MacOS")); e == nil {
		directories = append(directories, bundleRoots...)
	}
	if frameworks, e := filepath.Glob(filepath.Join(root, "Frameworks", "*.framework", "Versions", "A")); e == nil {
		directories = append(directories, frameworks...)
	}
	if bundleFrameworks, e := filepath.Glob(filepath.Join(root, "*.app", "Contents", "Frameworks", "*.framework", "Versions", "A")); e == nil {
		directories = append(directories, bundleFrameworks...)
	}
	type sized struct {
		path string
		size int64
	}
	var out []sized
	for _, directory := range directories {
		entries, e := os.ReadDir(directory)
		if e != nil {
			if os.IsNotExist(e) && directory != root {
				continue
			}
			return nil, e
		}
		for _, entry := range entries {
			if !entry.Type().IsRegular() {
				continue
			}
			info, e := entry.Info()
			if e != nil {
				return nil, e
			}
			out = append(out, sized{filepath.Join(directory, entry.Name()), info.Size()})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].size > out[j].size })
	paths := []string{}
	for _, item := range out {
		paths = append(paths, item.path)
	}
	return paths, nil
}

// scanFuseWire streams the executable looking for the sentinel; when found it
// reads the bounded wire (32-byte sentinel, version, count, up to 255 states)
// directly at that offset and parses it.
func scanFuseWire(path string) (object, error) {
	f, e := os.Open(path)
	if e != nil {
		return nil, e
	}
	defer func() { _ = f.Close() }()
	const windowSize = 1 << 20
	buf := make([]byte, 0, windowSize+512)
	bufStart := int64(0)
	for {
		chunk := make([]byte, windowSize)
		n, readErr := f.Read(chunk)
		if n > 0 {
			buf = append(buf, chunk[:n]...)
			if idx := bytes.Index(buf, []byte(fuseSentinel)); idx >= 0 {
				wire := make([]byte, len(fuseSentinel)+2+255)
				read, _ := f.ReadAt(wire, bufStart+int64(idx))
				return parseFuseWire(wire[:read]), nil
			}
			if len(buf) > 512 {
				dropped := len(buf) - 512
				buf = append(buf[:0], buf[dropped:]...)
				bufStart += int64(dropped)
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return nil, readErr
		}
	}
	return object{"wire_found": false, "verdict": "needs-review", "reason": fmt.Sprintf("fuse wire sentinel not found in %s — capsule modification cannot be qualified", filepath.Base(path))}, nil
}

// parseFuseWire qualifies a wire captured as bytes, sentinel included.
func parseFuseWire(data []byte) object {
	idx := bytes.Index(data, []byte(fuseSentinel))
	if idx < 0 {
		return object{"wire_found": false, "verdict": "needs-review", "reason": "fuse wire sentinel not found"}
	}
	rest := data[idx+len(fuseSentinel):]
	if len(rest) < 2 {
		return object{"wire_found": true, "verdict": "needs-review", "reason": fmt.Sprintf("fuse wire truncated after the sentinel at offset %d", idx)}
	}
	version, count := int(rest[0]), int(rest[1])
	if len(rest) < 2+count {
		return object{"wire_found": true, "verdict": "needs-review", "reason": fmt.Sprintf("fuse wire declares %d fuses but only %d state bytes follow the sentinel", count, len(rest)-2)}
	}
	// The indexes below are only meaningful for the documented schema: an
	// unknown version byte or a wire that does not declare every fuse we read
	// must not degrade to a bare allowed verdict.
	if version != 1 {
		return object{"wire_found": true, "fuse_schema_version": version, "fuse_count": count, "verdict": "needs-review", "reason": fmt.Sprintf("unknown fuse schema version %d — the documented fuse indexes cannot be interpreted", version)}
	}
	if count <= fuseAsarIntegrity {
		return object{"wire_found": true, "fuse_schema_version": version, "fuse_count": count, "verdict": "needs-review", "reason": fmt.Sprintf("fuse wire declares only %d fuses; the indexed fuses are not all declared, so capsule modification is not qualified", count)}
	}
	fuses := object{}
	unknown := false
	for index, name := range fuseNames {
		if index >= count {
			fuses[name] = nil
			continue
		}
		state := fuseState(rest[2+index])
		if state == "unknown" {
			unknown = true
		}
		fuses[name] = state
	}
	report := object{"wire_found": true, "fuse_schema_version": version, "fuse_count": count, "fuses": fuses}
	if fuses["asar_integrity"] == "enabled" {
		report["verdict"] = "blocked"
		report["reason"] = "EnableEmbeddedAsarIntegrityValidation is ENABLED — capsule modification would break ASAR integrity enforcement"
		return report
	}
	if unknown {
		report["verdict"] = "needs-review"
		report["reason"] = "fuse wire contains unknown state bytes — schema not understood"
		return report
	}
	report["verdict"] = "allowed"
	report["reason"] = "no integrity-enforcing fuse blocks capsule modification (read-only qualification; fuses untouched)"
	return report
}

func fuseState(b byte) string {
	switch b {
	case '1':
		return "enabled"
	case '0':
		return "disabled"
	case 'r':
		return "removed"
	default:
		return "unknown"
	}
}

// attachCapsuleIntegrity folds the fuse qualification into the ui capability.
// An absent application executable is qualification-incomplete: the capability
// degrades to needs-review so it can never surface as an available claim.
func attachCapsuleIntegrity(ui object, root string) {
	report, found := qualifyCapsuleIntegrity(root)
	if !found {
		ui["capsuleIntegrity"] = object{"verdict": "needs-review", "reason": "no application executable found — fuse qualification unknown, capsule modification not qualified"}
		ui["verdict"] = worse(str(ui["verdict"]), "warn")
		ui["checks"] = append(stringsOf(ui["checks"]), "no application executable found — fuse qualification unknown, capsule modification not qualified")
		return
	}
	ui["capsuleIntegrity"] = report
	switch str(report["verdict"]) {
	case "blocked":
		ui["verdict"] = worse(str(ui["verdict"]), "fail")
		ui["checks"] = append(stringsOf(ui["checks"]), "capsule modification blocked: "+str(report["reason"]))
	case "needs-review":
		ui["verdict"] = worse(str(ui["verdict"]), "warn")
		ui["checks"] = append(stringsOf(ui["checks"]), "capsule modification not qualified: "+str(report["reason"]))
	default:
		ui["checks"] = append(stringsOf(ui["checks"]), "capsule modification qualified: "+str(report["reason"]))
	}
}
