//go:build windows

package child

import (
	"errors"
	"time"

	"golang.org/x/sys/windows"
)

// Stop terminates the child using the documented sequence:
//
//   1. (MVP-1 future) Try a cooperative signal — a named event or
//      named pipe the child agrees to watch. Not implemented in
//      MVP-0; we deliberately do NOT claim CTRL_BREAK_EVENT is
//      reliable inside a Windows service (no console attached).
//   2. Brief grace period — let the child notice the host has gone
//      away via its own keepalive (the agent's websocket disconnect
//      handler typically winds down cleanly within a few seconds).
//   3. Job Object force termination — kills the entire process tree
//      atomically. This is the only guaranteed step.
//
// gracePeriod is the time between when Stop is called and when the
// Job Object is terminated. Caller (the service handler) typically
// passes 5 * time.Second so we stay well inside the SCM's 30s
// StopPending budget.
func (p *Process) Stop(gracePeriod time.Duration) error {
	if p.cmd == nil || p.cmd.Process == nil {
		return errors.New("child: not running")
	}

	// Step 1 + 2: brief grace. We can't *send* a signal portably and
	// reliably from a service — Console Ctrl events require an
	// attached console which a Windows service does NOT have by
	// default. So this window is effectively a wait-and-see.
	//
	// Future MVP-1: agent listens on a named event
	// (Global\NetManagerAgent-Shutdown) and host SetEvent's it here.
	done := make(chan struct{})
	go func() {
		_, _ = windows.WaitForSingleObject(
			windows.Handle(p.cmd.Process.Pid),
			uint32(gracePeriod/time.Millisecond),
		)
		close(done)
	}()

	select {
	case <-done:
		// May have exited cleanly OR may have timed out — both are
		// fine, the Job Object termination below is idempotent.
	case exit := <-p.ExitChan():
		// Child exited on its own during grace window.
		_ = exit
		// Still tear down the Job Object handle to free resources.
		_ = p.terminateJob(0)
		return nil
	case <-time.After(gracePeriod):
		// Timeout
	}

	// Step 3: force kill via Job Object — the guaranteed step.
	if err := p.terminateJob(1); err != nil {
		return err
	}
	return nil
}
