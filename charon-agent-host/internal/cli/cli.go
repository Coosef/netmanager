// Package cli implements the charon-agent-host command-line surface.
//
// Subcommands:
//
//   install     Register with SCM (idempotent, fails if exists)
//   uninstall   Stop + deregister
//   start       Ask SCM to start
//   stop        Ask SCM to stop
//   status      Print Running / Stopped / ... (exit 0 = Running)
//   version     Print version string
//   run         Service entrypoint (called by SCM dispatcher)
//   run --console  Interactive debug — runs the supervisor in the
//                  current console without SCM. Useful for `go run`
//                  in a VM or during manual debugging.
//
// Every subcommand validates its own flag set; no global flag state.
package cli

import (
	"fmt"
	"io"

	"github.com/Coosef/netmanager/charon-agent-host/internal/version"
)

// Dispatch is the single entry point from main().
//
// args is os.Args[1:] (subcommand + its flags). out and errOut are
// io.Writers so tests can capture; main() passes os.Stdout/os.Stderr.
// Returns an exit code suitable for os.Exit.
func Dispatch(args []string, out, errOut io.Writer) int {
	if len(args) == 0 {
		// SCM dispatcher calls the binary with no args — interpret as `run`.
		return runCmd(nil, out, errOut)
	}

	switch args[0] {
	case "install":
		return installCmd(args[1:], out, errOut)
	case "uninstall":
		return uninstallCmd(args[1:], out, errOut)
	case "start":
		return startCmd(args[1:], out, errOut)
	case "stop":
		return stopCmd(args[1:], out, errOut)
	case "status":
		return statusCmd(args[1:], out, errOut)
	case "version", "--version", "-v":
		fmt.Fprintln(out, version.String())
		return 0
	case "run":
		return runCmd(args[1:], out, errOut)
	case "help", "-h", "--help":
		printUsage(out)
		return 0
	default:
		fmt.Fprintf(errOut, "unknown subcommand: %s\n\n", args[0])
		printUsage(errOut)
		return 2
	}
}

func printUsage(w io.Writer) {
	fmt.Fprint(w, `charon-agent-host - native Windows service host for the NetManager agent

Usage:
  charon-agent-host <subcommand> [flags]

Subcommands:
  install     Register the service with SCM
  uninstall   Stop and remove the service
  start       Start the registered service
  stop        Stop the running service
  status      Print service state (exit 0 if Running)
  run         Service entrypoint (called by SCM; --console for debug)
  version     Print version
  help        Show this message
`)
}

