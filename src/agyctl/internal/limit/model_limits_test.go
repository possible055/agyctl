package limit

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"agyctl/internal/fsx"
	"agyctl/internal/lspatch"
	"agyctl/internal/testutil"
)

func modelFixtureCaves(t *testing.T, original []byte) []byte {
	t.Helper()
	data := bytes.Clone(original)
	im, err := parseImage(data)
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	last := im.entries[im.index] + funcSizeAMD64
	for i := im.index + 2; i < len(im.entries)-1 && count < 2; i++ {
		va := im.entries[i]
		if va < last+24 {
			continue
		}
		off, err := im.offset(va-24, 24)
		if err != nil {
			t.Fatal(err)
		}
		copy(data[off:off+24], bytes.Repeat([]byte{0xcc}, 24))
		last = va
		count++
	}
	if count != 2 {
		t.Fatal("synthetic image has no space for two guarded caves")
	}
	return data
}

func TestPerModelAssemblyContract(t *testing.T) {
	body, err := AssembleModelLimits(0x1000, 0x1014)
	const want = "4885c074794885db74748b5308488d35000000003916740d48637e0885ff74104801feebef8b560439500c730389500c83780c0075108b531481ea409c00007f0231d289500c8b531485d27e1189d629ca39f10f42f239700c760389700c488b48504885c9741780390074128b4b7085c97e0b8b501039ca0f47d1895010c3cc"
	if err != nil || hex.EncodeToString(body) != want {
		t.Fatalf("linked-v2 body = %x (%v)", body, err)
	}
}

func TestSummaryABIAssemblyPreservesRuntimeBoundaries(t *testing.T) {
	original, err := hex.DecodeString(summaryOriginalHex)
	if err != nil {
		t.Fatal(err)
	}
	body, err := assembleSummaryLimits(0x141821280, 0x141822000)
	if err != nil {
		t.Fatal(err)
	}
	if len(body) != 352 || !bytes.Equal(body[:0x20], original[:0x20]) || !bytes.Equal(body[0x9e:0xa8], original[0x9e:0xa8]) || !bytes.Equal(body[0x102:], original[0x102:]) {
		t.Fatal("summary ABI changed the frame, argument roots, call PC, epilogues or morestack path")
	}
	if got := int64(0x141821280+0x34) + int64(int32(binary.LittleEndian.Uint32(body[0x30:]))); got != 0x141822000 {
		t.Fatalf("summary table VA = %#x", got)
	}
	if !supportedOriginal("x86-64", original) || supportedOriginal("arm64", original) {
		t.Fatal("summary ABI admitted the wrong architecture")
	}
	changed := bytes.Clone(original)
	changed[0x40] ^= 1
	if supportedOriginal("x86-64", changed) {
		t.Fatal("summary ABI accepted a size-only match with unknown native instructions")
	}
	newOriginal := summaryOriginal2340()
	newBody, err := assembleSummaryLimitsForOriginal(newOriginal, 0x141839640, 0x141839c00)
	if err != nil || !supportedOriginal("x86-64", newOriginal) || !bytes.Equal(newBody[0x102:], newOriginal[0x102:]) || bytes.Equal(newBody[0x102:], original[0x102:]) {
		t.Fatalf("2.34.0 summary ABI did not preserve its own morestack path: %v", err)
	}
	if recovered, ok := summaryOriginalForBody(newBody); !ok || !bytes.Equal(recovered, newOriginal) {
		t.Fatal("2.34.0 patched summary body did not recover its exact original ABI")
	}
}

func TestPerModelSettingsGrammar(t *testing.T) {
	values, err := ParseModelLimits("1400=500000,1318=300000")
	want := []ModelLimit{{ID: 1318, Limit: 300000}, {ID: 1400, Limit: 500000}}
	if err != nil || !reflect.DeepEqual(values, want) {
		t.Fatalf("mapping = %v (%v)", values, err)
	}
	for _, spec := range []string{"", "1=0", "0=3", "-1=3", "1=+3", "1=2147483648", "2147483648=1", "1=2,1=3", "1=2,", " 1=2", "1 =2"} {
		if _, err := ParseModelLimits(spec); err == nil {
			t.Fatalf("accepted invalid mapping %q", spec)
		}
	}
	if _, err := ParseModelLimits(strings.Repeat("1=2,", 128) + "2=3"); err == nil {
		t.Fatal("accepted oversized mapping")
	}
	if _, err := parseOptions([]string{"patch", "--model-limits", "1=2", "--limit", "3"}); err == nil || !strings.Contains(err.Error(), "cannot be combined") {
		t.Fatalf("mixed options: %v", err)
	}
	for _, flag := range []string{"--limit", "--model-limits"} {
		for _, value := range []string{"983040", "983041"} {
			argument := value
			if flag == "--model-limits" {
				argument = "1318=" + value
			}
			_, err := parseOptions([]string{"patch", flag, argument})
			if value == "983040" && err != nil {
				t.Fatalf("rejected inclusive upper bound via %s: %v", flag, err)
			}
			if value == "983041" && (err == nil || !strings.Contains(err.Error(), "must not exceed 983040")) {
				t.Fatalf("oversized limit via %s: %v", flag, err)
			}
		}
	}
}

