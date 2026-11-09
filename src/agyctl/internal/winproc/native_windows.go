package winproc

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

var (
	kernel     = syscall.NewLazyDLL("kernel32.dll")
	queryImage = kernel.NewProc("QueryFullProcessImageNameW")
)

type identity struct {
	pid     uint32
	path    string
	created syscall.Filetime
	handle  syscall.Handle
}

func processIdentity(pid uint32) (identity, error) {
	handle, err := syscall.OpenProcess(0x1000|syscall.SYNCHRONIZE, false, pid)
	if err != nil {
		return identity{}, err
	}
	result := identity{pid: pid, handle: handle}
	buf := make([]uint16, 32768)
	size := uint32(len(buf))
	ok, _, callErr := queryImage.Call(uintptr(handle), 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)))
	if ok == 0 {
		_ = syscall.CloseHandle(handle)
		return identity{}, fmt.Errorf("QueryFullProcessImageName(%d): %w", pid, callErr)
	}
	result.path = syscall.UTF16ToString(buf[:size])
	var exit, kernelTime, userTime syscall.Filetime
	if err := syscall.GetProcessTimes(handle, &result.created, &exit, &kernelTime, &userTime); err != nil {
		_ = syscall.CloseHandle(handle)
		return identity{}, err
	}
	return result, nil
}

func inventory(target Target) ([]identity, bool, error) {
	snapshot, err := syscall.CreateToolhelp32Snapshot(syscall.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = syscall.CloseHandle(snapshot) }()
	var result []identity
	unknown := false
	entry := syscall.ProcessEntry32{Size: uint32(unsafe.Sizeof(syscall.ProcessEntry32{}))}
	err = syscall.Process32First(snapshot, &entry)
	for err == nil {
		name := syscall.UTF16ToString(entry.ExeFile[:])
		if strings.EqualFold(name, "language_server.exe") || strings.EqualFold(name, "Antigravity.exe") || strings.EqualFold(name, "Antigravity - Insiders.exe") || strings.EqualFold(name, filepath.Base(target.ExecutablePath)) || strings.EqualFold(name, filepath.Base(target.BinaryPath)) {
			row, readErr := processIdentity(entry.ProcessID)
			if readErr != nil {
				if !errors.Is(readErr, syscall.Errno(87)) {
					unknown = true
				}
			} else {
				result = append(result, row)
			}
		}
		err = syscall.Process32Next(snapshot, &entry)
	}
	if !errors.Is(err, syscall.ERROR_NO_MORE_FILES) {
		for _, row := range result {
			_ = syscall.CloseHandle(row.handle)
		}
		return nil, false, err
	}
	return result, unknown, nil
}

func Inspect(target Target) (State, error) {
	rows, unknown, err := inventory(target)
	if err != nil {
		return State{}, err
	}
	paths := make([]string, 0, len(rows))
	for _, row := range rows {
		paths = append(paths, row.path)
		_ = syscall.CloseHandle(row.handle)
	}
	return stateForPaths(target, paths, unknown), nil
}
