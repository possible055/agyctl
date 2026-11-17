package limit

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"

	"agyctl/internal/lspatch"
)

const maxModelLimits = 128
const modelEncoding = "linked-v2"

type ModelLimit = lspatch.ModelLimit

type TableWrite struct {
	VA     uint64 `json:"va"`
	Offset int    `json:"offset"`
	Data   []byte `json:"-"`
}

func uniformLimits(ids []int, target int) []ModelLimit {
	values := make([]ModelLimit, len(ids))
	for i, id := range ids {
		values[i] = ModelLimit{ID: id, Limit: target}
	}
	return values
}

func validateModelLimits(values []ModelLimit, minimumID int) error {
	if len(values) == 0 || len(values) > maxModelLimits {
		return fmt.Errorf("model limits require 1..%d entries", maxModelLimits)
	}
	for i, value := range values {
		if value.ID < minimumID || int64(value.ID) > math.MaxInt32 || value.Limit < 1 || int64(value.Limit) > math.MaxInt32 {
			return fmt.Errorf("model IDs must be int32 values >= %d and limits must be positive int32 values", minimumID)
		}
		if i > 0 && values[i-1].ID >= value.ID {
			return fmt.Errorf("model IDs must be sorted and unique")
		}
	}
	return nil
}

func ParseModelLimits(spec string) ([]ModelLimit, error) {
	values := []ModelLimit{}
	for _, term := range strings.Split(spec, ",") {
		parts := strings.Split(term, "=")
		if len(parts) != 2 {
			return nil, fmt.Errorf("invalid model limit %q (expected ID=LIMIT)", term)
		}
		pair := [2]int{}
		for i, part := range parts {
			if part == "" || strings.IndexFunc(part, func(r rune) bool { return r < '0' || r > '9' }) >= 0 {
				return nil, fmt.Errorf("invalid model limit %q (positive decimal integers required)", term)
			}
			n, err := strconv.ParseInt(part, 10, 32)
			if err != nil || n < 1 {
				return nil, fmt.Errorf("invalid model limit %q (positive int32 required)", term)
			}
			pair[i] = int(n)
		}
		values = append(values, ModelLimit{ID: pair[0], Limit: pair[1]})
	}
	sort.Slice(values, func(i, j int) bool { return values[i].ID < values[j].ID })
	if err := validateModelLimits(values, 1); err != nil {
		return nil, err
	}
	return values, nil
}

// AssembleModelLimits preserves RCX, which the unchanged clamp tail uses as the output allowance.
func AssembleModelLimits(funcVA, tableVA uint64) ([]byte, error) {
	if funcVA > math.MaxInt64 || tableVA > math.MaxInt64 {
		return nil, fmt.Errorf("address outside signed displacement range")
	}
	disp := int64(tableVA) - int64(funcVA) - 20
	if disp < math.MinInt32 || disp > math.MaxInt32 {
		return nil, fmt.Errorf("table displacement out of range")
	}
	head, err := hex.DecodeString("4885c074794885db74748b5308488d35000000003916740d48637e0885ff74104801feebef8b560439500c730389500c")
	if err != nil {
		return nil, err
	}
	binary.LittleEndian.PutUint32(head[16:], uint32(disp))
	legacy, err := Assemble([]int{1}, 1, funcVA, tableVA)
	if err != nil {
		return nil, err
	}
	body := append(head, legacy[49:]...)
	return append(body, 0xcc), nil
}

// modelCaves admits only the same bounded, guarded 16-byte int3 locations as the legacy planner.
func (im *image) modelCaves(data []byte) ([]TableWrite, error) {
	nodes := []TableWrite{}
	end := min(im.index+5000, len(im.entries)-1)
	entry := im.entries[im.index]
	for i := im.index + 2; i < end; i++ {
		va := im.entries[i]
		if va < im.textVA+24 || va-24 < entry+funcSizeAMD64 {
			continue
		}
		off, err := im.offset(va-24, 24)
		if err != nil {
			return nil, err
		}
		if !bytes.Equal(data[off:off+8], bytes.Repeat([]byte{0xcc}, 8)) {
			continue
		}
		candidate := TableWrite{VA: va - 16, Offset: off + 8}
		if len(nodes) > 0 && candidate.VA < nodes[len(nodes)-1].VA+24 {
			continue
		}
		nodes = append(nodes, candidate)
	}
	return nodes, nil
}

func PlanModelPatch(data []byte, values []ModelLimit) (Plan, error) {
	if err := validateModelLimits(values, 1); err != nil {
		return Plan{}, err
	}
	im, err := parseImage(data)
	if err != nil {
		return Plan{}, err
	}
	return im.planModelPatch(data, values, nil)
}

func (im *image) planModelPatch(data []byte, values []ModelLimit, restored map[int]bool) (Plan, error) {
	return im.planModelPatchReserved(data, values, restored, nil)
}

