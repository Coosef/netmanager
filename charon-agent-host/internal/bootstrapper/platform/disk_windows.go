//go:build windows

package platform

import "golang.org/x/sys/windows"

// DetectDisk queries Windows for the free + total bytes on the
// volume that hosts the given path. The path does not need to
// exist; Windows returns the surface of the volume containing the
// nearest existing ancestor.
func DetectDisk(path string, minRequiredBytes uint64) (DiskInfo, error) {
	info := DiskInfo{Path: path, MinRequiredBytes: minRequiredBytes}
	pathPtr, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return info, err
	}
	var freeAvailable, totalBytes, totalFreeBytes uint64
	if err := windows.GetDiskFreeSpaceEx(
		pathPtr,
		&freeAvailable,
		&totalBytes,
		&totalFreeBytes,
	); err != nil {
		return info, err
	}
	info.FreeBytes = freeAvailable
	info.TotalBytes = totalBytes
	info.Sufficient = freeAvailable >= minRequiredBytes
	return info, nil
}
