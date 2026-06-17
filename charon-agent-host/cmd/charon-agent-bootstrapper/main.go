// Command charon-agent-bootstrapper is the PR-B skeleton bootstrapper.
//
// It does NOT perform any installation in PR-B. It detects the
// running OS / architecture / privilege / disk / pending-reboot
// state, picks the conventional install directories, and emits a
// deterministic JSON or text plan describing what a real install
// WOULD do. Later PRs (PR-C runtime resolver, PR-F offline
// installer, PR-G updater) replace the plan emitter with real
// install logic.
//
// The bootstrapper is built for two Windows architectures:
// charon-agent-bootstrapper-windows-amd64.exe and
// charon-agent-bootstrapper-windows-386.exe. The 386 binary is
// usable on x64 Windows as a WOW64 process; the bootstrapper's
// architecture-aware planner detects the (process, native, WOW64)
// triple and picks the right agent artifact -- the default policy
// always prefers amd64 on a 64-bit OS unless --force-arch=386 is
// supplied.
//
// See docs/WINDOWS_AGENT_BOOTSTRAPPER.md for the full surface and
// docs/WINDOWS_AGENT_BOOTSTRAPPER_EXIT_CODES.md for the exit-code
// contract.
package main

import (
	"os"

	"github.com/Coosef/netmanager/charon-agent-host/internal/bootstrapper"
	"github.com/Coosef/netmanager/charon-agent-host/internal/version"
)

func main() {
	os.Exit(bootstrapper.Run(os.Args[1:], os.Stdout, os.Stderr, version.Version))
}
