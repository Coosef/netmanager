package bootstrapper

import (
	"fmt"
	"io"
	"strings"

	"github.com/Coosef/netmanager/charon-agent-host/internal/bootstrapper/install"
	"github.com/Coosef/netmanager/charon-agent-host/internal/bootstrapper/platform"
	"github.com/Coosef/netmanager/charon-agent-host/internal/bootstrapper/runtime"
)

// Probes is the dependency-injection seam between the bootstrapper
// orchestration (Run) and the real platform syscalls. Tests pass
// in a fake that returns canned results so the planner can run on
// the Linux CI runner.
type Probes struct {
	DetectArchitecture func() (platform.ArchitectureSnapshot, error)
	DetectOSVersion    func() (platform.OSVersion, error)
	DetectPrivilege    func() (platform.Privilege, error)
	DetectReboot       func() (platform.RebootStatus, error)
	DetectDiskInstall  func(path string, minRequired uint64) (platform.DiskInfo, error)
	DetectDiskData     func(path string, minRequired uint64) (platform.DiskInfo, error)
	Resolver           runtime.PlanResolver
	BootstrapperVer    string
}

// DefaultProbes returns the production set of probes that use the
// real Windows syscalls (build tag windows). On non-Windows
// builds the syscalls return an error and the caller is expected
// to inject a fake. Tests that exercise the planner against the
// real probe interface ALWAYS inject a fake to keep the suite
// hermetic.
func DefaultProbes(version string) Probes {
	return Probes{
		DetectArchitecture: platform.DetectArchitecture,
		DetectOSVersion:    platform.DetectOSVersion,
		DetectPrivilege:    platform.DetectPrivilege,
		DetectReboot:       platform.DetectReboot,
		DetectDiskInstall:  platform.DetectDisk,
		DetectDiskData:     platform.DetectDisk,
		Resolver:           runtime.StaticResolver{},
		BootstrapperVer:    version,
	}
}

// BuildPlan assembles an immutable InstallationPlan from the
// (options, probes) pair. No filesystem mutation, no network
// call, no service registration; the bootstrapper's PR-B
// contract is "plan-only".
func BuildPlan(opts *Options, p Probes) (install.InstallationPlan, int) {
	plan := install.InstallationPlan{
		SchemaVersion:       install.PlanSchemaVersion,
		BootstrapperVersion: p.BootstrapperVer,
		RequestedMode:       opts.Mode,
		BackendURL:          opts.BackendURL,
		DryRun:              opts.DryRun,
		NonInteractive:      opts.NonInteractive,
		Blockers:            []string{},
		Warnings:            []string{},
	}

	archSnap, err := p.DetectArchitecture()
	if err != nil {
		plan.Blockers = append(plan.Blockers, fmt.Sprintf("architecture detection failed: %s", err))
		return plan, ExitInternalError
	}
	plan.ProcessArchitecture = archSnap.Process
	plan.NativeArchitecture = archSnap.Native
	plan.WOW64 = archSnap.WOW64

	if !archSnap.Native.IsSupported() {
		plan.Blockers = append(plan.Blockers, fmt.Sprintf("unsupported native architecture %q", archSnap.Native))
		return plan, ExitUnsupportedArchitecture
	}

	plan.SelectedAgentArchitecture = platform.SelectAgentArchitecture(archSnap, opts.ForceArch)
	plan.Platform = fmt.Sprintf("windows-%s", plan.SelectedAgentArchitecture)

	osVersion, err := p.DetectOSVersion()
	if err != nil {
		plan.Blockers = append(plan.Blockers, fmt.Sprintf("OS version detection failed: %s", err))
		return plan, ExitUnsupportedOperatingSystem
	}
	plan.OSName = osVersion.ProductName
	plan.OSVersion = osVersion.String()
	plan.OSBuild = osVersion.Build
	plan.SupportStatus = platform.ClassifySupport(osVersion, plan.SelectedAgentArchitecture)
	switch plan.SupportStatus {
	case platform.StatusUnsupported:
		plan.Blockers = append(plan.Blockers, fmt.Sprintf("OS %q is UNSUPPORTED", osVersion.String()))
		return plan, ExitUnsupportedOperatingSystem
	case platform.StatusUnknown:
		plan.Blockers = append(plan.Blockers, fmt.Sprintf("OS %q has UNKNOWN support status; aborting fail-closed", osVersion.String()))
		return plan, ExitUnsupportedOperatingSystem
	case platform.StatusTestReady:
		plan.Warnings = append(plan.Warnings, fmt.Sprintf("OS %q is TEST_READY -- not validated end-to-end yet", osVersion.String()))
	case platform.StatusConditional:
		plan.Warnings = append(plan.Warnings, fmt.Sprintf("OS %q is CONDITIONAL -- per-deployment validation required", osVersion.String()))
	}

	priv, err := p.DetectPrivilege()
	if err != nil {
		plan.Blockers = append(plan.Blockers, fmt.Sprintf("privilege detection failed: %s", err))
		return plan, ExitInternalError
	}
	plan.IsAdmin = priv.IsAdmin
	plan.IsLocalSystem = priv.IsLocalSystem
	if !priv.IsAdmin {
		plan.Blockers = append(plan.Blockers, "administrator privileges required (re-run as Administrator)")
		return plan, ExitAdministratorPrivilegesRequired
	}

	defaults, err := install.ResolveDefaultPaths(archSnap, plan.SelectedAgentArchitecture)
	if err != nil {
		plan.Blockers = append(plan.Blockers, err.Error())
		return plan, ExitUnsupportedArchitecture
	}
	plan.InstallDir = defaults.InstallDir
	if opts.InstallDir != "" {
		plan.InstallDir = opts.InstallDir
	}
	plan.DataDir = defaults.DataDir
	if opts.DataDir != "" {
		plan.DataDir = opts.DataDir
	}

	// Disk probes -- run after the directory pair is selected so we
	// can probe the actual volumes.
	if di, err := p.DetectDiskInstall(plan.InstallDir, platform.MinimumInstallBytes); err == nil {
		plan.Disk = append(plan.Disk, di)
		if !di.Sufficient {
			plan.Blockers = append(plan.Blockers, fmt.Sprintf("install volume %q has %d bytes free; needs %d", di.Path, di.FreeBytes, di.MinRequiredBytes))
		}
	} else {
		plan.Warnings = append(plan.Warnings, fmt.Sprintf("install volume probe failed: %s", err))
	}
	if dd, err := p.DetectDiskData(plan.DataDir, platform.MinimumDataBytes); err == nil {
		plan.Disk = append(plan.Disk, dd)
		if !dd.Sufficient {
			plan.Blockers = append(plan.Blockers, fmt.Sprintf("data volume %q has %d bytes free; needs %d", dd.Path, dd.FreeBytes, dd.MinRequiredBytes))
		}
	} else {
		plan.Warnings = append(plan.Warnings, fmt.Sprintf("data volume probe failed: %s", err))
	}

	rb, err := p.DetectReboot()
	if err == nil {
		plan.PendingReboot = rb
		if rb.AnyPending() {
			plan.Warnings = append(plan.Warnings, "pending reboot detected -- install will proceed in MVP policy; PR-C may upgrade this to a blocker")
		}
	} else {
		plan.Warnings = append(plan.Warnings, fmt.Sprintf("pending-reboot probe failed: %s", err))
	}

	plan.RequiredArtifacts = p.Resolver.Resolve(opts.Mode, plan.SelectedAgentArchitecture)

	// Disk blockers map to the dedicated exit code.
	if plan.HasBlockers() {
		for _, b := range plan.Blockers {
			if isDiskBlocker(b) {
				return plan, ExitInsufficientDiskSpace
			}
		}
		return plan, ExitInternalError
	}
	return plan, ExitOK
}

