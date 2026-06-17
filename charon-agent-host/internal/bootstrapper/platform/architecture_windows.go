//go:build windows

package platform

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

// SYSTEM_INFO mirrors the kernel32 layout. golang.org/x/sys/windows
// v0.21.0 does not export the struct; we declare it locally so the
// downstream GetNativeSystemInfo syscall has the right ABI.
type _systemInfo struct {
	ProcessorArchitecture     uint16
	Reserved                  uint16
	PageSize                  uint32
	MinimumApplicationAddress uintptr
	MaximumApplicationAddress uintptr
	ActiveProcessorMask       uintptr
	NumberOfProcessors        uint32
	ProcessorType             uint32
	AllocationGranularity     uint32
	ProcessorLevel            uint16
	ProcessorRevision         uint16
}

// Processor-architecture identifiers, from winnt.h. golang.org/x/sys/
// windows v0.21.0 does not export these as named constants; we pin
// them locally and document the source so a future API consolidation
// is mechanical to apply.
const (
	_PROCESSOR_ARCHITECTURE_INTEL   uint16 = 0      // i386 32-bit x86
	_PROCESSOR_ARCHITECTURE_AMD64   uint16 = 9      // x64 64-bit x86
	_PROCESSOR_ARCHITECTURE_UNKNOWN uint16 = 0xFFFF // ARM, IA-64, etc -- handled as "unknown" by ParseArchitecture
)

var (
	_modkernel32             = windows.NewLazySystemDLL("kernel32.dll")
	_procGetNativeSystemInfo = _modkernel32.NewProc("GetNativeSystemInfo")
)

// DetectArchitecture queries the Windows API for the native machine
// architecture and the running process's WOW64 state. The native
// architecture comes from the kernel32 GetNativeSystemInfo syscall
// (not GetSystemInfo -- the latter returns the WOW64-projected
// architecture, which is wrong for a 386 process on x64).
//
// WOW64 detection uses windows.IsWow64Process. windows.CurrentProcess()
// returns the pseudo-handle (-1) for the current process; no syscall
// involved.
func DetectArchitecture() (ArchitectureSnapshot, error) {
	snap := ArchitectureSnapshot{Process: ProcessArchitecture()}

	var info _systemInfo
	// GetNativeSystemInfo is documented as VOID return; Call() still
	// returns (r1, r2, err). r1 / r2 are meaningless for VOID
	// signatures; err is non-nil only on Last-Error conditions
	// that GetNativeSystemInfo itself does not set, so we ignore
	// all three and rely on the populated struct.
	_, _, _ = _procGetNativeSystemInfo.Call(uintptr(unsafe.Pointer(&info)))
	switch info.ProcessorArchitecture {
	case _PROCESSOR_ARCHITECTURE_AMD64:
		snap.Native = ArchAmd64
	case _PROCESSOR_ARCHITECTURE_INTEL:
		snap.Native = Arch386
	default:
		snap.Native = ArchUnknown
	}

	wow := false
	if err := windows.IsWow64Process(windows.CurrentProcess(), &wow); err != nil {
		return snap, err
	}
	snap.WOW64 = wow
	return snap, nil
}
