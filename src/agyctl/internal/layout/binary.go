package layout

import (
	"bytes"
	"debug/elf"
	"debug/macho"
	"debug/pe"
	"errors"
	"fmt"
	"os"
)

type BinaryTarget struct {
	TargetID string `json:"targetId"`
	Format   string `json:"format"`
	Arch     string `json:"arch"`
}

// IdentifyBinary inspects a client as data. It does not qualify patch bytes,
// authenticate the publisher, or execute the inspected file.
func (c Config) IdentifyBinary(path string) (BinaryTarget, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return BinaryTarget{}, err
	}
	var result BinaryTarget
	switch {
	case bytes.HasPrefix(data, []byte("MZ")):
		file, err := pe.NewFile(bytes.NewReader(data))
		if err != nil {
			return result, err
		}
		defer func() { _ = file.Close() }()
		if _, ok := file.OptionalHeader.(*pe.OptionalHeader64); !ok || file.Machine != pe.IMAGE_FILE_MACHINE_AMD64 {
			return result, errors.New("unsupported PE target; expected windows/amd64")
		}
		result = BinaryTarget{"windows/amd64", "pe", "x86-64"}
	case bytes.HasPrefix(data, []byte("\x7fELF")):
		file, err := elf.NewFile(bytes.NewReader(data))
		if err != nil {
			return result, err
		}
		defer func() { _ = file.Close() }()
		if file.Class != elf.ELFCLASS64 || file.Data != elf.ELFDATA2LSB || file.Machine != elf.EM_X86_64 {
			return result, errors.New("unsupported ELF target; expected linux/amd64")
		}
		result = BinaryTarget{"linux/amd64", "elf", "x86-64"}
	default:
		file, err := macho.NewFile(bytes.NewReader(data))
		if err == nil {
			defer func() { _ = file.Close() }()
			if file.Magic != macho.Magic64 || file.Cpu != macho.CpuArm64 {
				return result, errors.New("unsupported Mach-O target; expected darwin/arm64")
			}
		} else {
			fat, fatErr := macho.NewFatFile(bytes.NewReader(data))
			if fatErr != nil {
				return result, fmt.Errorf("unsupported client executable: %w", err)
			}
			defer func() { _ = fat.Close() }()
			count := 0
			for _, arch := range fat.Arches {
				if arch.Cpu == macho.CpuArm64 && arch.File.Cpu == macho.CpuArm64 && arch.Magic == macho.Magic64 {
					count++
				}
			}
			if count != 1 {
				return result, errors.New("universal Mach-O must contain exactly one ARM64 slice")
			}
		}
		result = BinaryTarget{"darwin/arm64", "macho", "arm64"}
	}
	if _, ok := c.Targets[result.TargetID]; !ok {
		return BinaryTarget{}, fmt.Errorf("unsupported target %s", result.TargetID)
	}
	return result, nil
}
