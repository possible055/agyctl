package check

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

type symbolError struct{ message string }

func (e *symbolError) Error() string            { return e.message }
func symError(format string, args ...any) error { return &symbolError{fmt.Sprintf(format, args...)} }

type image struct {
	arch                  string
	address, offset, size uint64
	sections              []fileRegion
	executable            []fileRegion
}
type fileRegion struct{ address, offset, size uint64 }
type Function struct {
	Name           string
	Entryoff, Size uint64
}

func region(data []byte, off, size uint64) ([]byte, error) {
	if off > uint64(len(data)) || size > uint64(len(data))-off {
		return nil, symError("truncated binary at %#x (need %#x bytes)", off, size)
	}
	return data[off : off+size], nil
}
func uintAt(data []byte, off uint64, size int) (uint64, error) {
	b, e := region(data, off, uint64(size))
	if e != nil {
		return 0, e
	}
	switch size {
	case 2:
		return uint64(binary.LittleEndian.Uint16(b)), nil
	case 4:
		return uint64(binary.LittleEndian.Uint32(b)), nil
	case 8:
		return binary.LittleEndian.Uint64(b), nil
	}
	return 0, symError("invalid integer size")
}
func imageText(data []byte) (image, error) {
	if bytes.HasPrefix(data, []byte{0xca, 0xfe, 0xba, 0xbe}) {
		header, err := region(data, 0, 8)
		if err != nil {
			return image{}, err
		}
		count := uint64(binary.BigEndian.Uint32(header[4:]))
		if count == 0 || count > (uint64(len(data))-8)/20 {
			return image{}, symError("invalid universal Mach-O architecture table")
		}
		var selected []byte
		var offset uint64
		for i := uint64(0); i < count; i++ {
			entry, _ := region(data, 8+i*20, 20)
			if binary.BigEndian.Uint32(entry) != 0x100000c {
				continue
			}
			if selected != nil {
				return image{}, symError("ambiguous Mach-O ARM64 slices")
			}
			offset = uint64(binary.BigEndian.Uint32(entry[8:]))
			size := uint64(binary.BigEndian.Uint32(entry[12:]))
			if offset < 8+count*20 {
				return image{}, symError("Mach-O slice overlaps architecture table")
			}
			selected, err = region(data, offset, size)
			if err != nil {
				return image{}, err
			}
		}
		if selected == nil {
			return image{}, symError("Mach-O ARM64 slice not found")
		}
		im, err := imageTextThin(selected)
		if err != nil {
			return im, err
		}
		if im.arch != "arm64" {
			return image{}, symError("Mach-O slice architecture disagrees with table")
		}
		im.offset += offset
		for i := range im.sections {
			im.sections[i].offset += offset
		}
		return im, nil
	}
	return imageTextThin(data)
}

