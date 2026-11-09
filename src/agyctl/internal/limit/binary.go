package limit

import (
	"bytes"
	"debug/gosym"
	"debug/pe"
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
)

type image struct {
	format   string
	arch     string
	textVA   uint64
	textOff  int
	textSize int
	entries  []uint64
	index    int
	regions  []fileRegion
}

// fileRegion maps a file-backed virtual address range to a file offset.
type fileRegion struct {
	va   uint64
	off  int
	size int
}

func parseImage(data []byte) (*image, error) {
	switch {
	case bytes.HasPrefix(data, []byte("MZ")):
		return parsePE(data)
	case bytes.HasPrefix(data, []byte("\x7fELF")):
		return parseELF(data)
	case isMachO(data):
		return parseMachO(data)
	default:
		return nil, errors.New("unsupported binary format (expected PE, ELF or Mach-O)")
	}
}

// findPclntab locates the Go 1.20 pclntab header by magic, the minimum
// instruction size of the target architecture, pointer size, and a plausible
// function count.
func findPclntab(data []byte, minLC byte) (int, error) {
	magic := []byte{0xf1, 0xff, 0xff, 0xff, 0, 0}
	for start := 0; start < len(data); {
		rel := bytes.Index(data[start:], magic)
		if rel < 0 {
			break
		}
		base := start + rel
		start = base + 1
		if len(data)-base < 72 || data[base+6] != minLC || data[base+7] != 8 {
			continue
		}
		if nfunc := binary.LittleEndian.Uint64(data[base+8:]); nfunc > 1000 && nfunc < 5_000_000 {
			return base, nil
		}
	}
	return 0, errors.New("go pclntab not found")
}

func parsePE(data []byte) (*image, error) {
	file, err := pe.NewFile(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("read PE: %w", err)
	}
	defer func() { _ = file.Close() }()
	header, ok := file.OptionalHeader.(*pe.OptionalHeader64)
	if !ok {
		return nil, errors.New("expected a PE32+ binary")
	}
	var arch string
	var minLC byte
	switch file.Machine {
	case pe.IMAGE_FILE_MACHINE_AMD64:
		arch, minLC = "x86-64", 1
	default:
		return nil, fmt.Errorf("unsupported PE machine %#x", file.Machine)
	}
	text := file.Section(".text")
	if text == nil {
		return nil, errors.New(".text not found")
	}
	if uint64(text.Offset)+uint64(text.Size) > uint64(len(data)) {
		return nil, errors.New(".text extends beyond binary")
	}
	textVA := header.ImageBase + uint64(text.VirtualAddress)
	im := &image{format: "pe", arch: arch, textVA: textVA, textOff: int(text.Offset), textSize: int(text.Size), index: -1, regions: []fileRegion{{va: textVA, off: int(text.Offset), size: int(text.Size)}}}
	position, err := findPclntab(data, minLC)
	if err != nil {
		return nil, err
	}
	end := len(data)
	for _, section := range file.Sections {
		sectionEnd := uint64(section.Offset) + uint64(section.Size)
		if uint64(position) >= uint64(section.Offset) && uint64(position) < sectionEnd {
			if sectionEnd > uint64(len(data)) {
				return nil, errors.New("pclntab section extends beyond binary")
			}
			end = int(sectionEnd)
			break
		}
	}
	if err = im.decodeFunctions(data[position:end], textVA); err != nil {
		return nil, err
	}
	return im, nil
}

// decodeFunctions builds the sorted function entry table from a Go pclntab
// blob and locates the patch target by symbol name. textBase is the runtime
// text address that pclntab entry offsets are relative to.
func (im *image) decodeFunctions(lineTable []byte, textBase uint64) error {
	table, err := gosym.NewTable(nil, gosym.NewLineTable(lineTable, textBase))
	if err != nil {
		return fmt.Errorf("read Go pclntab: %w", err)
	}
	if nfunc := binary.LittleEndian.Uint64(lineTable[8:]); uint64(len(table.Funcs)) != nfunc {
		return fmt.Errorf("malformed Go pclntab: decoded %d of %d functions", len(table.Funcs), nfunc)
	}
	for i, function := range table.Funcs {
		if function.Entry < textBase || function.End < function.Entry || function.End-im.textVA > uint64(im.textSize) {
			return errors.New("go function lies outside .text")
		}
		if i > 0 && function.Entry < im.entries[i-1] {
			return errors.New("go function entries are not sorted")
		}
		im.entries = append(im.entries, function.Entry)
		if function.Name == Func || strings.HasSuffix(function.Name, "/"+Func) {
			if im.index >= 0 {
				return errors.New("ambiguous Go function " + Func)
			}
			im.index = i
		}
	}
	if len(table.Funcs) > 0 {
		im.entries = append(im.entries, table.Funcs[len(table.Funcs)-1].End)
	}
	if im.index < 0 {
		return fmt.Errorf("%s not found", Func)
	}
	return nil
}

// Function locates the patch target using debug/pe, debug/elf, and debug/gosym
// only.
func Function(data []byte) (uint64, uint64, error) {
	im, err := parseImage(data)
	if err != nil {
		return 0, 0, err
	}
	return im.entries[im.index], im.entries[im.index+1] - im.entries[im.index], nil
}

func (im *image) offset(va uint64, size int) (int, error) {
	for _, region := range im.regions {
		if va >= region.va && va-region.va+uint64(size) <= uint64(region.size) {
			return region.off + int(va-region.va), nil
		}
	}
	return 0, fmt.Errorf("address %#x is outside the mapped image regions", va)
}
