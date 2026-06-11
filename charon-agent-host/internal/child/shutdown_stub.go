//go:build !windows

package child

import (
	"errors"
	"time"
)

// Stop on non-Windows: just kill the child. Cross-platform stub so the
// package compiles for unit tests.
func (p *Process) Stop(gracePeriod time.Duration) error {
	if p.cmd == nil || p.cmd.Process == nil {
		return errors.New("child: not running")
	}
	_ = gracePeriod
	return p.cmd.Process.Kill()
}
