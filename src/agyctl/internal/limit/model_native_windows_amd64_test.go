package limit

import (
	"encoding/binary"
	"encoding/hex"
	"runtime"
	"syscall"
	"testing"
	"unsafe"
)

// Only generated instructions are executed; no installed or extracted client content is loaded.
func TestPerModelGeneratedNativeSemantics(t *testing.T) {
	kernel := syscall.NewLazyDLL("kernel32.dll")
	alloc := kernel.NewProc("VirtualAlloc")
	protect := kernel.NewProc("VirtualProtect")
	free := kernel.NewProc("VirtualFree")
	flush := kernel.NewProc("FlushInstructionCache")
	move := kernel.NewProc("RtlMoveMemory")
	address, _, err := alloc.Call(0, 4096, 0x3000, 0x04)
	if address == 0 {
		t.Fatalf("VirtualAlloc: %v", err)
	}
	defer func() {
		if result, _, err := free.Call(address, 0, 0x8000); result == 0 {
			t.Errorf("VirtualFree: %v", err)
		}
	}()
	page := make([]byte, 4096)
	wrapper, _ := hex.DecodeString("5356574883ec204889c84889d34c89c1e82b0000004883c4205f5e5bc3")
	copy(page, wrapper)
	body, err := AssembleModelLimits(uint64(address+64), uint64(address+256))
	if err != nil {
		t.Fatal(err)
	}
	copy(page[64:], body)
	for i, value := range []ModelLimit{{ID: 1318, Limit: 300000}, {ID: 1400, Limit: 500000}} {
		node := page[256+i*16 : 256+(i+1)*16]
		binary.LittleEndian.PutUint32(node, uint32(value.ID))
		binary.LittleEndian.PutUint32(node[4:], uint32(value.Limit))
		if i == 0 {
			binary.LittleEndian.PutUint32(node[8:], 16)
		}
		copy(node[12:], "AGL2")
	}
	// RtlMoveMemory has no return value or last-error contract.
	_, _, _ = move.Call(address, uintptr(unsafe.Pointer(&page[0])), uintptr(len(page)))
	runtime.KeepAlive(page)
	var oldProtection uint32
	if result, _, err := protect.Call(address, 4096, 0x20, uintptr(unsafe.Pointer(&oldProtection))); result == 0 {
		t.Fatalf("VirtualProtect: %v", err)
	}
	if result, _, err := flush.Call(^uintptr(0), address, 4096); result == 0 {
		t.Fatalf("FlushInstructionCache: %v", err)
	}
	cases := []struct {
		name                                                                           string
		id, initial, maxContext, allowance, output, maxOutput, wantContext, wantOutput uint32
		flag                                                                           bool
	}{
		{name: "first model", id: 1318, maxContext: 1000000, wantContext: 300000},
		{name: "second model", id: 1400, maxContext: 1000000, wantContext: 500000},
		{name: "unknown model preserves nonzero", id: 9, initial: 123456, maxContext: 1000000, wantContext: 123456},
		{name: "unknown model original zero fallback", id: 9, maxContext: 200000, wantContext: 160000},
		{name: "no lowering", id: 1318, initial: 400000, maxContext: 1000000, wantContext: 400000},
		{name: "output allowance survives lookup", id: 1400, maxContext: 600000, allowance: 200000, wantContext: 400000},
		{name: "small allowance preserved", id: 1318, maxContext: 200000, allowance: 10, wantContext: 199990},
		{name: "original output clamp", id: 1400, maxContext: 1000000, output: 10000, maxOutput: 4096, flag: true, wantContext: 500000, wantOutput: 4096},
	}
	// The generated wrapper has no Win32 status; assertions inspect its buffer writes.
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			config := make([]byte, 0x58)
			model := make([]byte, 0x78)
			flag := byte(0)
			if tc.flag {
				flag = 1
				binary.LittleEndian.PutUint64(config[0x50:], uint64(uintptr(unsafe.Pointer(&flag))))
			}
			binary.LittleEndian.PutUint32(config[12:], tc.initial)
			binary.LittleEndian.PutUint32(config[16:], tc.output)
			binary.LittleEndian.PutUint32(model[8:], tc.id)
			binary.LittleEndian.PutUint32(model[20:], tc.maxContext)
			binary.LittleEndian.PutUint32(model[0x70:], tc.maxOutput)
			_, _, _ = syscall.SyscallN(address, uintptr(unsafe.Pointer(&config[0])), uintptr(unsafe.Pointer(&model[0])), uintptr(tc.allowance))
			runtime.KeepAlive(config)
			runtime.KeepAlive(model)
			runtime.KeepAlive(&flag)
			if context, output := binary.LittleEndian.Uint32(config[12:]), binary.LittleEndian.Uint32(config[16:]); context != tc.wantContext || output != tc.wantOutput {
				t.Fatalf("context/output = %d/%d, want %d/%d", context, output, tc.wantContext, tc.wantOutput)
			}
		})
	}
	for _, args := range [][3]uintptr{{0, 0, 0}, {0, 1, 0}} {
		_, _, _ = syscall.SyscallN(address, args[0], args[1], args[2])
	}
	config := make([]byte, 0x58)
	_, _, _ = syscall.SyscallN(address, uintptr(unsafe.Pointer(&config[0])), 0, 0)
	runtime.KeepAlive(config)
}