func imageTextThin(data []byte) (image, error) {
	read := func(off uint64, size int) (uint64, error) { return uintAt(data, off, size) }
	var im image
	if bytes.HasPrefix(data, []byte("MZ")) {
		pe, e := read(0x3c, 4)
		if e != nil {
			return im, e
		}
		head, e := region(data, pe, 24)
		if e != nil {
			return im, e
		}
		if string(head[:4]) != "PE\x00\x00" {
			return im, symError("expected a PE binary")
		}
		machine := binary.LittleEndian.Uint16(head[4:])
		switch machine {
		case 0x8664:
			im.arch = "x86-64"
		default:
			return im, symError("unsupported PE machine %#x", machine)
		}
		base, e := read(pe+48, 8)
		if e != nil {
			return im, e
		}
		count := binary.LittleEndian.Uint16(head[6:])
		pos := pe + 24 + uint64(binary.LittleEndian.Uint16(head[20:]))
		for range count {
			sec, e := region(data, pos, 40)
			if e != nil {
				return im, e
			}
			mapping := fileRegion{base + uint64(binary.LittleEndian.Uint32(sec[12:])), uint64(binary.LittleEndian.Uint32(sec[20:])), uint64(binary.LittleEndian.Uint32(sec[16:]))}
			im.sections = append(im.sections, mapping)
			if strings.TrimRight(string(sec[:8]), "\x00") == ".text" {
				im.executable = append(im.executable, mapping)
				im.address = base + uint64(binary.LittleEndian.Uint32(sec[12:]))
				im.offset = uint64(binary.LittleEndian.Uint32(sec[20:]))
				im.size = uint64(binary.LittleEndian.Uint32(sec[8:]))
				if im.size > uint64(binary.LittleEndian.Uint32(sec[16:])) {
					return im, symError(".text extends beyond file-backed section")
				}
			}
			pos += 40
		}
		if im.size != 0 {
			return im, nil
		}
		return im, symError(".text not found")
	}
	if bytes.HasPrefix(data, []byte("\x7fELF")) {
		head, e := region(data, 0, 64)
		if e != nil {
			return im, e
		}
		if head[4] != 2 || head[5] != 1 {
			return im, symError("expected ELF64 little-endian")
		}
		switch binary.LittleEndian.Uint16(head[18:]) {
		case 0x3e:
			im.arch = "x86-64"
		default:
			return im, symError("unsupported ELF machine %#x", binary.LittleEndian.Uint16(head[18:]))
		}
		shoff := binary.LittleEndian.Uint64(head[40:])
		entsize := uint64(binary.LittleEndian.Uint16(head[58:]))
		count := uint64(binary.LittleEndian.Uint16(head[60:]))
		stridx := uint64(binary.LittleEndian.Uint16(head[62:]))
		if entsize < 64 || count == 0 || stridx >= count {
			return im, symError("invalid ELF section table")
		}
		strhead, e := region(data, shoff+stridx*entsize, 64)
		if e != nil {
			return im, e
		}
		names, e := region(data, binary.LittleEndian.Uint64(strhead[24:]), binary.LittleEndian.Uint64(strhead[32:]))
		if e != nil {
			return im, e
		}
		for i := uint64(0); i < count; i++ {
			sec, e := region(data, shoff+i*entsize, 64)
			if e != nil {
				return im, e
			}
			if binary.LittleEndian.Uint32(sec[4:]) != 8 {
				im.sections = append(im.sections, fileRegion{binary.LittleEndian.Uint64(sec[16:]), binary.LittleEndian.Uint64(sec[24:]), binary.LittleEndian.Uint64(sec[32:])})
			}
			n := uint64(binary.LittleEndian.Uint32(sec))
			if n >= uint64(len(names)) {
				continue
			}
			end := bytes.IndexByte(names[n:], 0)
			if end < 0 {
				continue
			}
			if string(names[n:n+uint64(end)]) == ".text" {
				im.address = binary.LittleEndian.Uint64(sec[16:])
				im.offset = binary.LittleEndian.Uint64(sec[24:])
				im.size = binary.LittleEndian.Uint64(sec[32:])
			}
		}
		programOffset := binary.LittleEndian.Uint64(head[32:])
		programSize := uint64(binary.LittleEndian.Uint16(head[54:]))
		programCount := uint64(binary.LittleEndian.Uint16(head[56:]))
		if programCount > 0 && programSize < 56 {
			return im, symError("invalid ELF program header size")
		}
		for i := uint64(0); i < programCount; i++ {
			program, err := region(data, programOffset+i*programSize, 56)
			if err != nil {
				return im, err
			}
			if binary.LittleEndian.Uint32(program) == 1 && binary.LittleEndian.Uint32(program[4:])&1 != 0 {
				im.executable = append(im.executable, fileRegion{binary.LittleEndian.Uint64(program[16:]), binary.LittleEndian.Uint64(program[8:]), binary.LittleEndian.Uint64(program[32:])})
			}
		}
		if im.size != 0 {
			return im, nil
		}
		return im, symError(".text not found")
	}
	if bytes.HasPrefix(data, []byte{0xcf, 0xfa, 0xed, 0xfe}) {
		head, e := region(data, 0, 32)
		if e != nil {
			return im, e
		}
		switch binary.LittleEndian.Uint32(head[4:]) {
		case 0x100000c:
			im.arch = "arm64"
		default:
			return im, symError("unsupported Mach-O cputype %#x", binary.LittleEndian.Uint32(head[4:]))
		}
		pos := uint64(32)
		for range binary.LittleEndian.Uint32(head[16:]) {
			cmd, e := region(data, pos, 8)
			if e != nil {
				return im, e
			}
			size := uint64(binary.LittleEndian.Uint32(cmd[4:]))
			if size < 8 {
				return im, symError("invalid Mach-O load command")
			}
			load, e := region(data, pos, size)
			if e != nil {
				return im, e
			}
			if binary.LittleEndian.Uint32(cmd) == 0x19 {
				if len(load) < 72 {
					return im, symError("truncated Mach-O segment")
				}
				for i := uint64(0); i < uint64(binary.LittleEndian.Uint32(load[64:])); i++ {
					sec, e := region(load, 72+i*80, 80)
					if e != nil {
						return im, e
					}
					kind := binary.LittleEndian.Uint32(sec[64:]) & 0xff
					if kind != 1 && kind != 0xc && kind != 0x12 {
						im.sections = append(im.sections, fileRegion{binary.LittleEndian.Uint64(sec[32:]), uint64(binary.LittleEndian.Uint32(sec[48:])), binary.LittleEndian.Uint64(sec[40:])})
					}
					if strings.TrimRight(string(sec[:16]), "\x00") == "__text" && strings.TrimRight(string(sec[16:32]), "\x00") == "__TEXT" {
						im.address = binary.LittleEndian.Uint64(sec[32:])
						im.size = binary.LittleEndian.Uint64(sec[40:])
						im.offset = uint64(binary.LittleEndian.Uint32(sec[48:]))
					}
				}
			}
			pos += size
		}
		if im.size != 0 {
			return im, nil
		}
		return im, symError("__TEXT,__text not found")
	}
	return im, symError("unrecognized binary format")
}

