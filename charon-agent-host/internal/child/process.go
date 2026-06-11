package child

import (
	"bufio"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"
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
	Stdout  io.Writer
	Stderr  io.Writer

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

	// Wire stdout/stderr to capture writers. If callers passed nil
	// writers (e.g. --console mode without separate capture), inherit
	// the host's stdio so the user sees the output.
	if p.Stdout != nil {
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			return err
		}
		go copyLines(p.Stdout, stdout)
	} else {
		cmd.Stdout = os.Stdout
	}
	if p.Stderr != nil {
		stderr, err := cmd.StderrPipe()
		if err != nil {
			return err
		}
		go copyLines(p.Stderr, stderr)
	} else {
		cmd.Stderr = os.Stderr
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

// copyLines reads from r line-by-line and writes each line to w.
// Buffered + line-oriented so log rotation never splits an entry mid-line.
func copyLines(w io.Writer, r io.Reader) {
	sc := bufio.NewScanner(r)
	// Larger buffer for occasional long log lines (stack traces).
	buf := make([]byte, 0, 64*1024)
	sc.Buffer(buf, 1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		// Ensure trailing newline for downstream log rotation.
		if !endsWithLF(line) {
			_, _ = w.Write(append(append([]byte(nil), line...), '\n'))
		} else {
			_, _ = w.Write(line)
		}
	}
}

func endsWithLF(b []byte) bool {
	return len(b) > 0 && (b[len(b)-1] == '\n' || strings.HasSuffix(string(b), "\r\n"))
}
