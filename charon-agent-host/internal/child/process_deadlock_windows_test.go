//go:build windows

package child

import (
	"context"
	"testing"
	"time"
)

// TestStart_NoSelfDeadlockOnAttachToJob is the regression guard for
// the CI StartPending incident.
//
// Process.Start() takes p.mu and holds it for the whole body. The
// helper that attaches the just-spawned child to the Job Object used
// to take p.mu again before assigning p.jobHandle. sync.Mutex is not
// reentrant, so the second Lock blocked forever; cmd.Start returned,
// the child was running, but Start itself never returned. The host
// supervisor stayed at "calling proc.Start" with no Running status
// ever delivered to the SCM, and the integration suite timed out
// every run for 8 consecutive iterations.
//
// This test traps the same deadlock by running Start in a goroutine
// with a 5-second budget. The legitimate code path completes in
// milliseconds; anything longer than 5s is the deadlock returning.
func TestStart_NoSelfDeadlockOnAttachToJob(t *testing.T) {
	p := &Process{
		// cmd.exe /c ping -n 60 localhost is a portable, harmless
		// long-running child on every Windows runner.
		Exec: `C:\Windows\System32\cmd.exe`,
		Args: []string{"/c", "ping", "-n", "60", "127.0.0.1"},
	}

	done := make(chan error, 1)
	go func() {
		done <- p.Start(context.Background())
	}()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Start returned error: %v", err)
		}
	case <-time.After(5 * time.Second):
		// Best-effort cleanup so we don't leak a child + Job Object
		// when the test is reporting the regression.
		_ = p.terminateJob(1)
		t.Fatal("Process.Start deadlocked while attaching Job Object")
	}

	if pid := p.PID(); pid <= 0 {
		t.Fatalf("post-Start PID = %d, want > 0", pid)
	}

	// Cleanup: terminate the Job Object so the child + its tree exit.
	if err := p.terminateJob(0); err != nil {
		t.Logf("cleanup terminateJob: %v", err)
	}
}