// PlanModelPatchReserved allocates against the original image and excludes the
// complete write and guard spans of every registered fixed native recipe.
func PlanModelPatchReserved(data []byte, values []ModelLimit, reserved []lspatch.Span) (Plan, error) {
	im, err := parseImage(data)
	if err != nil {
		return Plan{}, err
	}
	return im.planModelPatchReserved(data, values, nil, reserved)
}

func (im *image) planModelPatchReserved(data []byte, values []ModelLimit, restored map[int]bool, reserved []lspatch.Span) (Plan, error) {
	if err := validateModelLimits(values, 1); err != nil {
		return Plan{}, err
	}
	if im.arch != "x86-64" {
		return Plan{}, fmt.Errorf("macOS limit patching unavailable: original bytes, code placement and signing strategy are not qualified")
	}
	entry := im.entries[im.index]
	if im.entries[im.index+1]-entry != funcSizeAMD64 {
		return Plan{}, fmt.Errorf("%s is not %#x bytes; different build?", Func, funcSizeAMD64)
	}
	nodes := []TableWrite{}
	caves, err := im.modelCaves(data)
	if err != nil {
		return Plan{}, err
	}
	for _, node := range caves {
		blocked := false
		for _, span := range reserved {
			if node.Offset-8 < span.Offset+len(span.Expected) && span.Offset < node.Offset+16 {
				blocked = true
				break
			}
		}
		if blocked {
			continue
		}
		if restored[node.Offset] || bytes.Equal(data[node.Offset:node.Offset+16], bytes.Repeat([]byte{0xcc}, 16)) {
			nodes = append(nodes, node)
		}
		if len(nodes) == len(values) {
			break
		}
	}
	if len(nodes) != len(values) {
		return Plan{}, fmt.Errorf("not enough guarded int3 padding caves for %d model limits", len(values))
	}
	for i := range nodes {
		raw := make([]byte, 16)
		binary.LittleEndian.PutUint32(raw, uint32(values[i].ID))
		binary.LittleEndian.PutUint32(raw[4:], uint32(values[i].Limit))
		if i+1 < len(nodes) {
			disp := int64(nodes[i+1].VA) - int64(nodes[i].VA)
			if disp <= 0 || disp > math.MaxInt32 {
				return Plan{}, fmt.Errorf("model table displacement out of range")
			}
			binary.LittleEndian.PutUint32(raw[8:], uint32(disp))
		}
		copy(raw[12:], "AGL2")
		nodes[i].Data = raw
	}
	body, err := AssembleModelLimits(entry, nodes[0].VA)
	if err != nil {
		return Plan{}, err
	}
	off, err := im.offset(entry, funcSizeAMD64)
	if err != nil {
		return Plan{}, err
	}
	return Plan{TextVA: im.textVA, FuncVA: entry, FuncOff: off, TableVA: nodes[0].VA, TableOff: nodes[0].Offset, Body: body, ModelLimits: values, Nodes: nodes}, nil
}

func (im *image) detectModelPatch(data []byte, state PatchState, body []byte) (PatchState, bool) {
	entry := im.entries[im.index]
	disp := int64(int32(binary.LittleEndian.Uint32(body[16:])))
	first := int64(entry) + 20 + disp
	if first < 0 {
		return state, false
	}
	expected, err := AssembleModelLimits(entry, uint64(first))
	if err != nil || !bytes.Equal(body, expected) {
		return state, false
	}
	allowed := map[uint64]TableWrite{}
	caves, err := im.modelCaves(data)
	if err != nil {
		return state, false
	}
	for _, node := range caves {
		allowed[node.VA] = node
	}
	values := []ModelLimit{}
	seen := map[uint64]bool{}
	restored := map[int]bool{}
	va := uint64(first)
	for {
		node, ok := allowed[va]
		if !ok || seen[va] || len(values) >= maxModelLimits {
			return state, false
		}
		seen[va] = true
		raw := data[node.Offset : node.Offset+16]
		if string(raw[12:]) != "AGL2" {
			return state, false
		}
		values = append(values, ModelLimit{ID: int(binary.LittleEndian.Uint32(raw)), Limit: int(binary.LittleEndian.Uint32(raw[4:]))})
		restored[node.Offset] = true
		next := int64(int32(binary.LittleEndian.Uint32(raw[8:])))
		if next == 0 {
			break
		}
		target := int64(va) + next
		if target < 0 {
			return state, false
		}
		va = uint64(target)
	}
	plan, err := im.planModelPatch(data, values, restored)
	if err != nil || !bytes.Equal(plan.Body, body) {
		return state, false
	}
	for _, node := range plan.Nodes {
		if !bytes.Equal(node.Data, data[node.Offset:node.Offset+16]) {
			return state, false
		}
	}
	state.Kind = "patched"
	state.Encoding = modelEncoding
	state.ModelLimits = values
	state.TableOff = plan.TableOff
	return state, true
}
