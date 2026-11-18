package limit

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"math"

	"agyctl/internal/fsx"
)

const summaryFuncSize = 352
const summaryOriginalSHA = "6c3e3ab006baf9105efd7d5a8545bddc8fdaef102f578d3bee9aad6967ebae25"
const summaryEncoding = "linked-v3-summary"
const summaryOriginalHex = "493b66100f86fc000000554889e54883ec20488944243048895c24380f1f40004885c90f84db0000004885ff0f84d200000083790c00751f486357140f1f40004881fa409c00007f0431d2eb074881c2c063ffff89510c8b571485d27e164189d029f24439c6440f42c24439410c76044489410c837940037424488b415066904885c0747d80380074788b477085c07e718b511039c20f47d0895110eb6448894c2440e8b8fdffff4885db75554885c07450837814007e318b487085c9ba000000000f4fd13950147e18488b4c24408b590c8b701429d639f30f47de89590c90eb0c488b4c2440eb05488b4c2440837870007e0e8b51108b407039d00f42d0895110c9c3c9c3488944240848895c241048894c241848897c2420897424286690e85b5087fe488b442408488b5c2410488b4c2418488b7c24208b7424280f1f00e9bbfeffffcccccccccccccccccccccccccccccccccccccccccccccccccccccc"

func supportedOriginal(arch string, body []byte) bool {
	return arch == "x86-64" && (len(body) == funcSizeAMD64 || len(body) == summaryFuncSize && fsx.SHA256(body) == summaryOriginalSHA)
}

// assembleSummaryLimits retains the original stack split, frame, call PCs and
// pointer spill slots. All new instructions stay in the original pcsp=40 region;
// the lookup never calls or changes pointer arguments and only writes an int32.
func assembleSummaryLimits(funcVA, tableVA uint64) ([]byte, error) {
	original, err := hex.DecodeString(summaryOriginalHex)
	if err != nil {
		return nil, err
	}
	code := bytes.Clone(original[:0x20])
	labels := map[string]int{}
	type branch struct {
		at, size int
		label    string
	}
	branches := []branch{}
	emit := func(s string) {
		raw, err := hex.DecodeString(s)
		if err != nil {
			panic(err)
		}
		code = append(code, raw...)
	}
	mark := func(label string) { labels[label] = len(code) }
	jump := func(op, label string) {
		emit(op)
		size := 1
		if op == "e9" {
			size = 4
		}
		branches = append(branches, branch{len(code), size, label})
		code = append(code, make([]byte, size)...)
	}
	emit("4885c9")
	jump("74", "exit")
	emit("4885ff")
	jump("74", "exit")
	emit("8b57084c8d0500000000")
	tableDisp := len(code) - 4
	mark("lookup")
	emit("413910")
	jump("74", "found")
	emit("4d6348084585c9")
	jump("74", "zero")
	emit("4d01c8")
	jump("eb", "lookup")
	mark("found")
	emit("418b500439510c")
	jump("73", "zero")
	emit("89510c")
	mark("zero")
	emit("83790c00")
	jump("75", "context")
	emit("486357144881ea409c0000")
	jump("79", "initialize")
	emit("31d2")
	mark("initialize")
	emit("89510c")
	mark("context")
	emit("8b571485d2")
	jump("7e", "strategy")
	emit("39f2")
	jump("76", "contextClamp")
	emit("29f2")
	mark("contextClamp")
	emit("39510c")
	jump("76", "strategy")
	emit("89510c")
	mark("strategy")
	emit("83794003")
	jump("74", "summary")
	emit("488b51504885d2")
	jump("74", "exit")
	emit("803a00")
	jump("74", "exit")
	emit("8b5770")
	jump("eb", "output")
	mark("exit")
	jump("e9", "return")
	if len(code) > 0x9e {
		return nil, fmt.Errorf("summary ABI prefix exceeds fixed call spill: %#x", len(code))
	}
	code = append(code, bytes.Repeat([]byte{0x90}, 0x9e-len(code))...)
	mark("summary")
	code = append(code, original[0x9e:0xa8]...)
	emit("4885db")
	jump("75", "return")
	emit("4885c0")
	jump("74", "return")
	emit("83781400")
	jump("7e", "summaryOutput")
	emit("8b50704531c085d2410f4ed0395014")
	jump("7e", "summaryOutput")
	emit("448b40144129d0488b4c24404439410c")
	jump("76", "summaryOutput")
	emit("4489410c")
	mark("summaryOutput")
	emit("488b4c24408b5070")
	mark("output")
	emit("85d2")
	jump("7e", "return")
	emit("395110")
	jump("76", "return")
	emit("895110")
	if len(code) > 0x102 {
		return nil, fmt.Errorf("summary ABI body exceeds fixed epilogue: %#x", len(code))
	}
	code = append(code, bytes.Repeat([]byte{0x90}, 0x102-len(code))...)
	mark("return")
	code = append(code, original[0x102:]...)
	for _, b := range branches {
		disp := labels[b.label] - b.at - b.size
		if b.size == 1 {
			if disp < -128 || disp > 127 {
				return nil, fmt.Errorf("summary ABI branch to %s out of range", b.label)
			}
			code[b.at] = byte(disp)
		} else {
			binary.LittleEndian.PutUint32(code[b.at:], uint32(disp))
		}
	}
	if funcVA > math.MaxInt64 || tableVA > math.MaxInt64 {
		return nil, fmt.Errorf("address outside signed displacement range")
	}
	disp := int64(tableVA) - int64(funcVA) - int64(tableDisp+4)
	if disp < math.MinInt32 || disp > math.MaxInt32 {
		return nil, fmt.Errorf("table displacement out of range")
	}
	binary.LittleEndian.PutUint32(code[tableDisp:], uint32(disp))
	return code, nil
}
