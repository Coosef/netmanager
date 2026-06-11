package cli

import (
	"flag"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/Coosef/netmanager/charon-agent-host/internal/logging"
	"github.com/Coosef/netmanager/charon-agent-host/internal/service"
)

// ──────────────────────────────────────────────────────────────────
// install
// ──────────────────────────────────────────────────────────────────

func installCmd(args []string, out, errOut io.Writer) int {
	fs, cfg, childArgs := installFlagSet(errOut)
	if err := fs.Parse(args); err != nil {
		return 2
	}
	cfg.ChildArgs = []string(*childArgs)
	if err := cfg.Validate(); err != nil {
		fmt.Fprintln(errOut, err)
		return 2
	}
	exePath, err := os.Executable()
	if err != nil {
		fmt.Fprintln(errOut, "resolve own exe path:", err)
		return 1
	}
	registryArgs := buildRegistryArgs(*cfg, []string(*childArgs))
	if err := service.Install(exePath, *cfg, registryArgs); err != nil {
		fmt.Fprintln(errOut, "install:", err)
		// Exit 17 = service already exists; other = generic failure.
		// Matches the installer-side handling in PR #77.
		if err == service.ErrServiceExists {
			return 17
		}
		return 1
	}
	fmt.Fprintf(out, "Service %q installed.\n", cfg.ServiceName)
	return 0
}

// ──────────────────────────────────────────────────────────────────
// uninstall
// ──────────────────────────────────────────────────────────────────

func uninstallCmd(args []string, out, errOut io.Writer) int {
	fs := flag.NewFlagSet("uninstall", flag.ContinueOnError)
	fs.SetOutput(errOut)
	serviceName := fs.String("service-name", "NetManagerAgent", "Windows service identifier")
	timeoutSec := fs.Int("delete-timeout-sec", 10, "Seconds to wait for SCM to fully unregister")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	err := service.Uninstall(*serviceName, time.Duration(*timeoutSec)*time.Second)
	if err == service.ErrServiceNotFound {
		fmt.Fprintf(errOut, "Service %q not found.\n", *serviceName)
		return 18
	}
	if err == service.ErrDeletePending {
		fmt.Fprintf(out, "Service %q delete pending — retry install in a moment.\n", *serviceName)
		return 19
	}
	if err != nil {
		fmt.Fprintln(errOut, "uninstall:", err)
		return 1
	}
	fmt.Fprintf(out, "Service %q uninstalled.\n", *serviceName)
	return 0
}

// ──────────────────────────────────────────────────────────────────
// start
// ──────────────────────────────────────────────────────────────────

func startCmd(args []string, out, errOut io.Writer) int {
	fs := flag.NewFlagSet("start", flag.ContinueOnError)
	fs.SetOutput(errOut)
	serviceName := fs.String("service-name", "NetManagerAgent", "Windows service identifier")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if err := service.Start(*serviceName); err != nil {
		if err == service.ErrServiceNotFound {
			return 18
		}
		fmt.Fprintln(errOut, "start:", err)
		return 1
	}
	fmt.Fprintf(out, "Start signal sent to %q.\n", *serviceName)
	return 0
}

// ──────────────────────────────────────────────────────────────────
// stop
// ──────────────────────────────────────────────────────────────────

func stopCmd(args []string, out, errOut io.Writer) int {
	fs := flag.NewFlagSet("stop", flag.ContinueOnError)
	fs.SetOutput(errOut)
	serviceName := fs.String("service-name", "NetManagerAgent", "Windows service identifier")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if err := service.Stop(*serviceName); err != nil {
		if err == service.ErrServiceNotFound {
			return 18
		}
		fmt.Fprintln(errOut, "stop:", err)
		return 1
	}
	fmt.Fprintf(out, "Stop signal sent to %q.\n", *serviceName)
	return 0
}

// ──────────────────────────────────────────────────────────────────
// status — exit 0 if Running, 1 otherwise (matches the installer's
// PowerShell polling loop: `if ($LASTEXITCODE -ne 0) { fail }`).
// ──────────────────────────────────────────────────────────────────

func statusCmd(args []string, out, errOut io.Writer) int {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	fs.SetOutput(errOut)
	serviceName := fs.String("service-name", "NetManagerAgent", "Windows service identifier")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	state, err := service.Status(*serviceName)
	if err != nil {
		if err == service.ErrServiceNotFound {
			fmt.Fprintln(errOut, "not-found")
			return 18
		}
		fmt.Fprintln(errOut, "status:", err)
		return 1
	}
	fmt.Fprintln(out, state)
	if state == "Running" {
		return 0
	}
	return 1
}

// ──────────────────────────────────────────────────────────────────
// run — the SCM dispatcher target. The same binary, invoked with the
// install-time args, picks up the config and either hands off to the
// SCM (default) or runs the supervisor in the current console (with
// --console, for VM debugging).
// ──────────────────────────────────────────────────────────────────

func runCmd(args []string, out, errOut io.Writer) int {
	// `run` accepts the SAME flags as `install` plus --console.
	fs, cfg, childArgs := installFlagSet(errOut)
	console := fs.Bool("console", false, "Run the supervisor in the current console (no SCM)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	cfg.ChildArgs = []string(*childArgs)
	if err := cfg.Validate(); err != nil {
		fmt.Fprintln(errOut, err)
		return 2
	}

	var logDir string
	if !*console {
		logDir = cfg.LogDir
	}
	logger, err := logging.NewServiceLogger(logDir)
	if err != nil {
		fmt.Fprintln(errOut, "logger init:", err)
		return 1
	}
	defer logger.Close()

	evt := logging.OpenEventLog()
	defer evt.Close()

	h := &service.Handler{Cfg: *cfg, Log: logger, Evt: evt}

	if *console {
		return runConsole(h, out, errOut)
	}
	if err := service.RunUnderSCM(cfg.ServiceName, h); err != nil {
		fmt.Fprintln(errOut, "scm run:", err)
		return 1
	}
	return 0
}
