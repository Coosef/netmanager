package security

import (
	"strings"
	"testing"
)

func TestValidateInstallPath_AcceptsAbsoluteWindows(t *testing.T) {
	for _, p := range []string{
		`C:\Program Files\Charon Agent`,
		`C:\ProgramData\CharonAgent`,
		`D:\agents\charon`,
		`C:/Program Files/Charon Agent`, // forward slash also accepted
	} {
		if err := ValidateInstallPath(p); err != nil {
			t.Errorf("ValidateInstallPath(%q): expected accept, got %v", p, err)
		}
	}
}

func TestValidateInstallPath_RejectsEmpty(t *testing.T) {
	if err := ValidateInstallPath(""); err == nil {
		t.Error("empty path must be rejected")
	}
	if err := ValidateInstallPath("   "); err == nil {
		t.Error("whitespace-only path must be rejected")
	}
}

func TestValidateInstallPath_RejectsRelative(t *testing.T) {
	for _, p := range []string{
		`Charon Agent`,
		`.\Charon Agent`,
		`..\Charon Agent`,
		`subdir`,
		`/var/lib/charon`,
	} {
		if err := ValidateInstallPath(p); err == nil {
			t.Errorf("relative %q must be rejected", p)
		}
	}
}

func TestValidateInstallPath_RejectsTraversal(t *testing.T) {
	for _, p := range []string{
		`C:\Program Files\..\..\Windows\System32`,
		`C:\foo\..\bar`,
		`D:\..\agents`,
	} {
		if err := ValidateInstallPath(p); err == nil {
			t.Errorf("traversal %q must be rejected", p)
		}
	}
}

func TestValidateInstallPath_RejectsUNC(t *testing.T) {
	for _, p := range []string{
		`\\server\share\Charon`,
		`\\fileserver\agents\charon`,
	} {
		if err := ValidateInstallPath(p); err == nil {
			t.Errorf("UNC %q must be rejected", p)
		}
	}
}

func TestValidateInstallPath_RejectsDeviceNamespace(t *testing.T) {
	for _, p := range []string{
		`\\?\C:\Program Files\Charon`,
		`\\.\PhysicalDrive0`,
	} {
		if err := ValidateInstallPath(p); err == nil {
			t.Errorf("device path %q must be rejected", p)
		}
	}
}

func TestValidateInstallPath_RejectsControlChars(t *testing.T) {
	if err := ValidateInstallPath("C:\\foo\x00bar"); err == nil {
		t.Error("path with NUL byte must be rejected")
	}
	if err := ValidateInstallPath("C:\\foo\x07bar"); err == nil {
		t.Error("path with BEL byte must be rejected")
	}
}

func TestValidateInstallPath_AcceptsNonASCIISegments(t *testing.T) {
	if err := ValidateInstallPath(`C:\ProgramData\Çalışma\CharonAgent`); err != nil {
		t.Errorf("non-ASCII path segment must be accepted: %v", err)
	}
}

// ── PR-B hardening: critical-path blocklist ─────────────────────────────

