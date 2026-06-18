package install

import (
	"os"
	"strings"
	"testing"

	"github.com/Coosef/netmanager/charon-agent-host/internal/bootstrapper/platform"
)

// withEnv runs fn with the listed env vars set, restoring previous
// values at the end.
func withEnv(t *testing.T, env map[string]string, fn func()) {
	t.Helper()
	saved := map[string]string{}
	for k, v := range env {
		saved[k] = os.Getenv(k)
		_ = os.Setenv(k, v)
	}
	defer func() {
		for k, v := range saved {
			_ = os.Setenv(k, v)
		}
	}()
	fn()
}

func TestResolveDefaultPaths_X64NativeAmd64Agent(t *testing.T) {
	withEnv(t, map[string]string{
		"ProgramFiles":      `C:\Program Files`,
		"ProgramFiles(x86)": `C:\Program Files (x86)`,
		"ProgramData":       `C:\ProgramData`,
	}, func() {
		snap := platform.ArchitectureSnapshot{Native: platform.ArchAmd64, Process: platform.ArchAmd64}
		got, err := ResolveDefaultPaths(snap, platform.ArchAmd64)
		if err != nil {
			t.Fatalf("ResolveDefaultPaths returned %v", err)
		}
		if got.InstallDir != `C:\Program Files\Charon Agent` && got.InstallDir != `C:\Program Files/Charon Agent` {
			t.Errorf("InstallDir on x64 amd64: got %q", got.InstallDir)
		}
	})
}

func TestResolveDefaultPaths_X64Native386Agent(t *testing.T) {
	withEnv(t, map[string]string{
		"ProgramFiles":      `C:\Program Files`,
		"ProgramFiles(x86)": `C:\Program Files (x86)`,
		"ProgramData":       `C:\ProgramData`,
	}, func() {
		snap := platform.ArchitectureSnapshot{Native: platform.ArchAmd64, Process: platform.Arch386, WOW64: true}
		got, err := ResolveDefaultPaths(snap, platform.Arch386)
		if err != nil {
			t.Fatalf("ResolveDefaultPaths returned %v", err)
		}
		if !strings.Contains(got.InstallDir, "Program Files (x86)") {
			t.Errorf("InstallDir on x64 forced 386: got %q (expected to contain 'Program Files (x86)')", got.InstallDir)
		}
	})
}

func TestResolveDefaultPaths_X86Native386Agent(t *testing.T) {
	withEnv(t, map[string]string{
		"ProgramFiles":      `C:\Program Files`,
		"ProgramFiles(x86)": `C:\Program Files (x86)`,
		"ProgramData":       `C:\ProgramData`,
	}, func() {
		snap := platform.ArchitectureSnapshot{Native: platform.Arch386, Process: platform.Arch386}
		got, err := ResolveDefaultPaths(snap, platform.Arch386)
		if err != nil {
			t.Fatalf("ResolveDefaultPaths returned %v", err)
		}
		// On 32-bit Windows the only Program Files is the main one.
		if strings.Contains(got.InstallDir, "Program Files (x86)") {
			t.Errorf("InstallDir on x86 native should NOT contain 'Program Files (x86)': %q", got.InstallDir)
		}
	})
}

func TestResolveDefaultPaths_X86NativeForceAmd64Rejected(t *testing.T) {
	withEnv(t, map[string]string{
		"ProgramFiles": `C:\Program Files`,
		"ProgramData":  `C:\ProgramData`,
	}, func() {
		snap := platform.ArchitectureSnapshot{Native: platform.Arch386, Process: platform.Arch386}
		_, err := ResolveDefaultPaths(snap, platform.ArchAmd64)
		if err == nil {
			t.Error("ResolveDefaultPaths must reject amd64 install on 32-bit Windows; got no error")
		}
	})
}

func TestResolveDefaultPaths_DataDirAlwaysProgramData(t *testing.T) {
	withEnv(t, map[string]string{
		"ProgramFiles":      `C:\Program Files`,
		"ProgramFiles(x86)": `C:\Program Files (x86)`,
		"ProgramData":       `C:\ProgramData`,
	}, func() {
		snap := platform.ArchitectureSnapshot{Native: platform.ArchAmd64, Process: platform.Arch386, WOW64: true}
		got, _ := ResolveDefaultPaths(snap, platform.Arch386)
		if !strings.Contains(got.DataDir, "ProgramData") {
			t.Errorf("DataDir must live under ProgramData; got %q", got.DataDir)
		}
		if strings.Contains(got.DataDir, "Program Files") {
			t.Errorf("DataDir must NOT contain Program Files; got %q", got.DataDir)
		}
	})
}
