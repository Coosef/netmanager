// Package config defines the host's runtime configuration schema and
// loader.
//
// The host is configured exclusively via command-line flags at install
// time; those flags are persisted into the Windows service's ImagePath
// (the binary plus arguments stored in the service registration). On
// subsequent `run` invocations the SCM passes those same arguments back
// to the binary, so the host re-reads its configuration from os.Args
// rather than a separate config file. This keeps the surface area
// small and avoids a separate "install-time config drift" failure mode.
package config

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
)

// Config is the resolved host configuration used by `install` and `run`.
//
// Validation rules are encoded on Validate() and run on both install
// (so we fail before touching the SCM) and on every `run` invocation
// (defense-in-depth: if a malformed ImagePath ever lands in the
// registry, we crash early with a clear error instead of starting a
// half-broken service).
type Config struct {
	// ServiceName is the Windows service identifier (no spaces, ASCII).
	// MVP-0 default: "NetManagerAgent" (backward-compat with the v1
	// Python installer's service name; rename to "CharonAgent" is a
	// separate migration package and deliberately out of scope here).
	ServiceName string

	// DisplayName is the human-readable service name shown in services.msc.
	DisplayName string

	// Description is the long-form description shown in services.msc.
	Description string

	// ChildExe is the absolute path to the executable the host launches
	// as its managed child process. In MVP-0 this is the system Python
	// interpreter; in MVP-2 it will be a Go-native worker the host
	// launches in-process and this field disappears.
	ChildExe string

	// ChildArgs are the arguments passed to ChildExe. In MVP-0 this is
	// typically [scriptPath], where scriptPath is the run_agent.py
	// wrapper produced by the PowerShell installer.
	ChildArgs []string

	// WorkDir is the working directory for the child process AND the
	// install-time anchor for ProgramData files. ACL hardening is
	// applied to this directory by the PowerShell installer (PR #75),
	// not by the host itself.
	WorkDir string

	// EnvFile is the path to the agent's environment file (KEY=value
	// lines, UTF-8, BOM optional). The host loads the file into its
	// own env table and passes it through to the child. Defensively
	// strips a single leading BOM from the first key if present.
	EnvFile string

	// LogDir is the directory where service-host.log + agent.stdout.log
	// + agent.stderr.log are written. Must exist (installer creates it).
	LogDir string

	// ServiceAccount is the Windows service identity. MVP-0 only
	// accepts "LocalSystem"; future MVP-1 will expand this to
	// "NetworkService" / "LocalService" after the agent's privilege
	// footprint is profiled.
	ServiceAccount string
}

// Default returns a Config populated with MVP-0 defaults. Callers
// override fields from CLI flags before calling Validate().
func Default() Config {
	return Config{
		ServiceName:    "NetManagerAgent",
		DisplayName:    "NetManager Proxy Agent",
		Description:    "Charon agent host - manages the NetManager proxy agent child process.",
		ServiceAccount: "LocalSystem",
	}
}

// Validate returns an error describing the first reason the
// configuration is unfit for either an install or a service run.
//
// Validation is intentionally strict — the host runs as LocalSystem
// and an empty or attacker-influenced field could be a privilege
// escalation primitive.
func (c Config) Validate() error {
	if c.ServiceName == "" {
		return errors.New("config: service-name is required")
	}
	if strings.ContainsAny(c.ServiceName, " \t\r\n\"'/\\") {
		return fmt.Errorf("config: service-name %q contains forbidden characters", c.ServiceName)
	}
	if c.DisplayName == "" {
		return errors.New("config: display-name is required")
	}
	if c.ChildExe == "" {
		return errors.New("config: child-exe is required")
	}
	if !filepath.IsAbs(c.ChildExe) {
		return fmt.Errorf("config: child-exe %q must be an absolute path", c.ChildExe)
	}
	if c.WorkDir == "" {
		return errors.New("config: work-dir is required")
	}
	if !filepath.IsAbs(c.WorkDir) {
		return fmt.Errorf("config: work-dir %q must be an absolute path", c.WorkDir)
	}
	if c.LogDir == "" {
		return errors.New("config: log-dir is required")
	}
	if !filepath.IsAbs(c.LogDir) {
		return fmt.Errorf("config: log-dir %q must be an absolute path", c.LogDir)
	}
	if c.ServiceAccount != "LocalSystem" {
		// Tighter least-privilege identities (LocalService, NetworkService)
		// are deferred to MVP-1 — see docs/SERVICE_IDENTITY.md for the
		// rationale and the privilege profile that needs to be confirmed
		// before relaxing this check.
		return fmt.Errorf("config: service-account %q not supported in MVP-0 (only LocalSystem)", c.ServiceAccount)
	}
	return nil
}
