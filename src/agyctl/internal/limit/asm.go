package limit

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"math"

	"agyctl/internal/ids"
)

const (
	DefaultIDs   = "1318-1320,1400-1405,1417-1419"
	DefaultLimit = 500000
	Func         = "utils.ClampCheckpointConfigForModelInfo"
	TableSize    = 16
)

const (
	funcSizeAMD64 = 0x80
)

// funcSizes are the admitted original function sizes per architecture. The
// registry loader and the per-architecture patch planners gate on them.
var funcSizes = map[string]int{"x86-64": funcSizeAMD64}

// ParseIDs delegates to the shared strict grammar and maps refusal kinds to
// the documented limit command messages.
func ParseIDs(spec string) ([]int, error) {
	parsed, err := ids.Parse(spec)
	if err == nil {
		return parsed, nil
	}
	var termErr *ids.TermError
	if !errors.As(err, &termErr) {
		return nil, err
	}
	switch termErr.Kind {
	case "range":
		return nil, fmt.Errorf("bad range %s", termErr.Term)
	case "window":
		return nil, fmt.Errorf("ids must fit in a 128-wide window (got %d..%d)", termErr.Lo, termErr.Hi)
	case "empty":
		return nil, fmt.Errorf("no model ids given")
	default:
		return nil, fmt.Errorf("invalid model id %q", termErr.Term)
	}
}

func buildTable(ids []int) (int, int, []byte, error) {
	if len(ids) == 0 {
		return 0, 0, nil, fmt.Errorf("no model ids given")
	}
	base := ids[0]
	span := ids[len(ids)-1] - base
	if base < math.MinInt32 || base > math.MaxInt32 || span < 0 || span >= 128 {
		return 0, 0, nil, fmt.Errorf("ids must fit in a 128-wide window with an int32 base")
	}
	table := make([]byte, TableSize)
	for _, id := range ids {
		bit := id - base
		if bit < 0 || bit >= 128 {
			return 0, 0, nil, fmt.Errorf("ids must be sorted within a 128-wide window")
		}
		table[bit>>3] |= 1 << uint(bit&7)
	}
	return base, span, table, nil
}

func Assemble(ids []int, target int, funcVA, tableVA uint64) ([]byte, error) {
	base, span, _, err := buildTable(ids)
	if err != nil {
		return nil, err
	}
	if target < 1 || int64(target) >= 1<<31 {
		return nil, fmt.Errorf("bad target")
	}
	code := make([]byte, 0, funcSizeAMD64)
	type fixup struct {
		position int
		label    string
	}
	fixes := []fixup{}
	labels := map[string]int{}
	emit := func(s string) {
		raw, err := hex.DecodeString(s)
		if err != nil {
			panic(err)
		}
		code = append(code, raw...)
	}
	imm := func(v int64) { code = binary.LittleEndian.AppendUint32(code, uint32(v)) }
	jcc := func(op byte, label string) {
		code = append(code, op, 0)
		fixes = append(fixes, fixup{len(code) - 1, label})
	}
	emit("4885c0")
	jcc(0x74, "R")
	emit("4885db")
	jcc(0x74, "R")
	emit("8b530881ea")
	imm(int64(base))
	emit("83fa")
	code = append(code, byte(span))
	jcc(0x77, "ZERO")
	btAt := len(code)
	emit("0fa315")
	imm(0)
	jcc(0x73, "ZERO")
	emit("81780c")
	imm(int64(target))
	jcc(0x73, "ZERO")
	emit("c7400c")
	imm(int64(target))
	labels["ZERO"] = len(code)
	emit("83780c00")
	jcc(0x75, "L1")
	emit("8b531481ea409c0000")
	jcc(0x7f, "OK")
	emit("31d2")
	labels["OK"] = len(code)
	emit("89500c")
	labels["L1"] = len(code)
	emit("8b531485d2")
	jcc(0x7e, "L2")
	emit("89d629ca39f10f42f239700c")
	jcc(0x76, "L2")
	emit("89700c")
	labels["L2"] = len(code)
	emit("488b48504885c9")
	jcc(0x74, "R")
	emit("803900")
	jcc(0x74, "R")
	emit("8b4b7085c9")
	jcc(0x7e, "R")
	emit("8b501039ca0f47d1895010")
	labels["R"] = len(code)
	emit("c3")
	for _, fix := range fixes {
		relative := labels[fix.label] - fix.position - 1
		if relative < -128 || relative > 127 {
			return nil, fmt.Errorf("branch out of range")
		}
		code[fix.position] = byte(relative)
	}
	if funcVA > math.MaxInt64 || tableVA > math.MaxInt64 {
		return nil, fmt.Errorf("address outside signed displacement range")
	}
	disp := int64(tableVA) - int64(funcVA) - int64(btAt+7)
	if disp < math.MinInt32 || disp > math.MaxInt32 {
		return nil, fmt.Errorf("table displacement out of range")
	}
	binary.LittleEndian.PutUint32(code[btAt+3:], uint32(disp))
	if len(code) > funcSizeAMD64 {
		return nil, fmt.Errorf("new body is %d bytes, limit %d", len(code), funcSizeAMD64)
	}
	return append(code, bytes.Repeat([]byte{0xcc}, funcSizeAMD64-len(code))...), nil
}

type Plan struct {
	TextVA      uint64       `json:"text_va"`
	FuncVA      uint64       `json:"func_va"`
	FuncOff     int          `json:"func_off"`
	TableVA     uint64       `json:"table_va"`
	TableOff    int          `json:"table_off"`
	Body        []byte       `json:"-"`
	Table       []byte       `json:"-"`
	ModelLimits []ModelLimit `json:"model_limits,omitempty"`
	Nodes       []TableWrite `json:"nodes,omitempty"`
}

