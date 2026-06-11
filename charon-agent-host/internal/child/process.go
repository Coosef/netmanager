package child

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"sync"
)

// Process is the lifecycle wrapper around exec.Cmd. It owns:
//   - the OS-level child process handle
//   - its stdout/stderr capture writers
//   - the Job Object (Windows only — see job_windows.go)
//
// The exposed API is platform-neutral; OS-specific calls live behind
// build-tagged helpers.
type Process struct {
	Exec    string
	Args    []string
	WorkDir string
	Env     []string
	// Stdout / Stderr — concrete *os.File so the OS handle is inherited
	// directly. An arbitrary io.Writer would force the Go runtime into
	// a goroutine-based pump; we keep the *os.File typing as a small
	// quality-of-implementation choice, not as the root cause of any
	// past incident (see Start doc).
	Stdout *os.File
	Stderr *os.File

	// DebugLog, if non-nil, is called for each major step of Start()
	// and Stop() so a supervisor can correlate child-side hangs with
	// the host's own log timeline. Must NOT receive secret material;
	// the implementation only emits state-machine breadcrumbs.
	DebugLog func(msg string, args ...any)

	mu        sync.Mutex
	cmd       *exec.Cmd
	exitCh    chan ExitInfo
	jobHandle uintptr // populated on Windows via attachToJobLocked (see job_*.go)
}

// debug is a nil-safe wrapper around DebugLog.
func (p *Process) debug(msg string, args ...any) {
	if p.DebugLog != nil {
		p.DebugLog(msg, args...)
	}
}

// ExitInfo carries the outcome of a child run for the monitor loop.
type ExitInfo struct {
	Code int
	Err  error
}

// Start launches the child process and attaches it to a fresh Job
// Object on Windows. ctx cancellation does NOT kill the child — the
// monitor loop owns shutdown and calls Stop() explicitly so it can
// drive the cooperative-then-force sequence.
//
// LOCKING CONTRACT (root cause of the CI StartPending incident):
//
//	Start holds p.mu for its entire body. Anything Start calls into
//	while p.mu is held MUST NOT take p.mu again. sync.Mutex in Go is
//	NOT reentrant — the second Lock blocks forever, the goroutine
//	holding it never gets to call Unlock, and the host wedges with
//	"calling proc.Start" as the last log line and no Running status
//	ever sent to the SCM.
//
//	This is exactly what happened in the integration suite before the
//	fix: attachToJob (now attachToJobLocked) was a public-style helper
//	that took p.mu around `p.jobHandle = uintptr(job)`. Start called
//	it while already holding the same mutex. Deadlock.
//
//	The convention now: any helper that mutates p.cmd / p.exitCh /
//	p.jobHandle and is meant to be called from Start gets a
//	`...Locked` suffix and explicitly documents "caller holds p.mu".
//	Helpers called from outside Start (Stop, CloseJob, terminateJob,
//	ExitChan, PID) take the lock themselves.
func (p *Process) Start(ctx context.Context) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.debug("child.Start: lock acquired")

	if p.cmd != nil && p.cmd.ProcessState == nil {
		return errors.New("child: already running")
	}

	cmd := exec.Command(p.Exec, p.Args...)
	cmd.Dir = p.WorkDir
	cmd.Env = p.Env

	// Stdio wiring. We pass concrete *os.File so the kernel handle is
	// inherited directly and the Go runtime does NOT spin up a pipe
	// pump goroutine. This is a clean-implementation preference, not
	// the root cause of any past incident — the StartPending hang in
	// the integration suite was caused by the mutex deadlock
	// documented above, not by io.Writer-typed sinks.
	if p.Stdout != nil {
		cmd.Stdout = p.Stdout
	}
	if p.Stderr != nil {
		cmd.Stderr = p.Stderr
	}

	// Platform-specific SysProcAttr (see job_windows.go for the
	// Windows variant — currently sets HideWindow + CREATE_NO_WINDOW
	// as a defense-in-depth against session-0 console allocation;
	// again NOT the proven root cause of any past incident).
	applySysProcAttr(cmd)

	p.debug("child.Start: before cmd.Start", "exe", p.Exec, "argc", len(p.Args))
	if err := cmd.Start(); err != nil {
		p.debug("child.Start: cmd.Start failed", "err", err.Error())
		return err
	}
	p.cmd = cmd
	p.exitCh = make(chan ExitInfo, 1)
	p.debug("child.Start: after cmd.Start", "pid", cmd.Process.Pid)

	// Attach to Job Object — Windows only; no-op elsewhere. MUST be
	// the locked variant: we are still holding p.mu and the helper
	// must NOT try to re-acquire it.
	p.debug("child.Start: before attachToJobLocked")
	if err := p.attachToJobLocked(); err != nil {
		// If Job Object attachment fails, we still have a running
		// child but no tree-kill guarantee. Log + continue rather
		// than abort — the host can still shut down cooperatively.
		p.debug("child.Start: attachToJobLocked failed (continuing)", "err", err.Error())
	} else {
		p.debug("child.Start: after attachToJobLocked")
	}

	p.debug("child.Start: before wait goroutine")
	go p.waitAndPublishExit()
	p.debug("child.Start: returning")
	return nil
}

func (p *Process) waitAndPublishExit() {
	err := p.cmd.Wait()
	code := p.cmd.ProcessState.ExitCode()
	p.exitCh <- ExitInfo{Code: code, Err: err}
	close(p.exitCh)
}

// ExitChan returns a channel that fires exactly once with the child's
// exit info. After consumption it is closed.
func (p *Process) ExitChan() <-chan ExitInfo {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.exitCh
}

// PID returns the OS process id, or 0 if not started.
func (p *Process) PID() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.cmd == nil || p.cmd.Process == nil {
		return 0
	}
	return p.cmd.Process.Pid
}