func locateFunctions(data []byte, names []string) (map[string]*Function, error) {
	im, err := imageText(data)
	if err != nil {
		return nil, err
	}
	if _, err = region(data, im.offset, im.size); err != nil {
		return nil, err
	}
	if im.address+im.size < im.address {
		return nil, symError("invalid .text address range")
	}
	magic := []byte{0xf1, 0xff, 0xff, 0xff, 0, 0}
	var found map[string]*Function
	var malformed error
	for pos := 0; pos < len(data); {
		rel := bytes.Index(data[pos:], magic)
		if rel < 0 {
			break
		}
		base := pos + rel
		pos = base + 1
		var table []byte
		var tableAddress uint64
		for _, section := range im.sections {
			if uint64(base) >= section.offset && uint64(base)-section.offset < section.size {
				// The Go linker pointer-aligns runtime.pcheader. Embedded Go
				// binaries can otherwise look like a second outer-image table.
				if (section.address+uint64(base)-section.offset)%8 != 0 {
					if malformed == nil {
						malformed = symError("unaligned Go pclntab header")
					}
					break
				}
				sectionData, regionErr := region(data, section.offset, section.size)
				if regionErr != nil {
					return nil, regionErr
				}
				table = sectionData[uint64(base)-section.offset:]
				tableAddress = section.address + uint64(base) - section.offset
				break
			}
		}
		if table == nil {
			if malformed == nil {
				malformed = symError("Go pclntab lies outside file-backed sections")
			}
			continue
		}
		candidate, parseErr := parsePclntab120(table, im.size, names)
		if parseErr == nil && binaryFormat(data) == "elf" {
			var bias, textSize uint64
			bias, textSize, parseErr = elfGoTextRange(data, table, im, tableAddress)
			if parseErr == nil {
				candidate, parseErr = parsePclntab120(table, textSize, names)
				for _, f := range candidate {
					if f != nil {
						f.Entryoff += bias
					}
				}
			}
		}
		if parseErr != nil {
			if malformed == nil {
				malformed = parseErr
			}
			continue
		}
		if found != nil {
			return nil, symError("ambiguous Go pclntab: multiple valid tables")
		}
		found = candidate
	}
	if found != nil {
		return found, nil
	}
	if malformed != nil {
		return nil, malformed
	}
	return nil, symError("supported Go 1.20 pclntab not found")
}