func TestExplicitBinaryOverridesEnvironmentWithoutWrites(t *testing.T) {
	directory := testutil.TempDir(t)
	stateHome := filepath.Join(directory, "state")
	t.Setenv("AGYCTL_APP_DIR", "invalid-relative-root")
	t.Setenv("AGYCTL_HOME", stateHome)
	_, data := fixtures(t)
	binary := filepath.Join(directory, "language_server.bin")
	if err := os.WriteFile(binary, data, 0600); err != nil {
		t.Fatal(err)
	}
	for _, command := range []string{"status", "patch"} {
		value, code, err := Run(filepath.Join("..", "..", "..", ".."), nil, []string{command, "--binary", binary})
		if code != 0 || err != nil {
			t.Fatalf("explicit %s code=%d error=%v", command, code, err)
		}
		result := value.(map[string]any)
		if result["binary"] != binary {
			t.Fatalf("explicit %s selected %v", command, result["binary"])
		}
	}
	current, err := os.ReadFile(binary)
	if err != nil || !bytes.Equal(current, data) {
		t.Fatalf("read-only command changed the binary: %v", err)
	}
	if _, err := os.Stat(stateHome); !os.IsNotExist(err) {
		t.Fatalf("read-only command created tool state: %v", err)
	}
}

func TestPerModelPatchReadbackAndRestore(t *testing.T) {
	reg, pe := fixtures(t)
	values := []ModelLimit{{ID: 1318, Limit: 300000}, {ID: 1400, Limit: 500000}}
	for _, image := range []struct {
		name string
		data []byte
	}{{"pe", modelFixtureCaves(t, pe)}, {"elf", modelFixtureCaves(t, elfFixture(t))}} {
		t.Run(image.name, func(t *testing.T) {
			plan, err := PlanModelPatch(image.data, values)
			if err != nil {
				t.Fatal(err)
			}
			patched := ApplyPatch(image.data, plan)
			state, err := DetectState(patched, reg.originals)
			if err != nil || state.Kind != "patched" || state.Encoding != modelEncoding || !reflect.DeepEqual(state.ModelLimits, values) {
				t.Fatalf("readback = %+v (%v)", state, err)
			}
			for _, withManifest := range []bool{true, false} {
				directory := testutil.TempDir(t)
				target := filepath.Join(directory, "language_server.bin")
				s := store{directory: filepath.Join(directory, "state")}
				if err := os.WriteFile(target, image.data, 0600); err != nil {
					t.Fatal(err)
				}
				settings := patchSettings{Encoding: modelEncoding, ModelLimits: values}
				if withManifest {
					if _, err := patchBinarySettings(target, image.data, patched, fsx.SHA256(image.data), "", "unverified", settings, plan, s, ""); err != nil {
						t.Fatal(err)
					}
				} else {
					if err := os.WriteFile(target+".orig", image.data, 0600); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(target, patched, 0600); err != nil {
						t.Fatal(err)
					}
				}
				reported, statusErr := status(target, reg, s, nil)
				wantSettingsState := "applied-unrecorded"
				if withManifest {
					wantSettingsState = "applied"
				}
				if statusErr != nil {
					t.Fatal(statusErr)
				}
				summary := reported.(map[string]any)
				if summary["settings_state"] != wantSettingsState || !reflect.DeepEqual(summary["patch_state"].(map[string]any)["model_limits"], values) {
					t.Fatalf("per-model status = %+v", summary)
				}
				o, err := parseOptions([]string{"patch"})
				if err != nil {
					t.Fatal(err)
				}
				result, err := patch(target, o, reg, s, nil)
				if err != nil || result["already_patched"] != true || result["settings_source"] != "installed" {
					t.Fatalf("restart patch = %v (%v)", result, err)
				}
				if withManifest {
					if err := os.WriteFile(target, image.data, 0600); err != nil {
						t.Fatal(err)
					}
					result, err = patch(target, o, reg, s, nil)
					if err != nil || result["settings_source"] != "saved" || !reflect.DeepEqual(result["model_limits"], values) {
						t.Fatalf("updated binary settings = %v (%v)", result, err)
					}
					if err := os.WriteFile(target, patched, 0600); err != nil {
						t.Fatal(err)
					}
				}
				if _, err := restoreBinary(target, reg, s, ""); err != nil {
					t.Fatal(err)
				}
				restored, err := os.ReadFile(target)
				if err != nil || !bytes.Equal(restored, image.data) {
					t.Fatalf("restore mismatch (%v)", err)
				}
				result, err = patch(target, o, reg, s, nil)
				if err != nil || result["settings_source"] != "defaults" {
					t.Fatalf("explicit restore must not reuse saved patch = %v (%v)", result, err)
				}
			}
		})
	}
}

