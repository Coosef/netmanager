//go:build windows && integration

// Package integration exercises the Windows service handler end-to-end
// against a real Service Control Manager on a windows-2022 GitHub
// runner. The tests cover the SCM lifecycle (install → start → 10s/30s
// Running → stop → uninstall), child crash + auto-restart, and the
// "stop during backoff suppresses restart" contract.
package integration

import (
	"fmt"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Coosef/netmanager/charon-agent-host/internal/config"
	"github.com/Coosef/netmanager/charon-agent-host/internal/service"
)

// uniqueServiceName produces a service identifier that does not
// collide with concurrent CI runs, manual re-runs, or production.
//
// The Windows-2022 GitHub-hosted runner exposes:
//
//	GITHUB_RUN_ID      — globally unique per PR run
//	GITHUB_RUN_ATTEMPT — increments on rerun-failed-jobs
//
// Format: CharonHostIT-<run-id>-<attempt>-<rand4>
func uniqueServiceName() string {
	runID := os.Getenv("GITHUB_RUN_ID")
	if runID == "" {
		// Local developer run.
		runID = strconv.FormatInt(time.Now().Unix(), 10)
	}
	attempt := os.Getenv("GITHUB_RUN_ATTEMPT")
	if attempt == "" {
		attempt = "1"
	}
	return fmt.Sprintf("CharonHostIT-%s-%s-%04x", runID, attempt, rand.Intn(0x10000))
}

// fakeChildScript is a powershell snippet whose PID is written to
// the file at $env:CHARON_TEST_PID_FILE on startup. The child loops
// forever; the test scaffolding either lets it run, kills it, or
// stops the service to terminate it.
//
// The PID file is the test's only handle on "is the child the same
// instance or did the supervisor relaunch it" — comparing two
// successive reads tells us a restart happened.
const fakeChildScript = `
  $pidFile = $env:CHARON_TEST_PID_FILE
  if ($pidFile) {
    [System.IO.File]::WriteAllText($pidFile, $PID.ToString())
  }
  while ($true) { Start-Sleep -Seconds 1 }
`

// scaffold builds a Config + helper functions for an integration
// test. The caller's t.Cleanup hook is registered so even a panic
// or t.Fatalf still tears down the service and the child.
type scaffold struct {
	cfg         config.Config
	hostExe     string
	pidFile     string
	logDir      string
	serviceName string
}

func newScaffold(t *testing.T) *scaffold {
	t.Helper()

	logDirRoot := os.Getenv("CHARON_HOST_IT_LOG_DIR")
	if logDirRoot == "" {
		logDirRoot = t.TempDir()
	}
	logDir := filepath.Join(logDirRoot, sanitizeForPath(t.Name()))
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		t.Fatalf("mkdir log dir: %v", err)
	}
	workDir := t.TempDir()
	pidFile := filepath.Join(workDir, "child.pid")

	cfg := config.Default()
	cfg.ServiceName = uniqueServiceName()
	cfg.DisplayName = "Charon Host IT — " + t.Name()
	cfg.Description = "Integration test - safe to delete"
	cfg.ChildExe = `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`
	cfg.ChildArgs = []string{
		"-NoProfile",
		"-ExecutionPolicy", "Bypass",
		"-Command", fakeChildScript,
	}
	cfg.WorkDir = workDir
	cfg.LogDir = logDir
	if err := cfg.Validate(); err != nil {
		t.Fatalf("cfg validation: %v", err)
	}

	// Pass the PID file location to the child via an env file —
	// LoadEnvFile picks it up and the handler buildEnv merges it
	// into the child's environment.
	envFile := filepath.Join(workDir, "agent.env")
	envContent := "CHARON_TEST_PID_FILE=" + pidFile + "\r\n"
	if err := os.WriteFile(envFile, []byte(envContent), 0o600); err != nil {
		t.Fatalf("write env file: %v", err)
	}
	cfg.EnvFile = envFile

	s := &scaffold{
		cfg:         cfg,
		hostExe:     buildHostBinary(t),
		pidFile:     pidFile,
		logDir:      logDir,
		serviceName: cfg.ServiceName,
	}

	// Best-effort pre-clean if a previous failed run left a service
	// with the same name (vanishingly unlikely with the unique
	// suffix but defensive).
	_ = service.Uninstall(s.serviceName, 5*time.Second)

	// ALWAYS cleanup, even on t.Fatalf / panic. Cleanup hook
	// records the error encountered but never panics itself —
	// hiding test failures behind cleanup-only output is worse
	// than a slow tear-down log line.
	t.Cleanup(func() {
		if err := service.Stop(s.serviceName); err != nil &&
			err != service.ErrServiceNotFound {
			t.Logf("cleanup: service.Stop returned %v", err)
		}
		time.Sleep(2 * time.Second)
		if err := service.Uninstall(s.serviceName, 10*time.Second); err != nil &&
			err != service.ErrServiceNotFound {
			t.Logf("cleanup: service.Uninstall returned %v", err)
		}
	})

	return s
}

