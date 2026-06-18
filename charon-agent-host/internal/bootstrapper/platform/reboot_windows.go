//go:build windows

package platform

import "golang.org/x/sys/windows/registry"

// DetectReboot probes the three registry-backed signals that signal
// a pending reboot on Windows. Any of the three failing to open
// (e.g. key absent because no update was ever staged) is treated
// as "not pending" -- the absence of the key is the signal itself.
func DetectReboot() (RebootStatus, error) {
	status := RebootStatus{}

	// HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending
	// is present only when CBS has staged a reboot.
	if k, err := registry.OpenKey(
		registry.LOCAL_MACHINE,
		`SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending`,
		registry.QUERY_VALUE,
	); err == nil {
		status.CBSRebootPending = true
		_ = k.Close()
	}

	// HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired
	if k, err := registry.OpenKey(
		registry.LOCAL_MACHINE,
		`SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired`,
		registry.QUERY_VALUE,
	); err == nil {
		status.WURebootRequired = true
		_ = k.Close()
	}

	// HKLM\SYSTEM\CurrentControlSet\Control\Session Manager
	// PendingFileRenameOperations is a REG_MULTI_SZ; the *presence*
	// of any non-empty entry signals the pending operation.
	if k, err := registry.OpenKey(
		registry.LOCAL_MACHINE,
		`SYSTEM\CurrentControlSet\Control\Session Manager`,
		registry.QUERY_VALUE,
	); err == nil {
		if vals, _, e := k.GetStringsValue("PendingFileRenameOperations"); e == nil {
			for _, v := range vals {
				if v != "" {
					status.PendingFileRenameOps = true
					break
				}
			}
		}
		_ = k.Close()
	}
	return status, nil
}
