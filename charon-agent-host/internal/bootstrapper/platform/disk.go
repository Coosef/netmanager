package platform

// DiskInfo records the free-space probe result for one volume.
// Sizes are in bytes. Path is the absolute path the probe queried;
// when the bootstrapper has not yet selected an install or data
// directory it may probe a parent (e.g. "C:\Program Files\").
type DiskInfo struct {
	Path             string `json:"path"`
	FreeBytes        uint64 `json:"free_bytes"`
	TotalBytes       uint64 `json:"total_bytes"`
	MinRequiredBytes uint64 `json:"min_required_bytes"`
	Sufficient       bool   `json:"sufficient"`
}

// MinimumInstallBytes is the default disk requirement for the
// install directory ("Program Files" tree). 500 MiB is a planning
// figure; PR-C will replace it with a number derived from the real
// runtime tarball size.
const MinimumInstallBytes uint64 = 500 * 1024 * 1024

// MinimumDataBytes is the default disk requirement for the data
// directory ("ProgramData" tree). 1 GiB covers log rotation +
// staging + rollback + queue with reasonable headroom.
const MinimumDataBytes uint64 = 1 * 1024 * 1024 * 1024