// Go 1.20's f1 layout uses 32-bit text-relative entries and 44-byte _func
// records, independent of pointer size. Older magic values have other layouts
// and are deliberately not interpreted here. See runtime/symtab.go and
// debug/gosym/pclntab.go in the Go source tree.
func parsePclntab120(table []byte, textSize uint64, names []string) (map[string]*Function, error) {
	header, err := region(table, 0, 72)
	if err != nil {
		return nil, err
	}
	if (header[6] != 1 && header[6] != 2 && header[6] != 4) || header[7] != 8 {
		return nil, symError("unsupported Go pclntab instruction quantum or pointer size")
	}
	count := binary.LittleEndian.Uint64(header[8:])
	offsets := make([]uint64, 5)
	previous := uint64(72)
	for i := range offsets {
		offsets[i] = binary.LittleEndian.Uint64(header[32+i*8:])
		if offsets[i] < previous || offsets[i] > uint64(len(table)) {
			return nil, symError("invalid Go pclntab subtable offsets")
		}
		previous = offsets[i]
	}
	nametab := table[offsets[0]:offsets[1]]
	pcln := table[offsets[4]:]
	if len(pcln) < 4 || count == 0 || count > (uint64(len(pcln))-4)/8 {
		return nil, symError("invalid Go pclntab function count %d", count)
	}
	functabSize := count*8 + 4
	found := make(map[string]*Function, len(names))
	for _, name := range names {
		found[name] = nil
	}
	for i := uint64(0); i < count; i++ {
		row := pcln[i*8 : i*8+12]
		entry := uint64(binary.LittleEndian.Uint32(row))
		next := uint64(binary.LittleEndian.Uint32(row[8:]))
		if entry > next {
			return nil, symError("Go function entries are not sorted at function %d of %d", i, count)
		}
		if entry >= textSize || next > textSize {
			return nil, symError("Go function %d of %d lies outside .text", i, count)
		}
		recordOffset := uint64(binary.LittleEndian.Uint32(row[4:]))
		if recordOffset < functabSize || recordOffset%4 != 0 {
			return nil, symError("invalid Go function record offset at function %d of %d", i, count)
		}
		record, err := region(pcln, recordOffset, 44)
		if err != nil {
			return nil, err
		}
		if uint64(binary.LittleEndian.Uint32(record)) != entry {
			return nil, symError("Go function record entry mismatch at function %d of %d", i, count)
		}
		nameOffset := int64(int32(binary.LittleEndian.Uint32(record[4:])))
		if nameOffset < 0 || uint64(nameOffset) >= uint64(len(nametab)) {
			return nil, symError("invalid Go function name offset at function %d of %d", i, count)
		}
		raw := nametab[nameOffset:]
		zero := bytes.IndexByte(raw, 0)
		if zero <= 0 || !utf8.Valid(raw[:zero]) || strings.ContainsFunc(string(raw[:zero]), unicode.IsControl) {
			return nil, symError("invalid Go function name at function %d of %d", i, count)
		}
		full := string(raw[:zero])
		short := full[strings.LastIndex(full, "/")+1:]
		for key, value := range found {
			if key != full && key != short {
				continue
			}
			if value != nil {
				return nil, symError("ambiguous Go function %s", key)
			}
			found[key] = &Function{full, entry, next - entry}
		}
	}
	return found, nil
}

// LocateClamp independently resolves the checker target, including its file offset.
func LocateClamp(data []byte) (name, arch string, address, offset, size uint64, err error) {
	im, err := imageText(data)
	if err != nil {
		return "", "", 0, 0, 0, err
	}
	f, err := locateFunctions(data, []string{funcClamp})
	if err != nil {
		return "", "", 0, 0, 0, err
	}
	info := f[funcClamp]
	if info == nil {
		return "", "", 0, 0, 0, symError("%s not found", funcClamp)
	}
	return info.Name, im.arch, im.address + info.Entryoff, im.offset + info.Entryoff, info.Size, nil
}
