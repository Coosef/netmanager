package security

import "testing"

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
