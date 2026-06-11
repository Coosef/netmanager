//go:build !windows

package logging

// Non-Windows stubs so the rest of the codebase can compile against
// the EventLog API on any platform (used for hermetic CI / Go vet).
// These are NEVER reached on the production target (Windows).

const SourceName = "NetManagerAgentHost"

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

type EventLog struct{}

func OpenEventLog() *EventLog        { return &EventLog{} }
func InstallEventSource() error      { return nil }
func UninstallEventSource()          {}
func (e *EventLog) Info(id uint32, msg string)    {}
func (e *EventLog) Warning(id uint32, msg string) {}
func (e *EventLog) Error(id uint32, msg string)   {}
func (e *EventLog) Close()                        {}
