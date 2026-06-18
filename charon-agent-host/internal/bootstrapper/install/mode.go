// Package install holds the planning-side types: install mode,
// path defaults, and the immutable installation plan. None of the
// types here perform any filesystem mutation -- the bootstrapper
// only PLANS in PR-B; PR-C wires the plan into a real installer.
package install

import "fmt"

// Mode describes whether the bootstrapper fetches artifacts from
// the backend at runtime (online) or unpacks them from a
// self-contained bundle baked into the bootstrapper EXE itself
// (offline).
type Mode string

const (
	ModeOnline  Mode = "online"
	ModeOffline Mode = "offline"
)

// String makes Mode JSON- and log-friendly.
func (m Mode) String() string { return string(m) }

// IsValid reports whether the mode is a supported MVP value.
func (m Mode) IsValid() bool {
	return m == ModeOnline || m == ModeOffline
}

// ParseMode normalises a CLI --mode argument. The lowercase form is
// the canonical one; any other casing is normalised here.
func ParseMode(s string) (Mode, error) {
	switch m := Mode(s); m {
	case ModeOnline, ModeOffline:
		return m, nil
	default:
		return "", fmt.Errorf("unsupported install mode %q (expected online or offline)", s)
	}
}