// PlanPatch parses the image and dispatches to the per-architecture planner.
func PlanPatch(data []byte, ids []int, target int) (Plan, error) {
	im, err := parseImage(data)
	if err != nil {
		return Plan{}, err
	}
	switch im.arch {
	case "x86-64":
		return im.planPatchAMD64(data, ids, target)
	case "arm64":
		return Plan{}, errors.New("macOS limit patching unavailable: original bytes, code placement and signing strategy are not qualified")
	}
	return Plan{}, fmt.Errorf("limit patching is not implemented for %s", im.arch)
}

func (im *image) planPatchAMD64(data []byte, ids []int, target int) (Plan, error) {
	var plan Plan
	entry := im.entries[im.index]
	if im.entries[im.index+1]-entry != funcSizeAMD64 {
		return plan, fmt.Errorf("%s is not %#x bytes; different build?", Func, funcSizeAMD64)
	}
	_, _, table, err := buildTable(ids)
	if err != nil {
		return plan, err
	}
	cave := uint64(0)
	end := min(im.index+5000, len(im.entries)-1)
	for i := im.index + 2; i < end; i++ {
		va := im.entries[i]
		if va < im.textVA+24 {
			continue
		}
		off, err := im.offset(va-24, 24)
		if err != nil {
			return plan, err
		}
		if bytes.Equal(data[off:off+8], bytes.Repeat([]byte{0xcc}, 8)) && (bytes.Equal(data[off+8:off+24], bytes.Repeat([]byte{0xcc}, 16)) || bytes.Equal(data[off+8:off+24], table)) {
			cave = va - TableSize
			break
		}
	}
	if cave == 0 {
		return plan, fmt.Errorf("no int3 padding cave found near the function")
	}
	body, err := Assemble(ids, target, entry, cave)
	if err != nil {
		return plan, err
	}
	funcOff, err := im.offset(entry, funcSizeAMD64)
	if err != nil {
		return plan, err
	}
	tableOff, err := im.offset(cave, TableSize)
	if err != nil {
		return plan, err
	}
	return Plan{TextVA: im.textVA, FuncVA: entry, FuncOff: funcOff, TableVA: cave, TableOff: tableOff, Body: body, Table: table}, nil
}

func ApplyPatch(data []byte, plan Plan) []byte {
	out := bytes.Clone(data)
	copy(out[plan.FuncOff:], plan.Body)
	copy(out[plan.TableOff:], plan.Table)
	for _, node := range plan.Nodes {
		copy(out[node.Offset:], node.Data)
	}
	return out
}

type PatchState struct {
	Kind        string       `json:"kind"`
	FuncVA      uint64       `json:"func_va"`
	Format      string       `json:"format"`
	Arch        string       `json:"arch"`
	IDs         []int        `json:"ids,omitempty"`
	Limit       int          `json:"limit,omitempty"`
	TableOff    int          `json:"table_off,omitempty"`
	ModelLimits []ModelLimit `json:"model_limits,omitempty"`
	Encoding    string       `json:"encoding,omitempty"`
}

// DetectState parses the image and dispatches to the per-architecture state
// decoder. The byte gate always compares the admitted function body against
// the recorded originals, whatever the architecture reports.
func DetectState(data []byte, originals [][]byte) (PatchState, error) {
	im, err := parseImage(data)
	if err != nil {
		return PatchState{}, err
	}
	state := PatchState{Kind: "unknown", FuncVA: im.entries[im.index], Format: im.format, Arch: im.arch}
	switch im.arch {
	case "x86-64":
		return im.detectStateAMD64(data, state, originals)
	case "arm64":
		state.Kind = "unavailable"
		return state, nil
	}
	return state, nil
}

func (im *image) detectStateAMD64(data []byte, state PatchState, originals [][]byte) (PatchState, error) {
	entry := im.entries[im.index]
	if im.entries[im.index+1]-entry != funcSizeAMD64 {
		state.Kind = "size-mismatch"
		return state, nil
	}
	off, err := im.offset(entry, funcSizeAMD64)
	if err != nil {
		return state, err
	}
	body := data[off : off+funcSizeAMD64]
	for _, original := range originals {
		if bytes.Equal(body, original) {
			state.Kind = "original"
			return state, nil
		}
	}
	if decoded, ok := im.detectModelPatch(data, state, body); ok {
		return decoded, nil
	}
	base := int(int32(binary.LittleEndian.Uint32(body[15:])))
	span := int(body[21])
	disp := int64(int32(binary.LittleEndian.Uint32(body[27:])))
	target := int(binary.LittleEndian.Uint32(body[36:]))
	if target != int(binary.LittleEndian.Uint32(body[45:])) || target < 1 || int64(target) >= 1<<31 {
		return state, nil
	}
	tableVA := int64(entry) + 31 + disp
	if tableVA < 0 {
		return state, nil
	}
	tableOff, err := im.offset(uint64(tableVA), TableSize)
	if err != nil {
		return state, nil
	}
	table := data[tableOff : tableOff+TableSize]
	ids := []int{}
	for i := 0; i < 128; i++ {
		if table[i>>3]>>(i&7)&1 != 0 {
			ids = append(ids, base+i)
		}
	}
	if len(ids) == 0 || ids[0] != base || ids[len(ids)-1]-base != span {
		return state, nil
	}
	expected, err := Assemble(ids, target, entry, uint64(tableVA))
	if err != nil || !bytes.Equal(body, expected) {
		return state, nil
	}
	state.Kind = "patched"
	state.IDs = ids
	state.Limit = target
	state.TableOff = tableOff
	state.ModelLimits = uniformLimits(ids, target)
	return state, nil
}
