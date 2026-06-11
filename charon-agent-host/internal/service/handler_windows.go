//go:build windows

package service

import (
	"context"
	"fmt"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows/svc"

	"github.com/Coosef/netmanager/charon-agent-host/internal/child"
	"github.com/Coosef/netmanager/charon-agent-host/internal/config"
	"github.com/Coosef/netmanager/charon-agent-host/internal/logging"
)

// Handler implements svc.Handler. SCM dispatches to Execute on service
// start; Execute runs until the service is stopped.
type Handler struct {
	Cfg config.Config
	Log *logging.Logger
	Evt *logging.EventLog
}

const acceptedCmds = svc.AcceptStop | svc.AcceptShutdown

// Execute is the SCM entrypoint. The contract:
//   - Send StartPending IMMEDIATELY (within the SCM's 30s budget),
//     then any further startup work.
//   - Once running, send Running with AcceptedCmds.
//   - On Stop/Shutdown, send StopPending, tear down, then Stopped.
//
// The return values (svcSpecificEC, exitCode) bubble up to SCM as the
// service's exit code.
func (h *Handler) Execute(args []string, r <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	// Tell SCM we're starting RIGHT AWAY so the dispatcher's 30s timer
	// doesn't elapse while we set up Job Object / logging.
	status <- svc.Status{State: svc.StartPending}

	h.Log.Info("service execute begin",
		"service_name", h.Cfg.ServiceName,
		"child_exe", h.Cfg.ChildExe,
	)
	h.Evt.Info(logging.EventServiceStarted, "Service starting: "+h.Cfg.ServiceName)

	// Wire stdout/stderr capture to rotating files.
	stdoutLog := logging.NewRotatingWriter(h.Cfg.LogDir, "agent.stdout", ".log")
	stderrLog := logging.NewRotatingWriter(h.Cfg.LogDir, "agent.stderr", ".log")
	defer stdoutLog.Close()
	defer stderrLog.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	proc := &child.Process{
		Exec:    h.Cfg.ChildExe,
		Args:    h.Cfg.ChildArgs,
		WorkDir: h.Cfg.WorkDir,
		Env:     h.buildEnv(),
		Stdout:  stdoutLog,
		Stderr:  stderrLog,
	}

	startedAt := time.Now()
	if err := proc.Start(ctx); err != nil {
		h.Log.Error("child start failed", "err", err.Error())
		h.Evt.Error(logging.EventChildStartFailed, "Failed to start child: "+err.Error())
		status <- svc.Status{State: svc.Stopped}
		return false, 1
	}
	h.Log.Info("child started", "pid", proc.PID())

	status <- svc.Status{State: svc.Running, Accepts: acceptedCmds}

	policy := child.DefaultRestartPolicy()
	var backoff child.BackoffState

	for {
		select {
		case cr := <-r:
			switch cr.Cmd {
			case svc.Interrogate:
				status <- cr.CurrentStatus
			case svc.Stop, svc.Shutdown:
				h.Log.Info("stop signal received", "cmd", fmt.Sprint(cr.Cmd))
				status <- svc.Status{State: svc.StopPending}
				if err := proc.Stop(5 * time.Second); err != nil {
					h.Log.Warn("child stop returned error (continuing teardown)", "err", err.Error())
					h.Evt.Warning(logging.EventShutdownForced, "Stop returned error: "+err.Error())
				}
				h.Evt.Info(logging.EventServiceStopped, "Service stopped: "+h.Cfg.ServiceName)
				status <- svc.Status{State: svc.Stopped}
				return false, 0
			}

		case exit := <-proc.ExitChan():
			ranFor := time.Since(startedAt)
			h.Log.Warn("child exited",
				"exit_code", exit.Code,
				"ran_for_sec", ranFor.Seconds(),
				"err", errString(exit.Err),
			)
			h.Evt.Warning(
				logging.EventChildExitedUnexpected,
				fmt.Sprintf("Child exited code=%d ran=%.1fs", exit.Code, ranFor.Seconds()),
			)

			// Release the old Job Object handle BEFORE we replace
			// `proc` — without this the kernel object leaks for the
			// rest of the host's lifetime. terminateJob isn't right
			// here: the child has already exited so there is nothing
			// to terminate; we only want to drop the handle.
			if err := proc.CloseJob(); err != nil {
				h.Log.Warn("close job after child exit failed", "err", err.Error())
			}

			delay := backoff.NextDelay(policy, ranFor, nil)
			h.Log.Info("restarting child after backoff",
				"delay_sec", delay.Seconds(),
				"attempt", backoff.Attempt(),
			)

			// Honor service stop during backoff sleep AND a parent
			// context cancellation. Either should suppress the
			// restart.
			select {
			case cr := <-r:
				if cr.Cmd == svc.Stop || cr.Cmd == svc.Shutdown {
					status <- svc.Status{State: svc.Stopped}
					return false, 0
				}
			case <-ctx.Done():
				h.Log.Info("context cancelled during backoff, not restarting")
				status <- svc.Status{State: svc.Stopped}
				return false, 0
			case <-time.After(delay):
			}

			// Re-check context just before starting the replacement.
			// A stop signal could arrive AFTER time.After fires but
			// BEFORE we call proc.Start; skipping the restart in
			// that window keeps the host from leaving an orphan
			// child running after the service has reached Stopped.
			select {
			case <-ctx.Done():
				h.Log.Info("context cancelled after backoff, not restarting")
				status <- svc.Status{State: svc.Stopped}
				return false, 0
			default:
			}

			// Fresh process for restart.
			proc = &child.Process{
				Exec:    h.Cfg.ChildExe,
				Args:    h.Cfg.ChildArgs,
				WorkDir: h.Cfg.WorkDir,
				Env:     h.buildEnv(),
				Stdout:  stdoutLog,
				Stderr:  stderrLog,
			}
			startedAt = time.Now()
			if err := proc.Start(ctx); err != nil {
				h.Log.Error("child restart failed",
					"err", err.Error(),
					"attempt", backoff.Attempt(),
				)
				h.Evt.Error(logging.EventChildStartFailed, "Restart failed: "+err.Error())
				status <- svc.Status{State: svc.Stopped}
				return false, 1
			}
		}
	}
}

// buildEnv merges the system env with the agent's config.env. Defensively
// strips a leading UTF-8 BOM from the first key (the old PowerShell
// installer's Out-File -Encoding UTF8 left one).
func (h *Handler) buildEnv() []string {
	env := config.LoadEnvFile(h.Cfg.EnvFile)
	out := make([]string, 0, len(env))
	for k, v := range env {
		out = append(out, k+"="+v)
	}
	return out
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// ResolveLogDir returns the log directory the host writes to. Exposed
// so the CLI can validate the path exists before handing off to SCM.
func ResolveLogDir(cfg config.Config) string {
	return filepath.Clean(cfg.LogDir)
}
