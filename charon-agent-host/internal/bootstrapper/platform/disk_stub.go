//go:build !windows

package platform

import "errors"

// DetectDisk is a stub on non-Windows builds.
func DetectDisk(path string, minRequiredBytes uint64) (DiskInfo, error) {
	return DiskInfo{Path: path, MinRequiredBytes: minRequiredBytes},
		errors.New("DetectDisk: not implemented on non-Windows builds (build with GOOS=windows)")
}
