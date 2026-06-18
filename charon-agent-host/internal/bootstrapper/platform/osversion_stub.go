//go:build !windows

package platform

import "errors"

// DetectOSVersion is a stub on non-Windows builds. The bootstrapper
// is Windows-only at runtime; the stub exists so that the package
// compiles on the Linux CI runner and on developer Macs, which lets
// the cross-platform unit tests for ClassifySupport,
// ParseArchitecture, SelectAgentArchitecture, etc. run everywhere.
func DetectOSVersion() (OSVersion, error) {
	return OSVersion{}, errors.New("DetectOSVersion: not implemented on non-Windows builds (build with GOOS=windows)")
}
