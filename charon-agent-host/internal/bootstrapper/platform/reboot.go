package platform

// RebootStatus captures the three pending-reboot signals the
// bootstrapper consults. The current MVP policy is to surface a
// warning to the operator; PR-C may upgrade it to a blocker when
// the dependency-resolver phase introduces VC++ runtime install
// (where a half-applied reboot causes weird failures).
type RebootStatus struct {
	// CBS = Component-Based Servicing. The CBS RebootPending
	// registry value is set when WUSA / DISM staged updates
	// require a reboot.
	CBSRebootPending bool `json:"cbs_reboot_pending"`
	// WindowsUpdate RebootRequired is set when the Automatic
	// Updates client itself flagged a reboot.
	WURebootRequired bool `json:"wu_reboot_required"`
	// PendingFileRenameOperations is set when one or more file
	// renames are queued for the next boot (typical of MSI
	// install/uninstall pairs that needed locked-file
	// replacement).
	PendingFileRenameOps bool `json:"pending_file_rename_ops"`
}

// AnyPending returns true when at least one signal is set.
func (r RebootStatus) AnyPending() bool {
	return r.CBSRebootPending || r.WURebootRequired || r.PendingFileRenameOps
}