// Run is the high-level entry the cmd binary calls. It parses
// options, builds the plan, and writes the output. The structured
// exit code returned by BuildPlan is propagated verbatim.
func Run(args []string, out, errOut io.Writer, version string) int {
	opts, err := Parse(args, errOut)
	if err != nil {
		fmt.Fprintln(errOut, "argument error:", err)
		return ExitInvalidArguments
	}
	if opts.ShowVersion {
		fmt.Fprintln(out, "charon-agent-bootstrapper", version)
		return ExitOK
	}
	if opts.ShowHelp {
		fmt.Fprintln(out, "Usage: charon-agent-bootstrapper [flags]")
		fmt.Fprintln(out, "See docs/WINDOWS_AGENT_BOOTSTRAPPER.md")
		return ExitOK
	}

	probes := DefaultProbes(version)
	plan, code := BuildPlan(opts, probes)

	if opts.OutputFormat == "json" {
		b, err := plan.Marshal()
		if err != nil {
			fmt.Fprintln(errOut, "plan marshal failed:", err)
			return ExitInternalError
		}
		_, _ = out.Write(b)
	} else {
		fmt.Fprintln(out, "=== Charon Agent Bootstrapper plan (PR-B skeleton; not-for-production) ===")
		fmt.Fprintf(out, "  schema_version             : %d\n", plan.SchemaVersion)
		fmt.Fprintf(out, "  bootstrapper_version       : %s\n", plan.BootstrapperVersion)
		fmt.Fprintf(out, "  requested_mode             : %s\n", plan.RequestedMode)
		fmt.Fprintf(out, "  platform                   : %s\n", plan.Platform)
		fmt.Fprintf(out, "  process_architecture       : %s\n", plan.ProcessArchitecture)
		fmt.Fprintf(out, "  native_architecture        : %s\n", plan.NativeArchitecture)
		fmt.Fprintf(out, "  wow64                      : %t\n", plan.WOW64)
		fmt.Fprintf(out, "  selected_agent_arch        : %s\n", plan.SelectedAgentArchitecture)
		fmt.Fprintf(out, "  os                         : %s\n", plan.OSVersion)
		fmt.Fprintf(out, "  support_status             : %s\n", plan.SupportStatus)
		fmt.Fprintf(out, "  is_admin                   : %t\n", plan.IsAdmin)
		fmt.Fprintf(out, "  install_dir                : %s\n", plan.InstallDir)
		fmt.Fprintf(out, "  data_dir                   : %s\n", plan.DataDir)
		fmt.Fprintf(out, "  dry_run                    : %t\n", plan.DryRun)
		fmt.Fprintf(out, "  required_artifacts         : %d\n", len(plan.RequiredArtifacts))
		if len(plan.Warnings) > 0 {
			fmt.Fprintln(out, "  warnings:")
			for _, w := range plan.Warnings {
				fmt.Fprintf(out, "    - %s\n", w)
			}
		}
		if len(plan.Blockers) > 0 {
			fmt.Fprintln(out, "  blockers:")
			for _, b := range plan.Blockers {
				fmt.Fprintf(out, "    - %s\n", b)
			}
		}
	}
	return code
}

func isDiskBlocker(s string) bool {
	return strings.HasPrefix(s, "install volume ") || strings.HasPrefix(s, "data volume ")
}
