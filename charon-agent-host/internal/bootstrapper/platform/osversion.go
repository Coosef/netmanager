package platform

import "fmt"

// SupportStatus mirrors the four values from the PR-A Python
// `SupportStatus` enum
// (`backend/app/services/agent_installer/support_matrix.py`).
// The strings are byte-identical so the JSON output and any future
// data-file exchange stays interchangeable.
type SupportStatus string

const (
	StatusSupported   SupportStatus = "supported"
	StatusTestReady   SupportStatus = "test_ready"
	StatusConditional SupportStatus = "conditional"
	StatusUnsupported SupportStatus = "unsupported"
	// StatusUnknown is a Go-side addition for OS releases that
	// the support-matrix lookup cannot place. The bootstrapper's
	// policy is to fail closed on Unknown (same as Unsupported)
	// while letting the JSON output preserve the distinction for
	// observability.
	StatusUnknown SupportStatus = "unknown"
)

// OSVersion is a compact, canonical description of the running OS
// release. The bootstrapper renders this struct into the
// installation plan JSON and into the support-status lookup.
type OSVersion struct {
	// ProductName is the human-readable product line, e.g.
	// "Windows Server 2019 Standard" or "Windows 11 Pro".
	ProductName string `json:"product_name"`
	// Edition is the SKU-level distinguisher (Standard /
	// Datacenter / Pro / Enterprise / ...). Empty if the source
	// did not provide it.
	Edition string `json:"edition,omitempty"`
	// DisplayVersion is the marketing version string (e.g.
	// "22H2", "21H2"). Empty for Server releases that do not
	// carry one.
	DisplayVersion string `json:"display_version,omitempty"`
	// Major / Minor / Build / UBR follow Microsoft's four-part
	// version scheme. Build is the load-bearing number for
	// support decisions on Server 2019 (>= 17763 required).
	Major uint32 `json:"major"`
	Minor uint32 `json:"minor"`
	Build uint32 `json:"build"`
	UBR   uint32 `json:"ubr"`
	// IsServer distinguishes Server SKUs from client (desktop)
	// SKUs. The 32-bit Server lineage ended after Server 2008,
	// so a (IsServer=true, Arch=Arch386) host is always
	// Unsupported.
	IsServer bool `json:"is_server"`
}

// String returns a compact one-line summary for log + plan summary
// use. Format is stable -- some tests assert on it.
func (v OSVersion) String() string {
	sku := "client"
	if v.IsServer {
		sku = "server"
	}
	dv := ""
	if v.DisplayVersion != "" {
		dv = " " + v.DisplayVersion
	}
	return fmt.Sprintf("%s%s [%s, %d.%d.%d.%d]",
		v.ProductName, dv, sku, v.Major, v.Minor, v.Build, v.UBR)
}

// ClassifySupport applies the simplified PR-A support matrix to a
// detected (OSVersion, Architecture) pair. The decision table here
// is a deliberate subset of the full Python matrix; PR-E will unify
// the two via a canonical JSON data file. The technical-debt
// notice is documented in WINDOWS_AGENT_BOOTSTRAPPER.md section
// "Support matrix duplication".
//
// Decisions (all derived from `docs/AGENT_PLATFORM_SUPPORT_MATRIX.md`):
//
//	Windows Server 2019    + amd64  -> SUPPORTED  (Build >= 17763)
//	Windows Server 2022    + amd64  -> SUPPORTED
//	Windows Server 2025    + amd64  -> TEST_READY
//	Windows 10 22H2        + amd64  -> SUPPORTED
//	Windows 11             + amd64  -> SUPPORTED
//	Windows 10             + 386    -> CONDITIONAL
//	Any  Windows Server    + 386    -> UNSUPPORTED
//	Windows XP/Vista/7/8/8.1 (any)  -> UNSUPPORTED
//	Windows Server 2003-2016 (any)  -> UNSUPPORTED
//	Anything else                   -> UNKNOWN
func ClassifySupport(v OSVersion, arch Architecture) SupportStatus {
	if v.IsServer && arch == Arch386 {
		return StatusUnsupported
	}

	switch v.Major {
	case 10:
		// Microsoft kept the major version at 10 for everything
		// from Windows 10 through Windows 11 + Server 2016/2019/
		// 2022/2025. The actual product line is read from the
		// build number.
		switch {
		case v.IsServer && v.Build >= 26100:
			return StatusTestReady // Server 2025 (build 26100)
		case v.IsServer && v.Build >= 20348:
			return StatusSupported // Server 2022 (build 20348)
		case v.IsServer && v.Build >= 17763:
			return StatusSupported // Server 2019 (build 17763)
		case v.IsServer && v.Build >= 14393:
			return StatusUnsupported // Server 2016
		case !v.IsServer && v.Build >= 22000:
			return StatusSupported // Windows 11 (build 22000)
		case !v.IsServer && v.DisplayVersion == "22H2":
			return StatusSupported // Windows 10 22H2
		case !v.IsServer && arch == Arch386:
			return StatusConditional
		default:
			return StatusUnknown
		}
	case 6:
		// 6.x covers Vista (6.0), 7 (6.1), 8 (6.2), 8.1 (6.3),
		// Server 2008 (6.0), 2008 R2 (6.1), 2012 (6.2), 2012 R2
		// (6.3). All explicitly UNSUPPORTED per PR-A.
		return StatusUnsupported
	case 5:
		// 5.x covers Windows 2000 / XP / Server 2003. All EOL.
		return StatusUnsupported
	default:
		return StatusUnknown
	}
}
