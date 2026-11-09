package limit

import (
	"bytes"
	"debug/elf"
	"encoding/binary"
	"errors"
	"fmt"
	"sort"
)

// parseELF reads an ELF64 little-endian image. Go's runtime.text can follow
// native startup code inside ELF .text, so the text base is resolved from the
// pclntab header and cross-validated against the moduledata and its dynamic
// RELATIVE relocations. A wrong base would misplace patch tables, so missing
// or contradictory base evidence is refused.
func parseELF(data []byte) (*image, error) {
	if len(data) < 64 || data[4] != 2 || data[5] != 1 {
		return nil, errors.New("expected an ELF64 little-endian binary")
	}
	var arch string
	var minLC byte
	switch machine := binary.LittleEndian.Uint16(data[18:]); machine {
	case 0x3e:
		arch, minLC = "x86-64", 1
	default:
		return nil, fmt.Errorf("unsupported ELF machine %#x", machine)
	}
	file, err := elf.NewFile(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("read ELF: %w", err)
	}
	defer func() { _ = file.Close() }()
	text := file.Section(".text")
	if text == nil {
		return nil, errors.New(".text not found")
	}
	if uint64(text.Offset)+text.Size > uint64(len(data)) {
		return nil, errors.New(".text extends beyond binary")
	}
	position, err := findPclntab(data, minLC)
	if err != nil {
		return nil, err
	}
	end := len(data)
	var tableAddress uint64
	for _, section := range file.Sections {
		sectionEnd := uint64(section.Offset) + section.Size
		if uint64(position) >= uint64(section.Offset) && uint64(position) < sectionEnd {
			if sectionEnd > uint64(len(data)) {
				return nil, errors.New("pclntab section extends beyond binary")
			}
			end = int(sectionEnd)
			tableAddress = section.Addr + uint64(position) - uint64(section.Offset)
			break
		}
	}
	if end-position < 72 {
		return nil, errors.New("go pclntab is truncated")
	}
	textBase, err := elfTextBase(data, file, data[position:], tableAddress, text.Addr, text.Size)
	if err != nil {
		return nil, err
	}
	im := &image{format: "elf", arch: arch, textVA: text.Addr, textOff: int(text.Offset), textSize: int(text.Size), index: -1, regions: elfRegions(file)}
	if err = im.decodeFunctions(data[position:end], textBase); err != nil {
		return nil, err
	}
	return im, nil
}

// elfTextBase resolves runtime.text for externally linked ELF images. The
// moduledata prefix is defined by runtime/symtab.go and
// cmd/link/internal/ld/symtab.go; RELATIVE relocations carry its link-time
// addresses without loading or executing the binary.
func elfTextBase(data []byte, file *elf.File, table []byte, tableAddress, textVA, textSize uint64) (uint64, error) {
	start := binary.LittleEndian.Uint64(table[24:])
	module := file.Section(".go.module")
	if module == nil {
		if start == 0 {
			return 0, errors.New("ELF Go text base unavailable: no explicit pcHeader textStart or matching moduledata")
		}
		return start, nil
	}
	if module.Type != elf.SHT_PROGBITS || module.Size < 192 || module.Flags&elf.SHF_COMPRESSED != 0 || module.Addr+module.Size < module.Addr {
		return 0, errors.New("unsupported ELF Go moduledata section")
	}
	body, err := elfSectionBytes(data, module)
	if err != nil {
		return 0, err
	}
	values := map[uint64]uint64{}
	for _, section := range file.Sections {
		if section.Type != elf.SHT_RELA {
			continue
		}
		if section.Entsize != 24 || section.Size%24 != 0 || section.Flags&elf.SHF_COMPRESSED != 0 {
			return 0, errors.New("unsupported ELF relocation table")
		}
		relocations, err := elfSectionBytes(data, section)
		if err != nil {
			return 0, err
		}
		kind := uint64(elf.R_X86_64_RELATIVE)
		for offset := 0; offset < len(relocations); offset += 24 {
			entry := relocations[offset : offset+24]
			address := binary.LittleEndian.Uint64(entry)
			if address < module.Addr || address-module.Addr >= module.Size {
				continue
			}
			if binary.LittleEndian.Uint64(entry[8:]) != kind || address%8 != 0 || module.Size-(address-module.Addr) < 8 {
				return 0, errors.New("unsupported ELF Go moduledata relocation")
			}
			field := address - module.Addr
			if _, exists := values[field]; exists {
				return 0, errors.New("duplicate ELF Go moduledata relocation")
			}
			values[field] = binary.LittleEndian.Uint64(entry[16:])
		}
	}
	value := func(field uint64) uint64 {
		if relocated, ok := values[field]; ok {
			return relocated
		}
		return binary.LittleEndian.Uint64(body[field:])
	}
	count := binary.LittleEndian.Uint64(table[8:])
	pcln := binary.LittleEndian.Uint64(table[64:])
	if pcln < 72 || pcln > uint64(len(table)) || count >= (uint64(len(table))-pcln)/8 {
		return 0, errors.New("ELF Go pclntab function table extends beyond its section")
	}
	if value(0) != tableAddress || value(8) != tableAddress+binary.LittleEndian.Uint64(table[32:]) || value(104) != tableAddress+pcln || value(128) != tableAddress+pcln || value(136) != count+1 || value(144) != count+1 {
		return 0, errors.New("ELF moduledata does not reference this Go pclntab")
	}
	moduleText := value(176)
	if start != 0 && start != moduleText {
		return 0, errors.New("ELF Go text bases disagree")
	}
	start, end := moduleText, value(184)
	first := uint64(binary.LittleEndian.Uint32(table[pcln:]))
	last := uint64(binary.LittleEndian.Uint32(table[pcln+count*8:]))
	if start+last < start || value(160) != start+first || value(168) != start+last {
		return 0, errors.New("ELF moduledata function range disagrees with Go pclntab")
	}
	if start == 0 {
		return 0, errors.New("ELF Go text base unavailable: no explicit pcHeader textStart or matching moduledata")
	}
	if start < textVA || start >= end || end > textVA+textSize {
		return 0, errors.New("ELF Go text range lies outside .text")
	}
	return start, nil
}

func elfSectionBytes(data []byte, section *elf.Section) ([]byte, error) {
	if section.Offset > uint64(len(data)) || section.Size > uint64(len(data))-section.Offset {
		return nil, errors.New("ELF section extends beyond binary")
	}
	return data[section.Offset : section.Offset+section.Size], nil
}

// elfRegions maps file-backed allocatable sections for VA translation.
func elfRegions(file *elf.File) []fileRegion {
	var regions []fileRegion
	for _, section := range file.Sections {
		if section.Type == elf.SHT_NULL || section.Type == elf.SHT_NOBITS || section.Addr == 0 || section.Size == 0 || section.Flags&elf.SHF_ALLOC == 0 {
			continue
		}
		regions = append(regions, fileRegion{va: section.Addr, off: int(section.Offset), size: int(section.Size)})
	}
	sort.Slice(regions, func(i, j int) bool { return regions[i].va < regions[j].va })
	merged := make([]fileRegion, 0, len(regions))
	for _, region := range regions {
		if len(merged) > 0 {
			last := &merged[len(merged)-1]
			virtualGap := int64(region.va) - int64(last.va+uint64(last.size))
			fileGap := int64(region.off) - int64(last.off+last.size)
			if virtualGap >= 0 && virtualGap == fileGap {
				last.size += int(virtualGap) + region.size
				continue
			}
		}
		merged = append(merged, region)
	}
	return merged
}
