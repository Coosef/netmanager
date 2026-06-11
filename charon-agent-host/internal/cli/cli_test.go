package cli

import (
	"bytes"
	"strings"
	"testing"

	"github.com/Coosef/netmanager/charon-agent-host/internal/version"
)

func TestDispatch_VersionPrintsVersionString(t *testing.T) {
	var out, errOut bytes.Buffer
	code := Dispatch([]string{"version"}, &out, &errOut)
	if code != 0 {
		t.Fatalf("exit code = %d, want 0", code)
	}
	if !strings.Contains(out.String(), version.Version) {
		t.Fatalf("version subcommand output missing version. Got: %q", out.String())
	}
}

func TestDispatch_UnknownSubcommandPrintsUsageAndExitsNonZero(t *testing.T) {
	var out, errOut bytes.Buffer
	code := Dispatch([]string{"banana"}, &out, &errOut)
	if code == 0 {
		t.Fatalf("unknown subcommand should not exit 0")
	}
	if !strings.Contains(errOut.String(), "unknown subcommand") {
		t.Fatalf("expected 'unknown subcommand' in stderr, got %q", errOut.String())
	}
}

func TestDispatch_HelpPrintsUsage(t *testing.T) {
	var out, errOut bytes.Buffer
	code := Dispatch([]string{"help"}, &out, &errOut)
	if code != 0 {
		t.Fatalf("help exit code = %d, want 0", code)
	}
	for _, want := range []string{"install", "uninstall", "start", "stop", "status"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("usage missing subcommand %q", want)
		}
	}
}

func TestDispatch_InstallMissingFlagsFailsValidation(t *testing.T) {
	var out, errOut bytes.Buffer
	code := Dispatch([]string{"install"}, &out, &errOut)
	if code == 0 {
		t.Fatalf("install with no flags should not exit 0")
	}
	// Validation surfaces in stderr.
	if !strings.Contains(errOut.String(), "child-exe") {
		t.Fatalf("expected child-exe validation error, got %q", errOut.String())
	}
}

func TestBuildRegistryArgs_RoundTrip_SimpleArgs(t *testing.T) {
	// Build args from a config; parsing them back should reproduce
	// the same config (the SCM round-trip invariant).
	fs, cfg, childArgs := installFlagSet(&bytes.Buffer{})
	parseArgs := []string{
		"--service-name", "TestAgent",
		"--display-name", "Test Agent",
		"--child-exe", "/usr/bin/python3",
		"--work-dir", "/tmp/agent",
		"--env-file", "/tmp/agent/config.env",
		"--log-dir", "/tmp/agent/logs",
		"--child-arg", "/tmp/agent/run_agent.py",
	}
	if err := fs.Parse(parseArgs); err != nil {
		t.Fatalf("parse: %v", err)
	}
	cfg.ChildArgs = []string(*childArgs)

	regArgs := buildRegistryArgs(*cfg, cfg.ChildArgs)

	// Parse the rebuilt args (skip the leading "run") and confirm we
	// land on the same cfg.
	fs2, cfg2, childArgs2 := installFlagSet(&bytes.Buffer{})
	if err := fs2.Parse(regArgs[1:]); err != nil {
		t.Fatalf("re-parse: %v", err)
	}
	cfg2.ChildArgs = []string(*childArgs2)

	if cfg.ServiceName != cfg2.ServiceName {
		t.Errorf("service-name lost in round-trip: %q → %q", cfg.ServiceName, cfg2.ServiceName)
	}
	if cfg.ChildExe != cfg2.ChildExe {
		t.Errorf("child-exe lost: %q → %q", cfg.ChildExe, cfg2.ChildExe)
	}
	if !equal(cfg.ChildArgs, cfg2.ChildArgs) {
		t.Errorf("child-args lost: %v → %v", cfg.ChildArgs, cfg2.ChildArgs)
	}
}

// TestBuildRegistryArgs_RoundTrip_CommaInArgs is the regression test
// for the CI integration bug where a child argument containing a
// comma (typical for `-Command "WriteAllText($f, $v)"`) was split by
// the previous CSV scheme and broke PowerShell parsing.
func TestBuildRegistryArgs_RoundTrip_CommaInArgs(t *testing.T) {
	fs, cfg, childArgs := installFlagSet(&bytes.Buffer{})
	tricky := `[System.IO.File]::WriteAllText($pidFile, $PID.ToString())`
	parseArgs := []string{
		"--service-name", "TestAgent",
		"--display-name", "Test Agent",
		"--child-exe", "/usr/bin/python3",
		"--work-dir", "/tmp/agent",
		"--env-file", "/tmp/agent/config.env",
		"--log-dir", "/tmp/agent/logs",
		"--child-arg", "-NoProfile",
		"--child-arg", "-Command",
		"--child-arg", tricky,
	}
	if err := fs.Parse(parseArgs); err != nil {
		t.Fatalf("parse: %v", err)
	}
	cfg.ChildArgs = []string(*childArgs)

	regArgs := buildRegistryArgs(*cfg, cfg.ChildArgs)

	fs2, cfg2, childArgs2 := installFlagSet(&bytes.Buffer{})
	if err := fs2.Parse(regArgs[1:]); err != nil {
		t.Fatalf("re-parse: %v", err)
	}
	cfg2.ChildArgs = []string(*childArgs2)

	if !equal(cfg.ChildArgs, cfg2.ChildArgs) {
		t.Fatalf("comma-containing args lost in round-trip:\n  before: %v\n  after:  %v",
			cfg.ChildArgs, cfg2.ChildArgs)
	}
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
