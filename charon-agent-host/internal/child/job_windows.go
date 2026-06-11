//go:build windows

package child

import (
	"os/exec"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// createJobObject builds an anonymous Job Object configured to kill
// every process in the tree the moment the host process closes its
// handle. This is the orphan-prevention guarantee in the spec:
//
//	JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE — if the host crashes (panic,
//	external taskkill, BSOD, etc.) the kernel kills every process
//	that was ever assigned to the job, including grandchildren spawned
//	by Python (e.g. paramiko/netmiko SSH subprocesses).
//
// NOTE: there is a documented attachment race window between
// cmd.Start() and AssignProcessToJobObject during which a freshly
// spawned grandchild could escape the job. MVP-0 acknowledges and
// defers that race; see docs/JOB_OBJECT_ATTACHMENT_RACE.md.
func createJobObject() (windows.Handle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, err
	}

	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
		BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{
			LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
		},
	}

	_, err = windows.SetInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	)
	if err != nil {
		windows.CloseHandle(job)
		return 0, err
	}
	return job, nil
}

// attachToJob is called from process.go after cmd.Start to register
// the child in the Job Object. On non-Windows builds this is a no-op
// (see job_stub.go).
func (p *Process) attachToJob() error {
	if p.cmd == nil || p.cmd.Process == nil {
		return nil
	}
	job, err := createJobObject()
	if err != nil {
		return err
	}
	// Resolve the child's process handle from its PID — exec.Cmd
	// already has a handle but it's not directly exposed.
	hProcess, err := windows.OpenProcess(
		windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE,
		false,
		uint32(p.cmd.Process.Pid),
	)
	if err != nil {
		windows.CloseHandle(job)
		return err
	}
	defer windows.CloseHandle(hProcess)

	if err := windows.AssignProcessToJobObject(job, hProcess); err != nil {
		windows.CloseHandle(job)
		return err
	}
	p.mu.Lock()
	p.jobHandle = uintptr(job)
	p.mu.Unlock()
	return nil
}

// CloseJob releases the Job Object handle without terminating its
// members.
//
// Use this in the restart code path AFTER the child has already
// exited on its own — the Job Object's KILL_ON_JOB_CLOSE flag would
// fire if there were any members still alive, but by construction
// they have all exited (the child crashed and its tree died with
// it under normal Windows process semantics). Closing the handle
// merely releases the kernel object so a fresh job can be created
// for the replacement child.
//
// CloseJob is:
//   - **idempotent** — calling it on an already-closed or zero
//     handle is a no-op
//   - **mutex-protected** — concurrent Stop / restart cleanup
//     paths cannot double-close
//   - **distinct from terminateJob** — that one calls
//     TerminateJobObject first, which kills surviving members
func (p *Process) CloseJob() error {
	p.mu.Lock()
	h := p.jobHandle
	p.jobHandle = 0
	p.mu.Unlock()

	if h == 0 {
		return nil
	}
	return windows.CloseHandle(windows.Handle(h))
}

// terminateJob kills every process in the tree by terminating the job.
// Called from shutdown.go after a graceful timeout. Best-effort: if
// the handle is zero (attachment failed earlier) we still try to kill
// the immediate child.
func (p *Process) terminateJob(exitCode uint32) error {
	p.mu.Lock()
	h := p.jobHandle
	p.jobHandle = 0
	cmd := p.cmd
	p.mu.Unlock()

	if h != 0 {
		err := windows.TerminateJobObject(windows.Handle(h), exitCode)
		// Close the handle even if Terminate failed — we still need
		// to release the kernel object.
		windows.CloseHandle(windows.Handle(h))
		return err
	}
	// Fallback when Job Object attachment failed earlier.
	if cmd != nil && cmd.Process != nil {
		return cmd.Process.Kill()
	}
	return nil
}

// applySysProcAttr configures the child process's creation flags.
//
// HiddenWindow + CREATE_NO_WINDOW: a Windows service runs in
// session 0 with no interactive desktop. If we don't tell the
// child not to allocate a console, CreateProcessW spends a long
// time trying to allocate one against a missing desktop — which
// is the StartPending hang the integration tests observed in CI.
//
// We previously also set CREATE_NEW_PROCESS_GROUP for a future
// cooperative CTRL_BREAK_EVENT path; it is removed for MVP-0
// because it is not needed yet and adds another knob that can
// surprise the dispatcher.
//
// CREATE_SUSPENDED is intentionally NOT set: see
// docs/JOB_OBJECT_ATTACHMENT_RACE.md for why the obvious
// "suspend / attach / resume" fix is wrong with os/exec's API.
func applySysProcAttr(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags |= windows.CREATE_NO_WINDOW
}