func (s *scaffold) install(t *testing.T) {
	t.Helper()
	regArgs := []string{
		"run",
		"--service-name", s.cfg.ServiceName,
		"--display-name", s.cfg.DisplayName,
		"--description", s.cfg.Description,
		"--child-exe", s.cfg.ChildExe,
		"--work-dir", s.cfg.WorkDir,
		"--env-file", s.cfg.EnvFile,
		"--log-dir", s.cfg.LogDir,
		"--service-account", s.cfg.ServiceAccount,
	}
	for _, a := range s.cfg.ChildArgs {
		regArgs = append(regArgs, "--child-arg", a)
	}
	if err := service.Install(s.hostExe, s.cfg, regArgs); err != nil {
		t.Fatalf("install %q: %v", s.serviceName, err)
	}
}

func (s *scaffold) start(t *testing.T) {
	t.Helper()
	if err := service.Start(s.serviceName); err != nil {
		t.Fatalf("start %q: %v", s.serviceName, err)
	}
}

func (s *scaffold) waitStatus(t *testing.T, want string, within time.Duration) {
	t.Helper()
	deadline := time.Now().Add(within)
	var last string
	for time.Now().Before(deadline) {
		st, err := service.Status(s.serviceName)
		if err == nil {
			last = st
			if st == want {
				return
			}
		}
		time.Sleep(250 * time.Millisecond)
	}
	t.Fatalf("status: still %q after %v, want %q", last, within, want)
}

