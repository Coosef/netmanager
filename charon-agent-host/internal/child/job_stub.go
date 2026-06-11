//go:build !windows

package child

import "os/exec"

// Non-Windows stubs so the host compiles on Linux/macOS dev machines
// and hermetic CI. These code paths are NEVER reached on the production
// target.

func (p *Process) attachToJob() error      { return nil }
func (p *Process) terminateJob(uint32) error {
	if p.cmd != nil && p.cmd.Process != nil {
		return p.cmd.Process.Kill()
	}
	return nil
}

func applySysProcAttr(cmd *exec.Cmd) {}