func TestPerModelMalformedTableIsUnknown(t *testing.T) {
	reg, original := fixtures(t)
	original = modelFixtureCaves(t, original)
	plan, err := PlanModelPatch(original, []ModelLimit{{ID: 1318, Limit: 300000}, {ID: 1400, Limit: 500000}})
	if err != nil {
		t.Fatal(err)
	}
	patched := ApplyPatch(original, plan)
	cases := []struct {
		name   string
		mutate func([]byte)
	}{
		{"magic", func(data []byte) { data[plan.Nodes[0].Offset+12] ^= 1 }},
		{"cycle", func(data []byte) {
			binary.LittleEndian.PutUint32(data[plan.Nodes[1].Offset+8:], uint32(int32(int64(plan.Nodes[0].VA)-int64(plan.Nodes[1].VA))))
		}},
		{"outside cave", func(data []byte) { binary.LittleEndian.PutUint32(data[plan.Nodes[0].Offset+8:], 1) }},
		{"duplicate", func(data []byte) { binary.LittleEndian.PutUint32(data[plan.Nodes[1].Offset:], 1318) }},
		{"zero limit", func(data []byte) { binary.LittleEndian.PutUint32(data[plan.Nodes[0].Offset+4:], 0) }},
		{"guard", func(data []byte) { data[plan.Nodes[0].Offset-1] = 0 }},
		{"body", func(data []byte) { data[plan.FuncOff+37] ^= 1 }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			data := bytes.Clone(patched)
			tc.mutate(data)
			state, err := DetectState(data, reg.originals)
			if err != nil || state.Kind != "unknown" {
				t.Fatalf("malformed state = %+v (%v)", state, err)
			}
		})
	}
}

func TestPerModelDryRunDoesNotCompletePrepare(t *testing.T) {
	reg, original := fixtures(t)
	original = modelFixtureCaves(t, original)
	values := []ModelLimit{{ID: 1318, Limit: 300000}, {ID: 1400, Limit: 500000}}
	plan, err := PlanModelPatch(original, values)
	if err != nil {
		t.Fatal(err)
	}
	patched := ApplyPatch(original, plan)
	directory := testutil.TempDir(t)
	target := filepath.Join(directory, "language_server.bin")
	s := store{directory: filepath.Join(directory, "state")}
	if err := os.WriteFile(target, original, 0600); err != nil {
		t.Fatal(err)
	}
	record, err := patchBinarySettings(target, original, patched, fsx.SHA256(original), "", "unverified", patchSettings{Encoding: modelEncoding, ModelLimits: values}, plan, s, "")
	if err != nil {
		t.Fatal(err)
	}
	key, err := normalized(target)
	if err != nil {
		t.Fatal(err)
	}
	prepared := prepareRecord{Target: key, OriginalSHA: fsx.SHA256(original), NewSHA: fsx.SHA256(patched), ModelLimits: values, Encoding: modelEncoding, Backups: []prepareBackup{{Kind: "sibling", Path: stringField(record, "backup_sibling"), SHA256: fsx.SHA256(original)}}}
	if err = s.writePrepare(prepared); err != nil {
		t.Fatal(err)
	}
	if err = os.Remove(s.path()); err != nil {
		t.Fatal(err)
	}
	prepPath, err := s.preparePath(target)
	if err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(prepPath)
	if err != nil {
		t.Fatal(err)
	}
	o, err := parseOptions([]string{"patch"})
	if err != nil {
		t.Fatal(err)
	}
	result, err := patch(target, o, reg, s, nil)
	if err != nil || result["already_patched"] != true || result["prepare_record_completed"] != nil {
		t.Fatalf("dry run = %v (%v)", result, err)
	}
	after, err := os.ReadFile(prepPath)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatalf("prepare changed during dry run (%v)", err)
	}
	if _, err = os.Stat(s.path()); !os.IsNotExist(err) {
		t.Fatalf("dry run created manifest: %v", err)
	}
	o, err = parseOptions([]string{"patch", "--apply"})
	if err != nil {
		t.Fatal(err)
	}
	result, err = patch(target, o, reg, s, nil)
	if err != nil || result["prepare_record_completed"] != true {
		t.Fatalf("complete = %v (%v)", result, err)
	}
	last, err := s.last(target)
	if err != nil {
		t.Fatal(err)
	}
	settings, err := settingsFromRecord(last)
	if err != nil || !reflect.DeepEqual(settings.ModelLimits, values) {
		t.Fatalf("completed settings = %+v (%v)", settings, err)
	}
}

