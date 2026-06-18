//go:build !windows

package platform

import "errors"

// DetectPrivilege is a stub on non-Windows builds. See
// architecture_stub.go for the rationale.
func DetectPrivilege() (Privilege, error) {
	return Privilege{}, errors.New("DetectPrivilege: not implemented on non-Windows builds (build with GOOS=windows)")
}
