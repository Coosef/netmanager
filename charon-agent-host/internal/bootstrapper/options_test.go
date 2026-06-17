package bootstrapper

import (
	"bytes"
	"strings"
	"testing"

	"github.com/Coosef/netmanager/charon-agent-host/internal/bootstrapper/install"
	"github.com/Coosef/netmanager/charon-agent-host/internal/bootstrapper/platform"
)

func TestParse_RejectsAgentKeyOnArgv(t *testing.T) {
	// The bootstrapper MUST refuse to accept agent_key /
	// password / token / JWT as CLI arguments. Any future
	// regression that opens a back door must trip this test.
	for _, banned := range []string{
		"--agent-key=secret",
		"--agent_key=secret",
		"--agentkey=secret",
		"--agent-secret=secret",
		"--password=secret",
		"--pass=secret",
		"--token=secret",
		"--jwt=secret",
		"--x-agent-key=secret",
		"--AGENT-KEY=secret",
	} {
		var errOut bytes.Buffer
		_, err := Parse([]string{banned}, &errOut)
		if err == nil {
			t.Errorf("Parse must reject %q on argv", banned)
		}
	}
}

func TestParse_RejectsAgentKeySpaceSeparated(t *testing.T) {
	var errOut bytes.Buffer
	_, err := Parse([]string{"--agent-key", "secret"}, &errOut)
	if err == nil {
		t.Error("Parse must reject space-separated agent-key arg")
	}
}

func TestParse_AcceptsAgentID(t *testing.T) {
	// AgentID is a public identifier, not a secret, so the
	// guard above must NOT reject it.
	var errOut bytes.Buffer
	opts, err := Parse([]string{"--agent-id=abc123", "--mode=offline"}, &errOut)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if opts.AgentID != "abc123" {
		t.Errorf("AgentID = %q", opts.AgentID)
	}
}

func TestParse_AcceptsValidBackendURL(t *testing.T) {
	var errOut bytes.Buffer
	opts, err := Parse([]string{"--mode=online", "--backend-url=https://x.example.com/"}, &errOut)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if opts.BackendURL != "https://x.example.com" {
		t.Errorf("BackendURL not normalised: got %q", opts.BackendURL)
	}
}

func TestParse_RejectsInvalidBackendURL(t *testing.T) {
	var errOut bytes.Buffer
	_, err := Parse([]string{"--mode=online", "--backend-url=ftp://nope"}, &errOut)
	if err == nil {
		t.Error("Parse must reject ftp scheme")
	}
}

func TestParse_OnlineModeRequiresBackendURL(t *testing.T) {
	var errOut bytes.Buffer
	_, err := Parse([]string{"--mode=online"}, &errOut)
	if err == nil {
		t.Error("Parse must reject online mode without --backend-url")
	}
}

func TestParse_OfflineModeAllowsNoBackendURL(t *testing.T) {
	var errOut bytes.Buffer
	opts, err := Parse([]string{"--mode=offline"}, &errOut)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if opts.Mode != install.ModeOffline {
		t.Errorf("Mode = %q", opts.Mode)
	}
}

func TestParse_RejectsInvalidMode(t *testing.T) {
	var errOut bytes.Buffer
	_, err := Parse([]string{"--mode=remote"}, &errOut)
	if err == nil {
		t.Error("Parse must reject invalid mode")
	}
}

func TestParse_RejectsBadInstallPath(t *testing.T) {
	var errOut bytes.Buffer
	_, err := Parse([]string{"--mode=offline", `--install-dir=\\server\share\Charon`}, &errOut)
	if err == nil {
		t.Error("Parse must reject UNC install path")
	}
}

func TestParse_AcceptsValidInstallPath(t *testing.T) {
	var errOut bytes.Buffer
	opts, err := Parse([]string{
		"--mode=offline",
		`--install-dir=C:\Program Files\Charon Agent`,
	}, &errOut)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if opts.InstallDir != `C:\Program Files\Charon Agent` {
		t.Errorf("InstallDir = %q", opts.InstallDir)
	}
}

func TestParse_ForceArchAccepts386(t *testing.T) {
	var errOut bytes.Buffer
	opts, err := Parse([]string{"--mode=offline", "--force-arch=386"}, &errOut)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if opts.ForceArch != platform.Arch386 {
		t.Errorf("ForceArch = %q", opts.ForceArch)
	}
}

