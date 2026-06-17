// Package bootstrapper is the umbrella package for the Windows
// agent bootstrapper. Subpackages: platform/, install/, security/,
// runtime/, service/.
package bootstrapper

// Exit codes are part of the bootstrapper's public CLI contract.
// They are referenced by docs/WINDOWS_AGENT_BOOTSTRAPPER_EXIT_CODES.md
// and pinned by Go unit tests. Adding a new exit code is fine;
// reusing or renaming an existing one is a breaking change.
const (
	ExitOK                                 = 0
	ExitInvalidArguments                   = 2
	ExitUnsupportedOperatingSystem         = 3
	ExitUnsupportedArchitecture            = 4
	ExitAdministratorPrivilegesRequired    = 5
	ExitInsufficientDiskSpace              = 6
	ExitPendingRebootBlocked               = 7
	ExitInvalidBackendURL                  = 8
	ExitInvalidInstallPath                 = 9
	ExitManifestArtifactValidationFailure  = 10
	ExitInternalError                      = 20
)