func TestNativeLimitAdoptsLegacyAndReservesDisabledRecipeGuards(t *testing.T) {
	root := filepath.Join("..", "..", "..", "..")
	_, original := fixtures(t)
	original = modelFixtureCaves(t, original)
	values := []ModelLimit{{ID: 1318, Limit: 300000}}
	first, err := PlanModelPatch(original, values)
	if err != nil {
		t.Fatal(err)
	}
	guardOffset := first.Nodes[0].Offset - 8
	reserved := []lspatch.Span{{Offset: guardOffset, Expected: []byte{0xcc}, Replacement: []byte{0xcd}}}
	canonical, err := PlanModelPatchReserved(original, values, reserved)
	if err != nil {
		t.Fatal(err)
	}
	if canonical.Nodes[0].Offset == first.Nodes[0].Offset {
		t.Fatal("limit reused a disabled fixed recipe's guard")
	}
	for _, encoding := range []string{"", modelEncoding} {
		t.Run("legacy-"+encoding, func(t *testing.T) {
			directory := testutil.TempDir(t)
			binary := filepath.Join(directory, "server.bin")
			s := store{directory: filepath.Join(directory, "state")}
			if err := os.WriteFile(binary, original, 0600); err != nil {
				t.Fatal(err)
			}
			settings := patchSettings{Encoding: encoding, ModelLimits: values}
			if encoding == "" {
				settings.IDs = []int{1318}
				settings.Limit = 300000
			}
			plan, err := planSettings(original, settings)
			if err != nil {
				t.Fatal(err)
			}
			patched := ApplyPatch(original, plan)
			if _, err := patchBinarySettings(binary, original, patched, fsx.SHA256(original), "", "unverified", settings, plan, s, "legacy"); err != nil {
				t.Fatal(err)
			}
			history, err := os.ReadFile(s.path())
			if err != nil {
				t.Fatal(err)
			}
			ref, err := NativeReference(root, nil)
			if err != nil {
				t.Fatal(err)
			}
			spec := lspatch.Spec{ID: "fixture", BaseSHA: fsx.SHA256(original), Size: len(original), LimitRef: ref, LegacyLimitRefs: NativeLegacyReferences(ref), ToolOutput: &lspatch.Contribution{Ref: lspatch.RecipeRef{ID: "fixture-tool", Fingerprint: fsx.SHA256([]byte("tool"))}, Spans: reserved}}
			spec.Limit = func(base []byte, config lspatch.LimitConfig, reserved []lspatch.Span, ref lspatch.RecipeRef) (lspatch.Contribution, error) {
				return NativeContribution(root, nil, base, config, reserved, ref)
			}
			engine := lspatch.Engine{Directory: s.directory, AssetsFingerprint: fsx.SHA256([]byte("assets")), Specs: []lspatch.Spec{spec}, RequireStopped: func(string) error { return nil }}
			engine.Legacy = func(binary string, current, base []byte, spec lspatch.Spec) (*lspatch.Legacy, error) {
				return NativeLegacy(root, nil, s.directory, binary, current, base, spec)
			}
			status, err := engine.Status(binary)
			if err != nil || status["verified"] != true || status["file_state"] != "legacy" {
				t.Fatalf("legacy proof: %v %v", status, err)
			}
			owned, err := lspatch.HasState(s.directory, binary)
			if err != nil || owned {
				t.Fatalf("status adopted legacy state: %v %v", owned, err)
			}
			enabled := true
			desired := lspatch.Desired{ToolOutput: &enabled}
			reviewed, err := engine.Plan(binary, desired)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := engine.Apply(binary, desired, reviewed.Expected, "native"); err != nil {
				t.Fatal(err)
			}
			current, err := os.ReadFile(binary)
			if err != nil {
				t.Fatal(err)
			}
			if current[guardOffset] != 0xcd || !bytes.Equal(current[canonical.FuncOff:canonical.FuncOff+len(canonical.Body)], canonical.Body) || !bytes.Equal(current[canonical.Nodes[0].Offset:canonical.Nodes[0].Offset+16], canonical.Nodes[0].Data) {
				t.Fatal("adoption did not rebuild limit against the fixed reserved layout")
			}
			afterHistory, err := os.ReadFile(s.path())
			if err != nil || !bytes.Equal(history, afterHistory) {
				t.Fatalf("legacy history was modified: %v", err)
			}
			status, err = engine.Status(binary)
			if err != nil || status["verified"] != true || status["file_state"] != "managed" {
				t.Fatalf("managed proof: %v %v", status, err)
			}
		})
	}
}
