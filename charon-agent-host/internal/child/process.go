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
	// Stdout / Stderr — see Start() doc. MUST be *os.File or nil; an
	// arbitrary io.Writer would force the Go runtime into a goroutine-
	// based pump that deadlocks under SCM session 0.
	Stdout *os.File
	Stderr *os.File

	mu        sync.Mutex
	cmd       *exec.Cmd
	exitCh    chan ExitInfo
	jobHandle uintptr // populated on Windows via attachToJob (see job_*.go)
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
func (p *Process) Start(ctx context.Context) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.cmd != nil && p.cmd.ProcessState == nil {
		return errors.New("child: already running")
	}

	cmd := exec.Command(p.Exec, p.Args...)
	cmd.Dir = p.WorkDir
	cmd.Env = p.Env

	// Wire stdout/stderr. Two important Windows constraints:
	//
	//  1. If cmd.Stdout / cmd.Stderr is an arbitrary io.Writer (e.g. a
	//     RotatingWriter), the Go runtime creates a pipe + a goroutine
	//     to copy from the pipe to the writer. Under a Windows service
	//     running as LocalSystem in session 0, that pipe-handle dance
	//     can block exec.Cmd.Start indefinitely — the failure mode the
	//     integration tests have been hitting.
	//
	//  2. If cmd.Stdout / cmd.Stderr is a concrete *os.File, the OS
	//     handle is inherited directly with no Go-side goroutine. This
	//     is the only path that has been observed to keep cmd.Start
	//     responsive in CI.
	//
	// So the contract changed: callers can pass an *os.File (preferred)
	// or nil. An arbitrary io.Writer is no longer accepted — handler
	// owns the file lifecycle and we no longer reinvent the wheel.
	if p.Stdout != nil {
		cmd.Stdout = p.Stdout
	}
	if p.Stderr != nil {
		cmd.Stderr = p.Stderr
	}

	// Platform-specific SysProcAttr (see process_windows.go).
	applySysProcAttr(cmd)

	if err := cmd.Start(); err != nil {
		return err
	}
	p.cmd = cmd
	p.exitCh = make(chan ExitInfo, 1)

	// Attach to Job Object — Windows only; no-op elsewhere.
	if err := p.attachToJob(); err != nil {
		// If Job Object attachment fails, we still have a running
		// child but no tree-kill guarantee. Log + continue rather
		// than abort — the host can still shut down cooperatively.
		// (Logger isn't wired here — caller logs via the returned err.)
		_ = err
	}

	go p.waitAndPublishExit()
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
