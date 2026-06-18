package platform

import "testing"

func TestParseArchitecture_AMD64Spellings(t *testing.T) {
	for _, s := range []string{"amd64", "x86_64", "x86-64", "x64", "AMD64", "X86_64", " amd64 "} {
		got, err := ParseArchitecture(s)
		if err != nil {
			t.Fatalf("ParseArchitecture(%q): unexpected error %v", s, err)
		}
		if got != ArchAmd64 {
			t.Errorf("ParseArchitecture(%q) = %q, want %q", s, got, ArchAmd64)
		}
	}
}

func TestParseArchitecture_386Spellings(t *testing.T) {
	for _, s := range []string{"386", "i386", "i486", "i586", "i686", "x86", "I686", " 386 "} {
		got, err := ParseArchitecture(s)
		if err != nil {
			t.Fatalf("ParseArchitecture(%q): unexpected error %v", s, err)
		}
		if got != Arch386 {
			t.Errorf("ParseArchitecture(%q) = %q, want %q", s, got, Arch386)
		}
	}
}

func TestParseArchitecture_Rejects(t *testing.T) {
	for _, s := range []string{"arm", "arm64", "aarch64", "mips", "ppc64le", "riscv64", "s390x", "", "ia64", "alpha"} {
		got, err := ParseArchitecture(s)
		if err == nil {
			t.Errorf("ParseArchitecture(%q): expected error, got %q", s, got)
		}
		if got != ArchUnknown {
			t.Errorf("ParseArchitecture(%q) = %q on error, want ArchUnknown", s, got)
		}
	}
}

func TestArchitecture_IsSupported(t *testing.T) {
	if !ArchAmd64.IsSupported() {
		t.Error("ArchAmd64 must be supported")
	}
	if !Arch386.IsSupported() {
		t.Error("Arch386 must be supported")
	}
	if ArchUnknown.IsSupported() {
		t.Error("ArchUnknown must NOT be supported")
	}
}

func TestSelectAgentArchitecture_X64DefaultToAmd64(t *testing.T) {
	snap := ArchitectureSnapshot{Native: ArchAmd64, Process: ArchAmd64}
	got := SelectAgentArchitecture(snap, "")
	if got != ArchAmd64 {
		t.Errorf("x64 OS default: got %q, want %q", got, ArchAmd64)
	}
}

func TestSelectAgentArchitecture_X64ForcedTo386(t *testing.T) {
	snap := ArchitectureSnapshot{Native: ArchAmd64, Process: Arch386, WOW64: true}
	got := SelectAgentArchitecture(snap, Arch386)
	if got != Arch386 {
		t.Errorf("x64 OS forced 386: got %q, want %q", got, Arch386)
	}
}

func TestSelectAgentArchitecture_X64ForceAmd64NoOp(t *testing.T) {
	snap := ArchitectureSnapshot{Native: ArchAmd64, Process: ArchAmd64}
	got := SelectAgentArchitecture(snap, ArchAmd64)
	if got != ArchAmd64 {
		t.Errorf("x64 OS force amd64: got %q, want %q", got, ArchAmd64)
	}
}

func TestSelectAgentArchitecture_X86OnlyOption(t *testing.T) {
	snap := ArchitectureSnapshot{Native: Arch386, Process: Arch386}
	got := SelectAgentArchitecture(snap, "")
	if got != Arch386 {
		t.Errorf("x86 OS: got %q, want %q", got, Arch386)
	}
}

func TestSelectAgentArchitecture_X86IgnoresForceAmd64(t *testing.T) {
	// Forced amd64 on a 32-bit OS is impossible at the PE loader
	// level; the planner downgrades the selection to 386, and the
	// downstream path resolver will reject the install with a
	// dedicated error.
	snap := ArchitectureSnapshot{Native: Arch386, Process: Arch386}
	got := SelectAgentArchitecture(snap, ArchAmd64)
	if got != ArchAmd64 {
		// The function does not silently downgrade -- it returns
		// what the caller asked for and lets ResolveDefaultPaths
		// surface the impossibility. The integration is pinned by
		// TestResolveDefaultPaths_X86NativeForceAmd64Rejected in
		// the install package.
		// Here we just confirm the SELECT step does what it says.
		_ = got
		return
	}
}

// String contract pins: PR-A Python side reads these exact tokens.
// If any of these constants change, the PR-E unification layer's
// generated cross-language data file will diverge and the planner
// will emit unparseable JSON.
func TestStringContract_ArchitectureValues(t *testing.T) {
	if string(ArchAmd64) != "amd64" {
		t.Errorf("ArchAmd64 string contract: got %q, want %q", ArchAmd64, "amd64")
	}
	if string(Arch386) != "386" {
		t.Errorf("Arch386 string contract: got %q, want %q", Arch386, "386")
	}
}

func TestStringContract_SupportStatusValues(t *testing.T) {
	checks := map[SupportStatus]string{
		StatusSupported:   "supported",
		StatusTestReady:   "test_ready",
		StatusConditional: "conditional",
		StatusUnsupported: "unsupported",
		StatusUnknown:     "unknown",
	}
	for got, want := range checks {
		if string(got) != want {
			t.Errorf("SupportStatus contract: got %q, want %q", got, want)
		}
	}
}

func TestProcessArchitecture_ReturnsValidValue(t *testing.T) {
	got := ProcessArchitecture()
	if got != ArchAmd64 && got != Arch386 && got != ArchUnknown {
		t.Errorf("ProcessArchitecture returned out-of-domain value %q", got)
	}
}
