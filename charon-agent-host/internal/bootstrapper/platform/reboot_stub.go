//go:build !windows

package platform

import "errors"

// DetectReboot is a stub on non-Windows builds.
func DetectReboot() (RebootStatus, error) {
	return RebootStatus{}, errors.New("DetectReboot: not implemented on non-Windows builds (build with GOOS=windows)")
}
