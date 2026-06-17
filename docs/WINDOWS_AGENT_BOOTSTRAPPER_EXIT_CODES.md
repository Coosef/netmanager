# Windows Agent Bootstrapper -- Exit Code Contract

The bootstrapper exit code is part of its public CLI contract.
Reusing or renaming an existing code is a breaking change. Adding
a new code is fine; pin it via a test in
[`internal/bootstrapper/exitcodes.go`](../charon-agent-host/internal/bootstrapper/exitcodes.go)
and document the new entry here.

| Code | Constant | Meaning | When emitted |
|---|---|---|---|
| 0 | `ExitOK` | Success / plan valid | Plan emitted with no blockers. |
| 2 | `ExitInvalidArguments` | Argument parse failed | Unknown flag, malformed value, forbidden secret-bearing flag on argv, or invalid mode / output format / force-arch. |
| 3 | `ExitUnsupportedOperatingSystem` | OS not in the support matrix | `ClassifySupport` returned `UNSUPPORTED` or `UNKNOWN`, OR the OS-version probe failed. |
| 4 | `ExitUnsupportedArchitecture` | Native architecture unsupported | `runtime.GOARCH` outside the `{amd64, 386}` MVP scope, OR the path resolver rejected the (native, agent) pair (e.g. forced amd64 on a 32-bit OS). |
| 5 | `ExitAdministratorPrivilegesRequired` | Not running elevated | The privilege probe reported `IsAdmin == false`. The bootstrapper does NOT self-elevate in PR-B. |
| 6 | `ExitInsufficientDiskSpace` | One of the volumes failed the minimum-free check | Install or data volume reported free bytes below `MinimumInstallBytes` / `MinimumDataBytes`. |
| 7 | `ExitPendingRebootBlocked` | Pending reboot is policy-blocked | **Not emitted in PR-B.** Pending reboot is a warning in PR-B; PR-C may upgrade it to a blocker when the dependency resolver phases in VC++ runtime installation. Reserved here so the contract stays stable. |
| 8 | `ExitInvalidBackendURL` | Backend URL parse / validation failed | Not currently emitted at the BuildPlan layer (URL is validated at Parse and surfaces as `ExitInvalidArguments`). Reserved for the future PR-C download phase. |
| 9 | `ExitInvalidInstallPath` | Critical install/data path or install/data directory collision | Emitted when the FINAL (defaults-merged-with-overrides) install or data directory matches the critical-path blocklist (drive root, Windows system tree, user profile tree, Program Files / ProgramData bare root, Recycle Bin tree) OR when install + data directories are equal / one is nested inside the other. CLI-side critical paths and explicit collisions are caught at Parse and surface as `ExitInvalidArguments` (code 2); code 9 covers the BuildPlan defence-in-depth re-check on the final resolved pair. |
| 10 | `ExitManifestArtifactValidationFailure` | Manifest or artifact SHA / signature mismatch | Reserved for PR-C. |
| 20 | `ExitInternalError` | Unclassified internal failure | A probe returned an unexpected error, or a plan blocker did not map to any of the specific codes above. |

## Exit-code stability

These codes are surfaced verbatim by:

- the bootstrapper itself (`bootstrapper.Run -> os.Exit`),
- structured logs (the `exit_code` slog field, future PR),
- the operator-facing CLI text summary,
- CI tooling that wraps the bootstrapper in `actions/exec`.

Any consumer (chef cookbook, Ansible play, JEA endpoint, MDM
script) is allowed to switch on these codes. Reusing or renaming
breaks all of them.

## Reserved codes (not yet emitted)

Codes 7 / 8 / 10 are reserved in the constant table so the numbers
don't shift when PR-C / PR-F start emitting them. PR-B emits 0 / 2 /
3 / 4 / 5 / 6 / 9 / 20.

Note that code 9 is emitted by the PR-B security hardening patch
for critical-path and install/data-collision blockers caught at the
BuildPlan defence-in-depth re-check. Most user-side critical-path
mistakes are caught at the CLI Parse layer and surface as
ExitInvalidArguments (code 2); code 9 only fires when the resolved
final pair (defaults merged with overrides) trips the blocklist.
