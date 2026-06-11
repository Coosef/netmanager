//go:build windows

package service

import (
	"errors"
	"fmt"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"

	"github.com/Coosef/netmanager/charon-agent-host/internal/config"
	"github.com/Coosef/netmanager/charon-agent-host/internal/logging"
)

// Install registers the service with the SCM. The ImagePath is the
// current executable plus the same flags the operator passed to
// `install` — on every subsequent `run` the SCM replays them so the
// host's configuration travels with the service registration.
//
// Idempotent: if the service already exists, returns ErrServiceExists
// so the caller can decide whether to upgrade or delete-then-recreate.
func Install(exePath string, cfg config.Config, args []string) error {
	if err := cfg.Validate(); err != nil {
		return err
	}

	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("scm connect: %w", err)
	}
	defer m.Disconnect()

	// Existence probe.
	s, err := m.OpenService(cfg.ServiceName)
	if err == nil {
		s.Close()
		return ErrServiceExists
	}

	startType := uint32(mgr.StartAutomatic)
	s, err = m.CreateService(
		cfg.ServiceName,
		exePath,
		mgr.Config{
			DisplayName:      cfg.DisplayName,
			Description:      cfg.Description,
			StartType:        startType,
			ServiceStartName: "", // empty == LocalSystem (MVP-0 only)
			ServiceType:      windows.SERVICE_WIN32_OWN_PROCESS,
		},
		args...,
	)
	if err != nil {
		return fmt.Errorf("create service: %w", err)
	}
	defer s.Close()

	// Recovery actions — SCM-side host crash recovery. Child crash
	// recovery is handled inside Execute (see handler_windows.go).
	recovery := []mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 10 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 30 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 60 * time.Second},
	}
	if err := s.SetRecoveryActions(recovery, 60); err != nil {
		// Non-fatal — the service is installed, recovery just won't
		// auto-restart. Log via caller.
		_ = err
	}

	// Register the Event Log source (best-effort, idempotent).
	_ = logging.InstallEventSource()

	return nil
}

// Uninstall stops (best-effort) and deletes the service. After a
// successful delete it waits up to deleteTimeout for SCM to actually
// remove the registration — sc.exe delete is async and a subsequent
// install can race.
func Uninstall(serviceName string, deleteTimeout time.Duration) error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("scm connect: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(serviceName)
	if err != nil {
		return ErrServiceNotFound
	}
	defer s.Close()

	// Best-effort stop. Service may already be stopped.
	st, _ := s.Query()
	if st.State != svc.Stopped {
		_, _ = s.Control(svc.Stop)
		// Wait briefly for stop.
		deadline := time.Now().Add(15 * time.Second)
		for time.Now().Before(deadline) {
			st, _ = s.Query()
			if st.State == svc.Stopped {
				break
			}
			time.Sleep(250 * time.Millisecond)
		}
	}

	if err := s.Delete(); err != nil {
		return fmt.Errorf("delete service: %w", err)
	}
	logging.UninstallEventSource()

	// SCM finishes the delete asynchronously. Poll until the next
	// OpenService fails — at that point a fresh install is safe.
	if deleteTimeout <= 0 {
		deleteTimeout = 10 * time.Second
	}
	deadline := time.Now().Add(deleteTimeout)
	for time.Now().Before(deadline) {
		probe, err := m.OpenService(serviceName)
		if err != nil {
			return nil // delete completed
		}
		probe.Close()
		time.Sleep(250 * time.Millisecond)
	}
	// Soft warning — installed succeeded but SCM hasn't fully reaped
	// the registration yet. Caller can retry install.
	return ErrDeletePending
}

// Start asks SCM to start the service. Does NOT wait for Running;
// callers poll Status with their own timeout (the PowerShell installer
// uses 10s and 30s).
func Start(serviceName string) error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()

	s, err := m.OpenService(serviceName)
	if err != nil {
		return ErrServiceNotFound
	}
	defer s.Close()
	return s.Start()
}

// Stop asks SCM to stop the service. Best-effort; returns immediately.
func Stop(serviceName string) error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()

	s, err := m.OpenService(serviceName)
	if err != nil {
		return ErrServiceNotFound
	}
	defer s.Close()
	_, err = s.Control(svc.Stop)
	return err
}

// Status returns the current SCM state as a human-readable string
// (matches services.msc terminology). Used by both the `status`
// subcommand and the installer's Running-check loop.
func Status(serviceName string) (string, error) {
	m, err := mgr.Connect()
	if err != nil {
		return "", err
	}
	defer m.Disconnect()

	s, err := m.OpenService(serviceName)
	if err != nil {
		return "", ErrServiceNotFound
	}
	defer s.Close()

	st, err := s.Query()
	if err != nil {
		return "", err
	}
	return stateString(st.State), nil
}

func stateString(s svc.State) string {
	switch s {
	case svc.Stopped:
		return "Stopped"
	case svc.StartPending:
		return "StartPending"
	case svc.StopPending:
		return "StopPending"
	case svc.Running:
		return "Running"
	case svc.ContinuePending:
		return "ContinuePending"
	case svc.PausePending:
		return "PausePending"
	case svc.Paused:
		return "Paused"
	default:
		return "Unknown"
	}
}

// RunUnderSCM hands control to the SCM dispatcher. Called from `run`
// (without --console). Blocks until the service is stopped.
func RunUnderSCM(serviceName string, h *Handler) error {
	return svc.Run(serviceName, h)
}

// Sentinel errors for callers (CLI layer) to translate to exit codes.
var (
	ErrServiceExists   = errors.New("service: already exists")
	ErrServiceNotFound = errors.New("service: not found")
	ErrDeletePending   = errors.New("service: deleted but SCM unregistration still pending")
)
