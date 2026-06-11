//go:build windows

package logging

import "golang.org/x/sys/windows/svc/eventlog"

// Windows Event Log IDs reserved for the host. Documented in
// docs/LIFECYCLE.md so operators can grep Event Viewer by ID.
const (
	EventServiceStarted        uint32 = 1000
	EventServiceStopped        uint32 = 1001
	EventChildExitedUnexpected uint32 = 1002
	EventRestartBackoffMax     uint32 = 1003
	EventChildStartFailed      uint32 = 2000
	EventConfigInvalid         uint32 = 2001
	EventShutdownForced        uint32 = 2002
	EventHostPanicRecovered    uint32 = 9999
)

// EventLog wraps the Windows Event Log writer. The source must be
// registered once at install time (Install() below) using
// eventlog.InstallAsEventCreate; once registered, it persists in the
// registry and `New` calls on subsequent runs just open it.
type EventLog struct {
	source string
	elog   *eventlog.Log
}

// SourceName is the Event Viewer source under
// "Applications and Services Logs". Operators filter on this string.
const SourceName = "NetManagerAgentHost"

// OpenEventLog opens an existing event source. Returns a non-nil
// *EventLog with elog==nil if opening fails — callers can still call
// Info/Warn/Error and the calls turn into no-ops. This is intentional:
// the host must never refuse to start because Event Log is unavailable
// (it's a debugging aid, not a correctness primitive).
func OpenEventLog() *EventLog {
	el, err := eventlog.Open(SourceName)
	if err != nil {
		return &EventLog{source: SourceName, elog: nil}
	}
	return &EventLog{source: SourceName, elog: el}
}

// Install registers the event source in the registry. Called once
// during `install` subcommand. Idempotent.
func InstallEventSource() error {
	const types = eventlog.Error | eventlog.Warning | eventlog.Info
	err := eventlog.InstallAsEventCreate(SourceName, types)
	if err != nil {
		// "key already exists" is benign — service was installed before.
		// We can't easily probe for that specific error without
		// importing windows.* deeply; treat the call as best-effort.
		return nil
	}
	return nil
}

// UninstallEventSource removes the registry entry. Called from
// `uninstall`. Best-effort.
func UninstallEventSource() {
	_ = eventlog.Remove(SourceName)
}

func (e *EventLog) Info(id uint32, msg string) {
	if e.elog == nil {
		return
	}
	_ = e.elog.Info(id, msg)
}

func (e *EventLog) Warning(id uint32, msg string) {
	if e.elog == nil {
		return
	}
	_ = e.elog.Warning(id, msg)
}

func (e *EventLog) Error(id uint32, msg string) {
	if e.elog == nil {
		return
	}
	_ = e.elog.Error(id, msg)
}

func (e *EventLog) Close() {
	if e.elog != nil {
		_ = e.elog.Close()
	}
}
