package platform

import "testing"

func TestClassifySupport_WindowsServer2019Amd64Supported(t *testing.T) {
	v := OSVersion{Major: 10, Build: 17763, IsServer: true, ProductName: "Windows Server 2019"}
	if got := ClassifySupport(v, ArchAmd64); got != StatusSupported {
		t.Errorf("Server 2019 amd64: got %q, want %q", got, StatusSupported)
	}
}

func TestClassifySupport_WindowsServer2022Amd64Supported(t *testing.T) {
	v := OSVersion{Major: 10, Build: 20348, IsServer: true, ProductName: "Windows Server 2022"}
	if got := ClassifySupport(v, ArchAmd64); got != StatusSupported {
		t.Errorf("Server 2022 amd64: got %q, want %q", got, StatusSupported)
	}
}

func TestClassifySupport_WindowsServer2025Amd64TestReady(t *testing.T) {
	v := OSVersion{Major: 10, Build: 26100, IsServer: true, ProductName: "Windows Server 2025"}
	if got := ClassifySupport(v, ArchAmd64); got != StatusTestReady {
		t.Errorf("Server 2025 amd64: got %q, want %q", got, StatusTestReady)
	}
}

func TestClassifySupport_Windows10_22H2_Amd64Supported(t *testing.T) {
	v := OSVersion{Major: 10, Build: 19045, DisplayVersion: "22H2", IsServer: false, ProductName: "Windows 10 Pro"}
	if got := ClassifySupport(v, ArchAmd64); got != StatusSupported {
		t.Errorf("Win10 22H2 amd64: got %q, want %q", got, StatusSupported)
	}
}

func TestClassifySupport_Windows11_Amd64Supported(t *testing.T) {
	v := OSVersion{Major: 10, Build: 22631, IsServer: false, ProductName: "Windows 11 Pro"}
	if got := ClassifySupport(v, ArchAmd64); got != StatusSupported {
		t.Errorf("Win11 amd64: got %q, want %q", got, StatusSupported)
	}
}

func TestClassifySupport_WindowsServer_386_Unsupported(t *testing.T) {
	// 32-bit Server lineage ended after Server 2008. Any Server +
	// 386 combination must be UNSUPPORTED.
	for _, build := range []uint32{17763, 20348, 26100} {
		v := OSVersion{Major: 10, Build: build, IsServer: true}
		if got := ClassifySupport(v, Arch386); got != StatusUnsupported {
			t.Errorf("Server build %d + 386: got %q, want %q", build, got, StatusUnsupported)
		}
	}
}

func TestClassifySupport_Windows10_386_Conditional(t *testing.T) {
	v := OSVersion{Major: 10, Build: 19045, IsServer: false}
	if got := ClassifySupport(v, Arch386); got != StatusConditional {
		t.Errorf("Win10 + 386: got %q, want %q", got, StatusConditional)
	}
}

func TestClassifySupport_WindowsServer2016_Unsupported(t *testing.T) {
	v := OSVersion{Major: 10, Build: 14393, IsServer: true}
	if got := ClassifySupport(v, ArchAmd64); got != StatusUnsupported {
		t.Errorf("Server 2016 amd64: got %q, want %q", got, StatusUnsupported)
	}
}

func TestClassifySupport_EOLDesktops_Unsupported(t *testing.T) {
	// Major 6 covers Vista/7/8/8.1; Major 5 covers Win2000/XP/2003.
	for _, major := range []uint32{5, 6} {
		v := OSVersion{Major: major, Build: 7600, IsServer: false}
		if got := ClassifySupport(v, ArchAmd64); got != StatusUnsupported {
			t.Errorf("major %d: got %q, want %q", major, got, StatusUnsupported)
		}
	}
}

func TestClassifySupport_UnknownMajor_Unknown(t *testing.T) {
	// A future Windows major version we have not characterised
	// yet must classify as UNKNOWN (fail-closed at the caller).
	v := OSVersion{Major: 99, Build: 1, IsServer: false}
	if got := ClassifySupport(v, ArchAmd64); got != StatusUnknown {
		t.Errorf("major 99: got %q, want %q", got, StatusUnknown)
	}
}

func TestOSVersionString_Format(t *testing.T) {
	v := OSVersion{
		ProductName:    "Windows Server 2019",
		DisplayVersion: "1809",
		Major:          10, Minor: 0, Build: 17763, UBR: 6532,
		IsServer: true,
	}
	want := "Windows Server 2019 1809 [server, 10.0.17763.6532]"
	if got := v.String(); got != want {
		t.Errorf("OSVersion.String() = %q, want %q", got, want)
	}
}

func TestOSVersionString_ClientNoDisplayVersion(t *testing.T) {
	v := OSVersion{
		ProductName: "Windows 11 Pro",
		Major:       10, Minor: 0, Build: 22631, UBR: 4541,
		IsServer: false,
	}
	want := "Windows 11 Pro [client, 10.0.22631.4541]"
	if got := v.String(); got != want {
		t.Errorf("OSVersion.String() = %q, want %q", got, want)
	}
}
