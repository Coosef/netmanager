//go:build windows

package platform

import (
	"errors"
	"strconv"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// DetectOSVersion uses RtlGetVersion (via x/sys/windows) for the
// authoritative version numbers and the
// HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion registry key for
// the product-name + edition strings. Both sources are queried; if
// the registry read fails we still return a valid struct with empty
// string fields so the caller can decide whether to abort or carry
// on.
//
// RtlGetVersion is preferred over GetVersionEx because GetVersionEx
// honours the application's compatibility manifest, and the
// bootstrapper does not (and should not) ship a manifest -- it
// needs the true OS version, not the version the host wants the
// app to think it is on.
func DetectOSVersion() (OSVersion, error) {
	v := OSVersion{}

	rtl := windows.RtlGetVersion()
	if rtl == nil {
		return v, errors.New("RtlGetVersion returned nil")
	}
	v.Major = rtl.MajorVersion
	v.Minor = rtl.MinorVersion
	v.Build = rtl.BuildNumber
	// VER_NT_WORKSTATION = 0x0000001; VER_NT_SERVER /
	// VER_NT_DOMAIN_CONTROLLER carry the Server bit.
	const verNtWorkstation = 0x0000001
	v.IsServer = (rtl.ProductType != verNtWorkstation)

	// Registry: ProductName / DisplayVersion / UBR / EditionID.
	// The registry path is the documented surface for these and
	// has been stable since Windows 7.
	k, err := registry.OpenKey(
		registry.LOCAL_MACHINE,
		`SOFTWARE\Microsoft\Windows NT\CurrentVersion`,
		registry.QUERY_VALUE,
	)
	if err != nil {
		// Treat as soft failure: numeric values from RtlGetVersion
		// are enough for the support classifier; only the human-
		// readable summary loses fidelity.
		return v, nil
	}
	defer k.Close()

	if s, _, e := k.GetStringValue("ProductName"); e == nil {
		v.ProductName = s
	}
	if s, _, e := k.GetStringValue("EditionID"); e == nil {
		v.Edition = s
	}
	if s, _, e := k.GetStringValue("DisplayVersion"); e == nil {
		v.DisplayVersion = s
	}
	// UBR is REG_DWORD on every version since Windows 10.
	if d, _, e := k.GetIntegerValue("UBR"); e == nil {
		// uint32 is the documented surface; safe truncate from
		// the API's uint64 carrier.
		v.UBR = uint32(d & 0xFFFFFFFF)
	} else {
		// On older builds UBR may be missing entirely. Default 0
		// is fine -- the support classifier does not look at UBR.
		_ = strconv.Itoa(0)
	}
	return v, nil
}