func TestParse_ForceArchRejectsUnsupported(t *testing.T) {
	var errOut bytes.Buffer
	_, err := Parse([]string{"--mode=offline", "--force-arch=arm64"}, &errOut)
	if err == nil {
		t.Error("Parse must reject --force-arch=arm64")
	}
}

func TestParse_OutputFormatGate(t *testing.T) {
	var errOut bytes.Buffer
	if _, err := Parse([]string{"--mode=offline", "--output=json"}, &errOut); err != nil {
		t.Errorf("json output should accept: %v", err)
	}
	if _, err := Parse([]string{"--mode=offline", "--output=text"}, &errOut); err != nil {
		t.Errorf("text output should accept: %v", err)
	}
	if _, err := Parse([]string{"--mode=offline", "--output=yaml"}, &errOut); err == nil {
		t.Error("yaml output must be rejected")
	}
}

func TestParse_DryRunNonInteractiveDefaults(t *testing.T) {
	var errOut bytes.Buffer
	opts, err := Parse([]string{"--mode=offline"}, &errOut)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if opts.DryRun {
		t.Error("DryRun must default false")
	}
	if opts.NonInteractive {
		t.Error("NonInteractive must default false")
	}
}

func TestParse_ShowVersionShortCircuits(t *testing.T) {
	var errOut bytes.Buffer
	opts, err := Parse([]string{"--version"}, &errOut)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if !opts.ShowVersion {
		t.Error("ShowVersion must be true")
	}
}

func TestParse_NoSecretLoggedOnRejection(t *testing.T) {
	var errOut bytes.Buffer
	_, err := Parse([]string{"--agent-key=ultrasecret"}, &errOut)
	if err == nil {
		t.Fatal("Parse must reject agent-key")
	}
	// The error message must name the flag, but MUST NOT include
	// the secret value. Even though the parser exits before
	// touching the value, we belt-and-braces the contract here.
	if strings.Contains(err.Error(), "ultrasecret") {
		t.Errorf("error message leaked secret value: %q", err.Error())
	}
	if strings.Contains(errOut.String(), "ultrasecret") {
		t.Errorf("errOut leaked secret value: %q", errOut.String())
	}
}

// ── PR-B hardening: critical-path / collision at Parse ──────────────────

func TestParse_RejectsInstallDirAtDriveRoot(t *testing.T) {
	var errOut bytes.Buffer
	_, err := Parse([]string{"--mode=offline", `--install-dir=C:\`}, &errOut)
	if err == nil {
		t.Error("install dir at C:\\ must be rejected")
	}
}

func TestParse_RejectsInstallDirAtProgramFilesRoot(t *testing.T) {
	var errOut bytes.Buffer
	_, err := Parse([]string{"--mode=offline", `--install-dir=C:\Program Files`}, &errOut)
	if err == nil {
		t.Error("install dir at C:\\Program Files must be rejected")
	}
}

func TestParse_RejectsDataDirInWindowsTree(t *testing.T) {
	var errOut bytes.Buffer
	_, err := Parse([]string{"--mode=offline", `--data-dir=C:\Windows\System32`}, &errOut)
	if err == nil {
		t.Error("data dir under C:\\Windows must be rejected")
	}
}

func TestParse_RejectsCollidingInstallAndData(t *testing.T) {
	var errOut bytes.Buffer
	_, err := Parse([]string{
		"--mode=offline",
		`--install-dir=C:\Program Files\Charon Agent`,
		`--data-dir=C:\Program Files\Charon Agent\data`,
	}, &errOut)
	if err == nil {
		t.Error("data nested under install must be rejected at Parse")
	}
}

func TestParse_AcceptsValidCharonDirs(t *testing.T) {
	var errOut bytes.Buffer
	opts, err := Parse([]string{
		"--mode=offline",
		`--install-dir=C:\Program Files\Charon Agent`,
		`--data-dir=C:\ProgramData\CharonAgent`,
	}, &errOut)
	if err != nil {
		t.Fatalf("documented defaults must pass: %v", err)
	}
	if opts.InstallDir == "" || opts.DataDir == "" {
		t.Error("Parse must propagate install + data dirs")
	}
}
