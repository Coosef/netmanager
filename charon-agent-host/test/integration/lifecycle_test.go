//go:build windows && integration

// Package integration exercises the Windows service handler end-to-end:
// install → start → wait 10s Running → wait 30s still Running → stop →
// uninstall, using a long-running child stand-in (powershell.exe with
// Start-Sleep). Runs on the windows-2022 GitHub Actions runner.
package integration

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/Coosef/netmanager/charon-agent-host/internal/config"
	"github.com/Coosef/netmanager/charon-agent-host/internal/service"
)

// testServiceName is intentionally distinct from the production
// NetManagerAgent service so a developer running these tests on a
// real install machine does not clobber a deployed agent.
const testServiceName = "CharonHostIntegrationTest"

func TestLifecycle_InstallStartRunsStopUninstall(t *testing.T) {
	hostExe := buildHostBinary(t)
	workDir := t.TempDir()
	logDir := filepath.Join(workDir, "logs")
	os.MkdirAll(logDir, 0o755)

	cfg := config.Default()
	cfg.ServiceName = testServiceName
	cfg.DisplayName = "Charon Host Integration Test"
	cfg.Description = "Integration test - safe to delete"
	cfg.ChildExe = `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`
	cfg.ChildArgs = []string{
		"-NoProfile",
		"-Command",
		"while ($true) { Start-Sleep -Seconds 5 }",
	}
	cfg.WorkDir = workDir
	cfg.LogDir = logDir
	if err := cfg.Validate(); err != nil {
		t.Fatalf("cfg validation: %v", err)
	}

	// Best-effort pre-clean in case a previous failed run left state.
	_ = service.Uninstall(testServiceName, 5*time.Second)

	// install
	regArgs := []string{
		"run",
		"--service-name", cfg.ServiceName,
		"--display-name", cfg.DisplayName,
		"--description", cfg.Description,
		"--child-exe", cfg.ChildExe,
		"--child-args", joinArgs(cfg.ChildArgs),
		"--work-dir", cfg.WorkDir,
		"--env-file", "",
		"--log-dir", cfg.LogDir,
		"--service-account", cfg.ServiceAccount,
	}
	if err := service.Install(hostExe, cfg, regArgs); err != nil {
		t.Fatalf("install: %v", err)
	}
	t.Cleanup(func() {
		_ = service.Stop(testServiceName)
		time.Sleep(2 * time.Second)
		_ = service.Uninstall(testServiceName, 10*time.Second)
	})

	// start
	if err := service.Start(testServiceName); err != nil {
		t.Fatalf("start: %v", err)
	}

	// 10s check (SCM dispatcher protocol violation surfaces at ~30s,
	// but verify we cleared the immediate StartPending window first).
	time.Sleep(10 * time.Second)
	state, err := service.Status(testServiceName)
	if err != nil {
		t.Fatalf("status @10s: %v", err)
	}
	if state != "Running" {
		t.Fatalf("status @10s = %q, want Running", state)
	}

	// 30s check — proves the SCM dispatcher accepted the host's
	// Running status and did NOT timeout.
	time.Sleep(20 * time.Second)
	state, err = service.Status(testServiceName)
	if err != nil {
		t.Fatalf("status @30s: %v", err)
	}
	if state != "Running" {
		t.Fatalf("status @30s = %q, want Running (SCM dispatcher issue?)", state)
	}

	// stop
	if err := service.Stop(testServiceName); err != nil {
		t.Fatalf("stop: %v", err)
	}
	// Stop completion polling.
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		state, _ = service.Status(testServiceName)
		if state == "Stopped" {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if state != "Stopped" {
		t.Fatalf("post-stop status = %q, want Stopped", state)
	}

	// uninstall (cleanup hook also runs but explicit assertion is useful).
	if err := service.Uninstall(testServiceName, 10*time.Second); err != nil && err != service.ErrServiceNotFound {
		t.Fatalf("uninstall: %v", err)
	}
}

func TestStatus_ServiceNotFoundReturnsSentinel(t *testing.T) {
	_, err := service.Status("DefinitelyDoesNotExist-9f8a")
	if err != service.ErrServiceNotFound {
		t.Fatalf("got %v, want ErrServiceNotFound", err)
	}
}

// ───────────────────── helpers ─────────────────────

func buildHostBinary(t *testing.T) string {
	t.Helper()
	out := filepath.Join(t.TempDir(), "charon-agent-host.exe")
	cmd := exec.Command("go", "build", "-o", out, "../../cmd/charon-agent-host")
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
	if data, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build host binary: %v\n%s", err, data)
	}
	return out
}

func joinArgs(args []string) string {
	if len(args) == 0 {
		return ""
	}
	out := args[0]
	for _, a := range args[1:] {
		out += "," + a
	}
	return out
}

