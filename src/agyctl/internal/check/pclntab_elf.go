package check

import (
	"bytes"
	"debug/elf"
	"encoding/binary"
)

// elfGoTextRange resolves Go's runtime.text, which can follow native startup
// code inside ELF .text. The moduledata prefix is defined by runtime/symtab.go
// and cmd/link/internal/ld/symtab.go; dynamic RELATIVE relocations supply its
// link-time virtual addresses without loading or executing the binary.
func elfGoTextRange(data, table []byte, im image, tableAddress uint64) (uint64, uint64, error) {
	f, e := elf.NewFile(bytes.NewReader(data))
	if e != nil {
		return 0, 0, symError("invalid ELF metadata: %s", e)
	}
	start := binary.LittleEndian.Uint64(table[24:])
	end := im.address + im.size
	module := f.Section(".go.module")
	if module != nil {
		if module.Type != elf.SHT_PROGBITS || module.Size < 192 || module.Flags&elf.SHF_COMPRESSED != 0 || module.Addr+module.Size < module.Addr {
			return 0, 0, symError("unsupported ELF Go moduledata section")
		}
		body, e := region(data, module.Offset, module.Size)
		if e != nil {
			return 0, 0, e
		}
		values := map[uint64]uint64{}
		for _, section := range f.Sections {
			if section.Type != elf.SHT_RELA {
				continue
			}
			if section.Entsize != 24 || section.Size%24 != 0 || section.Flags&elf.SHF_COMPRESSED != 0 {
				return 0, 0, symError("unsupported ELF relocation table")
			}
			relocations, e := region(data, section.Offset, section.Size)
			if e != nil {
				return 0, 0, e
			}
			for off := 0; off < len(relocations); off += 24 {
				r := relocations[off : off+24]
				address := binary.LittleEndian.Uint64(r)
				if address < module.Addr || address-module.Addr >= module.Size {
					continue
				}
				info := binary.LittleEndian.Uint64(r[8:])
				kind := uint64(elf.R_X86_64_RELATIVE)
				if info != kind || address%8 != 0 || module.Size-(address-module.Addr) < 8 {
					return 0, 0, symError("unsupported ELF Go moduledata relocation")
				}
				field := address - module.Addr
				if _, exists := values[field]; exists {
					return 0, 0, symError("duplicate ELF Go moduledata relocation")
				}
				values[field] = binary.LittleEndian.Uint64(r[16:])
			}
		}
		value := func(off uint64) uint64 {
			if v, ok := values[off]; ok {
				return v
			}
			return binary.LittleEndian.Uint64(body[off:])
		}
		count := binary.LittleEndian.Uint64(table[8:])
		pcln := binary.LittleEndian.Uint64(table[64:])
		if value(0) != tableAddress || value(8) != tableAddress+binary.LittleEndian.Uint64(table[32:]) || value(104) != tableAddress+pcln || value(128) != tableAddress+pcln || value(136) != count+1 || value(144) != count+1 {
			return 0, 0, symError("ELF moduledata does not reference this Go pclntab")
		}
		moduleText := value(176)
		if start != 0 && start != moduleText {
			return 0, 0, symError("ELF Go text bases disagree")
		}
		start, end = moduleText, value(184)
		first := uint64(binary.LittleEndian.Uint32(table[pcln:]))
		last := uint64(binary.LittleEndian.Uint32(table[pcln+count*8:]))
		if start+last < start || value(160) != start+first || value(168) != start+last {
			return 0, 0, symError("ELF moduledata function range disagrees with Go pclntab")
		}
	}
	if start == 0 {
		return 0, 0, symError("ELF Go text base unavailable: no explicit pcHeader textStart or matching moduledata")
	}
	if start < im.address || start >= end || end > im.address+im.size {
		return 0, 0, symError("ELF Go text range lies outside .text")
	}
	return start - im.address, end - start, nil
}
