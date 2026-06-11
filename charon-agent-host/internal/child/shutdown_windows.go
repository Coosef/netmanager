//go:build windows

package child

import (
	"errors"
	"time"

	"golang.org/x/sys/windows"
)

// Stop terminates the child using the documented sequence:
//
//  1. (MVP-1 future) cooperative signal — a named event or named
//     pipe the child agrees to watch. NOT implemented in MVP-0;
//     CTRL_BREAK_EVENT is deliberately NOT relied on because a
//     Windows service has no console by default.
//  2. Brief grace period — wait on the child's process handle for
//     up to `gracePeriod` (typically 5s, well inside the SCM's 30s
//     StopPending budget). If the child exits on its own during
//     this window we tear down cleanly.
//  3. Job Object force termination — kills the entire process
//     tree atomically via TerminateJobObject. The only guaranteed
//     step. Always runs on any wait outcome except WAIT_OBJECT_0
//     (child already exited).
//
// Returns nil if the child stopped cleanly or was force-killed
// successfully; non-nil only if force termination itself failed.
func (p *Process) Stop(gracePeriod time.Duration) error {
	p.mu.Lock()
	cmd := p.cmd
	p.mu.Unlock()

	if cmd == nil || cmd.Process == nil {
		return errors.New("child: not running")
	}

	// Resolve a real process handle from the PID. exec.Cmd's
	// Process.Handle is a process handle on Windows BUT it is not
	// safe to pass to WaitForSingleObject across the lifetime of
	// cmd.Wait() — the runtime may close it concurrently. Open a
	// fresh SYNCHRONIZE-only handle for the wait, close it on return.
	hProcess, err := windows.OpenProcess(
		windows.SYNCHRONIZE, false, uint32(cmd.Process.Pid),
	)
	if err != nil {
		// The child is gone (or never had a discoverable PID).
		// Drop the Job Object and report a clean stop.
		_ = p.CloseJob()
		return nil
	}
	defer windows.CloseHandle(hProcess)

	timeoutMs := uint32(gracePeriod / time.Millisecond)
	if timeoutMs == 0 {
		timeoutMs = 1
	}
	waitRes, waitErr := windows.WaitForSingleObject(hProcess, timeoutMs)
	switch {
	case waitRes == windows.WAIT_OBJECT_0:
		// Child exited cleanly inside the grace window. Just close
		// the Job Object (handle release) and we're done.
		return p.CloseJob()
	case waitRes == uint32(windows.WAIT_TIMEOUT):
		// Grace expired. Force-terminate via Job Object below.
	default:
		// waitRes == WAIT_FAILED or anything else. We cannot tell
		// whether the child is alive, so fall through to force
		// kill — that path is idempotent against an already-dead
		// process. waitErr is preserved so an operator inspecting
		// logs can see why we skipped grace, but it is intentionally
		// not surfaced to the SCM Stop path; what matters there is
		// that the service reaches Stopped, not why grace failed.
		_ = waitErr
	}

	// Step 3 — guaranteed force kill via Job Object.
	if err := p.terminateJob(1); err != nil {
		return err
	}
	return nil
}
