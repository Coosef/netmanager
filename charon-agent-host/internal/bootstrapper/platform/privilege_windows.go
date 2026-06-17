//go:build windows

package platform

import "golang.org/x/sys/windows"

// DetectPrivilege checks the elevation status of the running
// process token. The test mirrors what `IsUserAnAdmin` from
// shell32.dll does: it confirms the process token contains the
// Administrators group with an enabled state.
//
// We do NOT use shell32's IsUserAnAdmin directly because it is
// documented as legacy and may be removed in future Windows
// releases; the BUILTIN\Administrators well-known SID approach is
// the stable equivalent.
//
// Token sourcing: GetCurrentProcessToken returns a pseudo-handle
// for the calling process's primary token; no kernel call.
// IsMember walks the token's group SIDs and reports membership.
func DetectPrivilege() (Privilege, error) {
	p := Privilege{}
	token := windows.GetCurrentProcessToken()

	// S-1-5-32-544 is BUILTIN\Administrators.
	var adminsSID *windows.SID
	err := windows.AllocateAndInitializeSid(
		&windows.SECURITY_NT_AUTHORITY,
		2,
		windows.SECURITY_BUILTIN_DOMAIN_RID,
		windows.DOMAIN_ALIAS_RID_ADMINS,
		0, 0, 0, 0, 0, 0,
		&adminsSID,
	)
	if err != nil {
		return p, err
	}
	defer func() { _ = windows.FreeSid(adminsSID) }()

	member, err := token.IsMember(adminsSID)
	if err != nil {
		return p, err
	}
	p.IsAdmin = member

	// LocalSystem detection: the LocalSystem account has the
	// well-known SID S-1-5-18 in its token's User SID slot.
	var localSystemSID *windows.SID
	if err := windows.AllocateAndInitializeSid(
		&windows.SECURITY_NT_AUTHORITY,
		1,
		windows.SECURITY_LOCAL_SYSTEM_RID,
		0, 0, 0, 0, 0, 0, 0,
		&localSystemSID,
	); err == nil {
		defer func() { _ = windows.FreeSid(localSystemSID) }()
		if isLocalSystem, err := token.IsMember(localSystemSID); err == nil {
			p.IsLocalSystem = isLocalSystem
		}
	}
	return p, nil
}
