// Package platform contains the OS / architecture / privilege / disk /
// reboot probes the bootstrapper consults before building an
// installation plan. The cross-platform half lives here in plain Go;
// the Windows half lives in *_windows.go files (build tag
// "windows"); a non-Windows stub (build tag "!windows") keeps the
// package compilable on the CI Linux runner so the bootstrapper can
// be unit-tested without a real Windows host.
//
// Architecture strings mirror the PR-A Python model in
// backend/app/services/agent_installer/architecture.py. The strings
// MUST stay byte-identical across the two layers; the constants
// below are the Go-side source of truth and the
// TestArchitectureStringsMatchPython* tests pin the agreement.
package platform

import (
	"fmt"
	"runtime"
	"strings"
)

// Architecture is the canonical Go GOARCH name for an x86 family
// CPU. ARM, RISC-V, MIPS, PPC64LE, s390x are out of scope for the
// MVP and rejected by the parser.
type Architecture string

const (
	// ArchAmd64 = 64-bit x86. Matches Go's GOARCH=amd64 and the
	// Python `Architecture.AMD64`.
	ArchAmd64 Architecture = "amd64"

	// Arch386 = 32-bit x86. Matches Go's GOARCH=386 and the
	// Python `Architecture.X86_386`.
	Arch386 Architecture = "386"

	// ArchUnknown is the safe default for inputs the parser
	// cannot place. The caller MUST treat this as "abort with an
	// unsupported-architecture error" -- never as "fall through".
	ArchUnknown Architecture = "unknown"
)

// String makes Architecture printable as its raw value (e.g.
// "amd64"). Centralising the conversion keeps log and JSON-output
// formatting consistent across the package.
func (a Architecture) String() string { return string(a) }

// IsSupported reports whether the architecture is one of the two
// MVP scope members. Used by the artifact resolver to fail closed.
func (a Architecture) IsSupported() bool {
	return a == ArchAmd64 || a == Arch386
}

// ParseArchitecture normalises a string token to the canonical
// Architecture, accepting the broad set of common spellings the
// PR-A Python parser also accepts:
//
//	"amd64", "x86_64", "x86-64", "x64"   -> ArchAmd64
//	"386",   "i386",  "i486", "i586",
//	         "i686",  "x86"               -> Arch386
//
// Anything else returns ArchUnknown plus a non-nil error so the
// caller is forced to handle the rejection. ParseArchitecture itself
// never returns ArchAmd64 / Arch386 with a non-nil error.
func ParseArchitecture(s string) (Architecture, error) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "amd64", "x86_64", "x86-64", "x64":
		return ArchAmd64, nil
	case "386", "i386", "i486", "i586", "i686", "x86":
		return Arch386, nil
	default:
		return ArchUnknown, fmt.Errorf("unsupported architecture %q", s)
	}
}

// ArchitectureSnapshot captures what the bootstrapper observed about
// the running environment. `Native` is the OS's native architecture
// (which on a x64 Windows running a 386 bootstrapper is still
// amd64); `Process` is the architecture the bootstrapper itself was
// built for; `WOW64` is true exactly when a 386 process is running
// on a 64-bit OS. The artifact resolver consults the snapshot to
// decide which host/runtime artifact to download; the planning layer
// consults it to surface warnings to the operator.
type ArchitectureSnapshot struct {
	Native  Architecture `json:"native"`
	Process Architecture `json:"process"`
	WOW64   bool         `json:"wow64"`
}

// ProcessArchitecture returns the architecture the running binary
// was compiled for, derived from runtime.GOARCH. The function is
// cross-platform; the *_windows.go file's DetectArchitecture()
// fills in the Native + WOW64 fields.
func ProcessArchitecture() Architecture {
	switch runtime.GOARCH {
	case "amd64":
		return ArchAmd64
	case "386":
		return Arch386
	default:
		// MVP scope is x86 family only; anything else is a misbuild.
		return ArchUnknown
	}
}

// SelectAgentArchitecture is the policy that picks which agent-side
// artifact a given host should receive.
//
// Policy:
//   - 64-bit OS -> always prefer amd64 (default; matches the PR-A
//     support matrix, which lists amd64 as the primary fleet
//     target).
//   - 32-bit OS -> 386 is the only option.
//   - 64-bit OS, 386 bootstrapper, forceArch == Arch386 -> 386
//     (the only way to opt into a 32-bit agent on a 64-bit host;
//     the CLI gate for this is described in
//     `docs/WINDOWS_AGENT_BOOTSTRAPPER.md`).
//
// SelectAgentArchitecture never returns ArchUnknown for inputs in
// the Native domain {ArchAmd64, Arch386}; an unknown Native means
// the OS detection itself failed and the caller MUST abort earlier.
func SelectAgentArchitecture(snap ArchitectureSnapshot, forceArch Architecture) Architecture {
	if forceArch == Arch386 && snap.Native == ArchAmd64 {
		return Arch386
	}
	if snap.Native == Arch386 {
		return Arch386
	}
	return ArchAmd64
}
