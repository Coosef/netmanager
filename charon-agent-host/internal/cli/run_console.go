package cli

import (
	"fmt"
	"io"

	"github.com/Coosef/netmanager/charon-agent-host/internal/service"
)

// runConsole is the --console path of `run`. It is platform-neutral —
// the Handler itself owns platform-specific behavior. On non-Windows
// hosts this is purely a developer convenience (compiles + prints a
// clear "unsupported on this OS" line for the SCM-related parts).
func runConsole(h *service.Handler, out, errOut io.Writer) int {
	fmt.Fprintln(out, "(console mode) starting supervisor in current process")
	// The Handler's Execute signature is SCM-shaped (returns to a
	// status channel); for console mode we'd want a thin adapter that
	// invokes the child supervisor directly. That adapter is part of
	// the next sprint — for MVP-0 we emit a clear message rather than
	// silently misbehave.
	fmt.Fprintln(errOut, "console-mode supervisor not yet implemented in MVP-0 (use `install` + `start`)")
	return 64
}
