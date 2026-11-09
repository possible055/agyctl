package limit

import (
	"bytes"
	"debug/macho"
	"encoding/binary"
	"errors"
	"fmt"
)

func isMachO(data []byte) bool {
	return len(data) >= 4 && (binary.LittleEndian.Uint32(data) == macho.Magic64 || binary.BigEndian.Uint32(data) == macho.MagicFat)
}

// parseMachO reads only the ARM64 slice. Inspection never grants mutation
// admission: macOS original-byte and signing qualification remains required.
func parseMachO(data []byte) (*image, error) {
	body, sliceOffset := data, 0
	if binary.BigEndian.Uint32(data) == macho.MagicFat {
		fat, err := macho.NewFatFile(bytes.NewReader(data))
		if err != nil {
			return nil, fmt.Errorf("read universal Mach-O: %w", err)
		}
		defer func() { _ = fat.Close() }()
		found := false
		for _, arch := range fat.Arches {
			if arch.Cpu != macho.CpuArm64 {
				continue
			}
			if found {
				return nil, errors.New("ambiguous Mach-O ARM64 slices")
			}
			if uint64(arch.Offset)+uint64(arch.Size) > uint64(len(data)) {
				return nil, errors.New("Mach-O slice extends beyond binary")
			}
			found = true
			sliceOffset = int(arch.Offset)
			body = data[sliceOffset : sliceOffset+int(arch.Size)]
		}
		if !found {
			return nil, errors.New("Mach-O ARM64 slice not found")
		}
	}
	file, err := macho.NewFile(bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("read Mach-O: %w", err)
	}
	defer func() { _ = file.Close() }()
	if file.Magic != macho.Magic64 || file.Cpu != macho.CpuArm64 {
		return nil, errors.New("unsupported Mach-O target; expected darwin/arm64")
	}
	text := file.Section("__text")
	if text == nil || text.Seg != "__TEXT" {
		return nil, errors.New("Mach-O __TEXT,__text not found")
	}
	if uint64(text.Offset)+text.Size > uint64(len(body)) {
		return nil, errors.New("Mach-O text extends beyond binary")
	}
	var lineTable []byte
	var tableVA uint64
	for _, section := range file.Sections {
		if section.Seg != "__TEXT" || uint64(section.Offset)+section.Size > uint64(len(body)) {
			continue
		}
		data := body[uint64(section.Offset) : uint64(section.Offset)+section.Size]
		position, err := findPclntab(data, 4)
		if err != nil {
			continue
		}
		if lineTable != nil {
			return nil, errors.New("ambiguous Mach-O Go pclntab sections")
		}
		lineTable = data[position:]
		tableVA = section.Addr + uint64(position)
	}
	if lineTable == nil {
		return nil, errors.New("Mach-O Go pclntab not found")
	}
	textBase := binary.LittleEndian.Uint64(lineTable[24:])
	if module := file.Section("__go_module"); module != nil {
		if module.Seg != "__DATA" || module.Size < 192 || uint64(module.Offset)+module.Size > uint64(len(body)) {
			return nil, errors.New("unsupported Mach-O Go moduledata section")
		}
		metadata := body[uint64(module.Offset) : uint64(module.Offset)+module.Size]
		value := func(offset int) uint64 { return binary.LittleEndian.Uint64(metadata[offset:]) }
		count, pcln := binary.LittleEndian.Uint64(lineTable[8:]), binary.LittleEndian.Uint64(lineTable[64:])
		if pcln < 72 || pcln > uint64(len(lineTable)) || count >= (uint64(len(lineTable))-pcln)/8 {
			return nil, errors.New("Mach-O Go function table extends beyond its section")
		}
		if value(0) != tableVA || value(8) != tableVA+binary.LittleEndian.Uint64(lineTable[32:]) || value(104) != tableVA+pcln || value(128) != tableVA+pcln || value(136) != count+1 || value(144) != count+1 {
			return nil, errors.New("Mach-O moduledata does not reference this Go pclntab")
		}
		moduleText := value(176)
		if textBase != 0 && textBase != moduleText {
			return nil, errors.New("Mach-O Go text bases disagree")
		}
		textBase = moduleText
		first, last := uint64(binary.LittleEndian.Uint32(lineTable[pcln:])), uint64(binary.LittleEndian.Uint32(lineTable[pcln+count*8:]))
		if textBase+last < textBase || value(160) != textBase+first || value(168) != textBase+last || value(184) > text.Addr+text.Size || value(184) <= textBase {
			return nil, errors.New("Mach-O moduledata function range disagrees with text")
		}
	}
	if textBase < text.Addr || textBase >= text.Addr+text.Size {
		return nil, errors.New("Mach-O Go text base unavailable or outside __TEXT,__text")
	}
	im := &image{format: "macho", arch: "arm64", textVA: text.Addr, textOff: sliceOffset + int(text.Offset), textSize: int(text.Size), index: -1, regions: []fileRegion{{va: text.Addr, off: sliceOffset + int(text.Offset), size: int(text.Size)}}}
	if err := im.decodeFunctions(lineTable, textBase); err != nil {
		return nil, err
	}
	return im, nil
}
