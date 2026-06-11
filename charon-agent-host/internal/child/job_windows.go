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
//   JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE — if the host crashes (panic,
//   external taskkill, BSOD, etc.) the kernel kills every process
//   that was ever assigned to the job, including grandchildren spawned
//   by Python (e.g. paramiko/netmiko SSH subprocesses).
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
	p.jobHandle = uintptr(job)
	return nil
}

// terminateJob kills every process in the tree by terminating the job.
// Called from shutdown.go after a graceful timeout. Best-effort: if
// the handle is zero (attachment failed earlier) we still try to kill
// the immediate child.
func (p *Process) terminateJob(exitCode uint32) error {
	if p.jobHandle != 0 {
		err := windows.TerminateJobObject(windows.Handle(p.jobHandle), exitCode)
		windows.CloseHandle(windows.Handle(p.jobHandle))
		p.jobHandle = 0
		return err
	}
	// Fallback when Job Object attachment failed earlier.
	if p.cmd != nil && p.cmd.Process != nil {
		return p.cmd.Process.Kill()
	}
	return nil
}

// applySysProcAttr configures the child process's creation flags.
//
// CREATE_NEW_PROCESS_GROUP creates an isolated console process group
// so the host can target the child without affecting itself when (in
// future) we deliver a CTRL_BREAK_EVENT. CTRL_BREAK is NOT used as
// the only shutdown signal — see shutdown_windows.go for the actual
// sequence — but isolating the group still makes the cooperative
// attempt safer.
func applySysProcAttr(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.CreationFlags |= windows.CREATE_NEW_PROCESS_GROUP
}
