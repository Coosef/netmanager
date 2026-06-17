//go:build !windows

package platform

import "errors"

// DetectArchitecture is a stub on non-Windows builds. It returns an
// error so that any code path expecting a real probe on a real
// Windows host fails closed during development on a Linux CI runner
// or a Mac developer box. The architecture model itself still
// works -- the *constants* are platform-independent -- so unit
// tests for ParseArchitecture / SelectAgentArchitecture run
// everywhere.
func DetectArchitecture() (ArchitectureSnapshot, error) {
	return ArchitectureSnapshot{
		Process: ProcessArchitecture(),
		Native:  ArchUnknown,
		WOW64:   false,
	}, errors.New("DetectArchitecture: not implemented on non-Windows builds (build with GOOS=windows)")
}
