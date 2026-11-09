package check

import (
	"bytes"
	"debug/elf"
	"encoding/binary"
	"strings"
	"testing"
)

func shiftedELFFixture(t *testing.T, name string) ([]byte, uint64) {
	t.Helper()
	original := fixture(t, name)
	im, e := imageText(original)
	if e != nil {
		t.Fatal(e)
	}
	const delta = uint64(0x80)
	data := append(bytes.Clone(original[:im.offset]), bytes.Repeat([]byte{0xcc}, int(delta))...)
	data = append(data, original[im.offset:im.offset+im.size]...)
	for len(data)%8 != 0 {
		data = append(data, 0)
	}
	moduleOffset := uint64(len(data))
	module := make([]byte, 0x180)
	data = append(data, module...)
	base := uint64(bytes.Index(data, []byte{0xf1, 0xff, 0xff, 0xff, 0, 0}))
	pc := im.address + base - im.offset
	names := pc + binary.LittleEndian.Uint64(data[base+32:])
	pcln := pc + binary.LittleEndian.Uint64(data[base+64:])
	moduleVA := uint64(0x8000)
	text := im.address + delta
	count := binary.LittleEndian.Uint64(data[base+8:])
	binary.LittleEndian.PutUint64(data[moduleOffset+136:], count+1)
	binary.LittleEndian.PutUint64(data[moduleOffset+144:], count+1)
	relaOffset := uint64(len(data))
	relocation := uint64(elf.R_X86_64_RELATIVE)
	for _, pair := range [][2]uint64{{0, pc}, {8, names}, {104, pcln}, {128, pcln}, {160, text}, {168, text + 0x190}, {176, text}, {184, text + 0x200}} {
		var record [24]byte
		binary.LittleEndian.PutUint64(record[:], moduleVA+pair[0])
		binary.LittleEndian.PutUint64(record[8:], relocation)
		binary.LittleEndian.PutUint64(record[16:], pair[1])
		data = append(data, record[:]...)
	}
	relaSize := uint64(len(data)) - relaOffset
	stringsOffset := uint64(len(data))
	sectionNames := []byte("\x00.text\x00.go.module\x00.rela.dyn\x00.shstrtab\x00")
	data = append(data, sectionNames...)
	headers := uint64(len(data))
	data = append(data, make([]byte, 5*64)...)
	for i, section := range []struct {
		name, kind                        uint32
		flags, address, offset, size, ent uint64
	}{
		{},
		{1, uint32(elf.SHT_PROGBITS), 6, im.address, im.offset, im.size + delta, 0},
		{7, uint32(elf.SHT_PROGBITS), 3, moduleVA, moduleOffset, uint64(len(module)), 0},
		{18, uint32(elf.SHT_RELA), 2, 0x9000, relaOffset, relaSize, 24},
		{28, uint32(elf.SHT_STRTAB), 0, 0, stringsOffset, uint64(len(sectionNames)), 0},
	} {
		h := data[headers+uint64(i)*64:]
		binary.LittleEndian.PutUint32(h, section.name)
		binary.LittleEndian.PutUint32(h[4:], section.kind)
		for j, value := range []uint64{section.flags, section.address, section.offset, section.size} {
			binary.LittleEndian.PutUint64(h[8+j*8:], value)
		}
		binary.LittleEndian.PutUint64(h[56:], section.ent)
	}
	binary.LittleEndian.PutUint16(data[16:], uint16(elf.ET_DYN))
	binary.LittleEndian.PutUint64(data[40:], headers)
	binary.LittleEndian.PutUint16(data[60:], 5)
	binary.LittleEndian.PutUint16(data[62:], 4)
	return data, base
}

func TestELFGoTextBase(t *testing.T) {
	for _, name := range []string{"elf-x64.bin"} {
		t.Run(name, func(t *testing.T) {
			data, base := shiftedELFFixture(t, name)
			_, _, address, offset, size, e := LocateClamp(data)
			if e != nil || address != 0x1080 || offset != 0x480 || size != 128 {
				t.Fatalf("relocated Go text: address=%#x offset=%#x size=%d err=%v", address, offset, size, e)
			}
			if !bytes.Equal(data[offset:offset+size], fixture(t, name)[0x400:0x480]) {
				t.Fatal("resolved the wrong function body")
			}
			headers := binary.LittleEndian.Uint64(data[40:])
			withoutModule := bytes.Clone(data)
			binary.LittleEndian.PutUint32(withoutModule[headers+2*64:], 0)
			_, _, _, _, _, e = LocateClamp(withoutModule)
			if e == nil || errorType(e) != "SymbolError" || !strings.Contains(e.Error(), "ELF Go text base unavailable") {
				t.Fatalf("missing text-base evidence accepted: %v", e)
			}
			binary.LittleEndian.PutUint64(withoutModule[base+24:], 0x1080)
			_, _, _, offset, _, e = LocateClamp(withoutModule)
			if e != nil || offset != 0x480 {
				t.Fatalf("explicit header text base ignored: offset=%#x err=%v", offset, e)
			}
			relaOffset := binary.LittleEndian.Uint64(data[headers+3*64+24:])
			binary.LittleEndian.PutUint64(data[relaOffset+16:], 0xdead)
			_, _, _, _, _, e = LocateClamp(data)
			if e == nil || errorType(e) != "SymbolError" || !strings.Contains(e.Error(), "moduledata does not reference") {
				t.Fatalf("unrelated moduledata accepted: %v", e)
			}
		})
	}
}