func TestIsDriveRoot_DetectsAllCasings(t *testing.T) {
	for _, p := range []string{
		`C:\`, `c:\`, `D:\`, `z:\`, `C:/`, `c:/`,
	} {
		if !IsDriveRoot(p) {
			t.Errorf("IsDriveRoot(%q) = false, want true", p)
		}
	}
}

func TestIsDriveRoot_NotConfusedBySubdir(t *testing.T) {
	for _, p := range []string{
		`C:\Foo`, `c:\program files`, `D:\agents\charon`, ``, `C:`,
	} {
		if IsDriveRoot(p) {
			t.Errorf("IsDriveRoot(%q) = true, want false", p)
		}
	}
}

func TestIsCriticalPath_RejectsDriveRoot(t *testing.T) {
	for _, p := range []string{`C:\`, `c:\`, `D:\`, `Z:/`} {
		if reason := IsCriticalPath(p); reason == "" {
			t.Errorf("drive root %q must be rejected", p)
		}
	}
}

func TestIsCriticalPath_RejectsWindowsDirectory(t *testing.T) {
	for _, p := range []string{
		`C:\Windows`, `c:\windows`, `C:\Windows\`, `C:\WINDOWS`,
	} {
		if reason := IsCriticalPath(p); reason == "" {
			t.Errorf("Windows directory %q must be rejected", p)
		}
	}
}

func TestIsCriticalPath_RejectsSystem32(t *testing.T) {
	for _, p := range []string{
		`C:\Windows\System32`, `c:\windows\system32`, `C:\WINDOWS\System32\`,
	} {
		if reason := IsCriticalPath(p); reason == "" {
			t.Errorf("System32 %q must be rejected", p)
		}
	}
}

func TestIsCriticalPath_RejectsSysWOW64(t *testing.T) {
	for _, p := range []string{
		`C:\Windows\SysWOW64`, `c:\windows\syswow64`,
	} {
		if reason := IsCriticalPath(p); reason == "" {
			t.Errorf("SysWOW64 %q must be rejected", p)
		}
	}
}

func TestIsCriticalPath_RejectsProgramFilesRoot(t *testing.T) {
	for _, p := range []string{
		`C:\Program Files`,
		`c:\program files`,
		`C:\Program Files\`,
		`C:\PROGRAM FILES`,
	} {
		if reason := IsCriticalPath(p); reason == "" {
			t.Errorf("Program Files root %q must be rejected", p)
		}
	}
}

func TestIsCriticalPath_RejectsProgramFilesX86Root(t *testing.T) {
	for _, p := range []string{
		`C:\Program Files (x86)`,
		`c:\program files (x86)`,
		`C:\Program Files (x86)\`,
	} {
		if reason := IsCriticalPath(p); reason == "" {
			t.Errorf("Program Files (x86) root %q must be rejected", p)
		}
	}
}

func TestIsCriticalPath_RejectsProgramDataRoot(t *testing.T) {
	for _, p := range []string{
		`C:\ProgramData`,
		`c:\programdata`,
		`C:\PROGRAMDATA`,
		`C:\ProgramData\`,
	} {
		if reason := IsCriticalPath(p); reason == "" {
			t.Errorf("ProgramData root %q must be rejected", p)
		}
	}
}

func TestIsCriticalPath_RejectsUserProfileTree(t *testing.T) {
	for _, p := range []string{
		`C:\Users`,
		`C:\Users\Administrator`,
		`C:\Users\Administrator\AppData\Local\Temp`,
		`c:\users\testuser`,
	} {
		if reason := IsCriticalPath(p); reason == "" {
			t.Errorf("user-profile path %q must be rejected", p)
		}
	}
}

func TestIsCriticalPath_RejectsRecycleBin(t *testing.T) {
	for _, p := range []string{
		`C:\$Recycle.Bin`,
		`c:\$recycle.bin`,
		`C:\$Recycle.Bin\Foo`,
	} {
		if reason := IsCriticalPath(p); reason == "" {
			t.Errorf("Recycle Bin path %q must be rejected", p)
		}
	}
}

func TestIsCriticalPath_AllowsExpectedCharonInstallDirs(t *testing.T) {
	for _, p := range []string{
		`C:\Program Files\Charon Agent`,
		`C:\Program Files (x86)\Charon Agent`,
		`C:\ProgramData\CharonAgent`,
		`C:\Program Files\Charon Agent\bin`,
		`D:\Charon`,
	} {
		if reason := IsCriticalPath(p); reason != "" {
			t.Errorf("expected install dir %q must be allowed; got reason %q", p, reason)
		}
	}
}

func TestIsCriticalPath_DoesNotConfuseSimilarPrefixes(t *testing.T) {
	// "C:\Windows" is forbidden as subtree; "C:\WindowsServer"
	// must NOT be silently caught by a naive prefix check.
	if reason := IsCriticalPath(`C:\WindowsServer`); reason != "" {
		t.Errorf("similar-prefix path C:\\WindowsServer must be allowed; got %q", reason)
	}
	if reason := IsCriticalPath(`C:\Users2`); reason != "" {
		t.Errorf("similar-prefix path C:\\Users2 must be allowed; got %q", reason)
	}
}

func TestIsCriticalPath_ErrorMessageNoEcho(t *testing.T) {
	// The reason string must not echo the operator's input path
	// so that an accidentally-pasted sensitive path is not echoed
	// through the error output.
	reason := IsCriticalPath(`C:\Users\Administrator\Documents\Secret`)
	if reason == "" {
		t.Fatal("path under user profile must be rejected")
	}
	if strings.Contains(reason, "Administrator") || strings.Contains(reason, "Secret") {
		t.Errorf("reason echoed the input path: %q", reason)
	}
}

// ── PR-B hardening: install/data directory relationship ─────────────────

func TestIsParentOrEqual_BasicSegmentAware(t *testing.T) {
	// Equal: parent of itself.
	if !IsParentOrEqual(`C:\Foo`, `C:\Foo`) {
		t.Error("equal paths must be parent-or-equal")
	}
	// Strict ancestor.
	if !IsParentOrEqual(`C:\Foo`, `C:\Foo\Bar`) {
		t.Error("C:\\Foo should be parent of C:\\Foo\\Bar")
	}
	// Sibling -- not parent.
	if IsParentOrEqual(`C:\Foo`, `C:\Bar`) {
		t.Error("siblings must not be parent-or-equal")
	}
	// CRITICAL: C:\Foo is NOT a parent of C:\Foobar; the segment-
	// aware comparison must catch this.
	if IsParentOrEqual(`C:\Foo`, `C:\Foobar`) {
		t.Error("C:\\Foo must NOT be considered parent of C:\\Foobar (segment-aware comparison)")
	}
	if IsParentOrEqual(`C:\Foobar`, `C:\Foo`) {
		t.Error("C:\\Foobar must NOT be considered parent of C:\\Foo")
	}
}

func TestIsParentOrEqual_CaseInsensitive(t *testing.T) {
	if !IsParentOrEqual(`c:\foo`, `C:\FOO\BAR`) {
		t.Error("case-insensitive comparison failed")
	}
	if !IsParentOrEqual(`C:\PROGRAM FILES`, `c:\program files\charon agent`) {
		t.Error("case-insensitive comparison failed for spaced path")
	}
}

func TestIsParentOrEqual_HandlesForwardSlashes(t *testing.T) {
	if !IsParentOrEqual(`C:/Foo`, `C:\Foo\Bar`) {
		t.Error("forward-slash parent must match backslash child")
	}
}

func TestValidateDirectoryPair_DefaultsArePairSafe(t *testing.T) {
	// The bootstrapper's documented defaults must not collide.
	got := ValidateDirectoryPair(
		`C:\Program Files\Charon Agent`,
		`C:\ProgramData\CharonAgent`,
	)
	if got != "" {
		t.Errorf("documented defaults must pass collision check; got %q", got)
	}
}

func TestValidateDirectoryPair_RejectsIdentical(t *testing.T) {
	for _, pair := range [][2]string{
		{`C:\Foo`, `C:\Foo`},
		{`C:\Foo`, `c:\foo\`}, // case + trailing slash difference
	} {
		if got := ValidateDirectoryPair(pair[0], pair[1]); got == "" {
			t.Errorf("identical paths must be rejected: %v", pair)
		}
	}
}

func TestValidateDirectoryPair_RejectsDataInsideInstall(t *testing.T) {
	got := ValidateDirectoryPair(
		`C:\Program Files\Charon Agent`,
		`C:\Program Files\Charon Agent\data`,
	)
	if got == "" {
		t.Error("data nested inside install must be rejected")
	}
}

func TestValidateDirectoryPair_RejectsInstallInsideData(t *testing.T) {
	got := ValidateDirectoryPair(
		`C:\ProgramData\CharonAgent\bin\install`,
		`C:\ProgramData\CharonAgent`,
	)
	if got == "" {
		t.Error("install nested inside data must be rejected")
	}
}

func TestValidateDirectoryPair_AllowsSimilarPrefixSiblings(t *testing.T) {
	// "C:\Foo" and "C:\Foobar" must NOT be flagged as collision
	// (the IsParentOrEqual check is segment-aware).
	got := ValidateDirectoryPair(`C:\Foo`, `C:\Foobar`)
	if got != "" {
		t.Errorf("similar-prefix siblings must not be flagged: %q", got)
	}
}
