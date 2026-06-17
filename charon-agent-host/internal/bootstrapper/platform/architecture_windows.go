//go:build windows

package platform

import (
	"errors"

	"golang.org/x/sys/windows"
)

// DetectArchitecture queries the Windows API for the native machine
// architecture and the running process's WOW64 state. The native
// architecture comes from GetNativeSystemInfo via the x/sys/windows
// SystemInfo wrapper; WOW64 comes from IsWow64Process2 (Windows 10+)
// with a fallback to IsWow64Process when 2 is unavailable.
//
// The function returns an error only when the underlying syscall
// fails outright; an unrecognised processor architecture is
// surfaced as a snapshot with Native==ArchUnknown so the caller can
// log it and bail with an "unsupported architecture" exit code
// rather than crashing.
func DetectArchitecture() (ArchitectureSnapshot, error) {
	snap := ArchitectureSnapshot{Process: ProcessArchitecture()}

	var info windows.SystemInfo
	windows.GetNativeSystemInfo(&info)
	switch info.ProcessorArchitecture {
	case windows.PROCESSOR_ARCHITECTURE_AMD64:
		snap.Native = ArchAmd64
	case windows.PROCESSOR_ARCHITECTURE_INTEL:
		snap.Native = Arch386
	default:
		snap.Native = ArchUnknown
	}

	// WOW64: the safe-and-portable path is IsWow64Process, which is
	// present from Windows XP SP2 onward. IsWow64Process2 (W10+) is
	// more precise but we don't need its extra fidelity for
	// amd64/386 -- the simple flag is enough.
	wow := false
	currentProc, err := windows.GetCurrentProcess(), error(nil)
	if currentProc == 0 {
		return snap, errors.New("GetCurrentProcess returned 0")
	}
	if err = windows.IsWow64Process(currentProc, &wow); err != nil {
		// We treat IsWow64Process failure as fatal because the
		// downstream artifact selector cannot make a safe choice
		// without knowing whether we are a 386 process on x64.
		return snap, err
	}
	snap.WOW64 = wow
	return snap, nil
}