// childPID reads the PID file. Polls for up to `within` since the
// child writes the file as one of its first acts.
func (s *scaffold) childPID(t *testing.T, within time.Duration) int {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(s.pidFile)
		if err == nil && len(data) > 0 {
			pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
			if err == nil && pid > 0 {
				return pid
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("child PID file %q never appeared within %v", s.pidFile, within)
	return 0
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

// TestLifecycle_InstallStartRunsStopUninstall is the canonical
// SCM lifecycle proof: install → 10s Running → 30s Running →
// stop → uninstall.
func TestLifecycle_InstallStartRunsStopUninstall(t *testing.T) {
	s := newScaffold(t)
	s.install(t)
	s.start(t)

	// 10s — clears the immediate StartPending window.
	time.Sleep(10 * time.Second)
	st, err := service.Status(s.serviceName)
	if err != nil {
		t.Fatalf("status @10s: %v", err)
	}
	if st != "Running" {
		t.Fatalf("status @10s = %q, want Running", st)
	}

	// 30s — proves SCM accepted the host's Running status and did
	// not time out on the dispatcher protocol.
	time.Sleep(20 * time.Second)
	st, err = service.Status(s.serviceName)
	if err != nil {
		t.Fatalf("status @30s: %v", err)
	}
	if st != "Running" {
		t.Fatalf("status @30s = %q, want Running (SCM dispatcher issue?)", st)
	}

	if err := service.Stop(s.serviceName); err != nil {
		t.Fatalf("stop: %v", err)
	}
	s.waitStatus(t, "Stopped", 20*time.Second)

	if err := service.Uninstall(s.serviceName, 10*time.Second); err != nil &&
		err != service.ErrServiceNotFound {
		t.Fatalf("uninstall: %v", err)
	}
}

// TestChildCrash_TriggersAutoRestart proves the host's restart
// backoff actually launches a replacement child when the current
// child is force-killed externally.
//
// 1. Service Running
// 2. Read PID#1 from the PID file
// 3. Force-kill PID#1 via taskkill /F /T
// 4. Wait for the supervisor's backoff (first attempt = 1s) to fire
// 5. Read PID#2; it MUST differ from PID#1
// 6. Service is still Running
func TestChildCrash_TriggersAutoRestart(t *testing.T) {
	s := newScaffold(t)
	s.install(t)
	s.start(t)
	s.waitStatus(t, "Running", 15*time.Second)

	pid1 := s.childPID(t, 10*time.Second)
	t.Logf("first child PID: %d", pid1)

	// Force-kill the child + its tree (the Job Object should
	// already have done this for us if the child had grandchildren,
	// but taskkill is the external-kill scenario the test cares
	// about).
	out, err := exec.Command("taskkill.exe", "/F", "/T", "/PID",
		strconv.Itoa(pid1)).CombinedOutput()
	t.Logf("taskkill /F /T /PID %d → %s", pid1, strings.TrimSpace(string(out)))
	if err != nil {
		// If taskkill says "process not found" that is fine — the
		// child may have exited as part of the kill propagation.
		if !strings.Contains(string(out), "not found") {
			t.Fatalf("taskkill: %v", err)
		}
	}

	// Wait for the restart. Backoff schedule: 1s/5s/15s/... — first
	// attempt fires at 1s, so 8s of grace is generous.
	deadline := time.Now().Add(8 * time.Second)
	var pid2 int
	for time.Now().Before(deadline) {
		// Clear stale value: a previous read might cache.
		data, err := os.ReadFile(s.pidFile)
		if err == nil {
			candidate, _ := strconv.Atoi(strings.TrimSpace(string(data)))
			if candidate > 0 && candidate != pid1 {
				pid2 = candidate
				break
			}
		}
		time.Sleep(250 * time.Millisecond)
	}
	if pid2 == 0 {
		t.Fatalf("no replacement child observed within 8s (still %d)", pid1)
	}
	t.Logf("replacement child PID: %d (was %d)", pid2, pid1)

	st, err := service.Status(s.serviceName)
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if st != "Running" {
		t.Fatalf("post-restart status = %q, want Running", st)
	}

	if err := service.Stop(s.serviceName); err != nil {
		t.Fatalf("stop: %v", err)
	}
	s.waitStatus(t, "Stopped", 20*time.Second)
}

// TestStop_DuringRestartBackoff_SuppressesRestart proves the
// supervisor honours a service Stop while it is asleep in the
// restart backoff, and does NOT spawn a new child after stop.
//
// 1. Service Running
// 2. Read PID#1
// 3. Force-kill PID#1
// 4. Within the supervisor's 1s backoff window, send Stop
// 5. Service reaches Stopped
// 6. No new child appears (PID file unchanged or absent for 5s)
func TestStop_DuringRestartBackoff_SuppressesRestart(t *testing.T) {
	s := newScaffold(t)
	s.install(t)
	s.start(t)
	s.waitStatus(t, "Running", 15*time.Second)

	pid1 := s.childPID(t, 10*time.Second)
	t.Logf("initial child PID: %d", pid1)

	// Kill, then IMMEDIATELY send stop. We need to slip the stop
	// in before the supervisor's 1s backoff timer expires.
	if out, err := exec.Command("taskkill.exe", "/F", "/T", "/PID",
		strconv.Itoa(pid1)).CombinedOutput(); err != nil {
		if !strings.Contains(string(out), "not found") {
			t.Fatalf("taskkill: %v\n%s", err, out)
		}
	}

	// 200ms is comfortably inside the 1s first-attempt backoff but
	// long enough that the kill has propagated.
	time.Sleep(200 * time.Millisecond)

	if err := service.Stop(s.serviceName); err != nil {
		t.Fatalf("stop: %v", err)
	}
	s.waitStatus(t, "Stopped", 15*time.Second)

	// Watch the PID file for 5s. The supervisor MUST NOT have
	// started a replacement: the file's contents should still be
	// pid1 (the dead PID) or the file may have been deleted.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(s.pidFile)
		if err == nil && len(data) > 0 {
			latest, _ := strconv.Atoi(strings.TrimSpace(string(data)))
			if latest > 0 && latest != pid1 {
				t.Fatalf("supervisor spawned replacement child %d after Stop", latest)
			}
		}
		time.Sleep(250 * time.Millisecond)
	}
}

// TestStatus_ServiceNotFoundReturnsSentinel — unchanged sentinel
// check, kept under the new scaffolding-free path so it's quick.
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

// sanitizeForPath turns t.Name() into a path-safe slug so each
// test's log slice lives in its own subdirectory.
func sanitizeForPath(name string) string {
	repl := strings.NewReplacer("/", "_", "\\", "_", " ", "_", ":", "_")
	return repl.Replace(name)
}
