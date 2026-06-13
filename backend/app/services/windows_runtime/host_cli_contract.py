"""Projection of the Go host CLI contract — Section C.7 of the architecture plan.

Schema v2. The data here MUST match the live Go source at the pinned
commit (see `host_cli_pin.py`); the integration test
`test_host_cli_contract_pin.py` re-derives every literal from the
actual `subcommands.go` / `flags.go` / `config.go` / `manager_windows.go`
content and fails on drift.

Consumers:
  - PR #3 installer generator: emits PowerShell that pattern-matches
    these stdout / stderr literals byte-exactly.
  - PR #4 CI's stub-host fixture: emits the same literals so the
    installer tests get the same behavior in CI as in production.
"""
from __future__ import annotations

from dataclasses import dataclass, field

# --------------------------------------------------------------------- #
# Subcommand exit codes + stdout/stderr (Section C.7.1).
# --------------------------------------------------------------------- #


@dataclass(frozen=True)
class SubcommandSpec:
    """Frozen description of one Go host CLI subcommand."""

    name: str
    source_function: str
    source_file: str
    success_codes: tuple[int, ...]
    benign_codes: tuple[int, ...]
    error_codes: tuple[int, ...]
    # Map exit-code → byte-exact stdout literal (None ⇒ no stdout text).
    stdout_by_code: dict[int, str | None]
    # Map exit-code → byte-exact stderr literal OR a printf template
    # marker that resolves at runtime. None ⇒ no stderr text. The
    # `{...}` placeholders correspond to the Go `Fprintln`/`Fprintf`
    # arguments and are captured by the projection-verification test.
    stderr_by_code: dict[int, str | None]
    # Supported flag names. `--service-name` is universal; some
    # subcommands also accept timeouts.
    flags: tuple[str, ...]


INSTALL = SubcommandSpec(
    name="install",
    source_function="installCmd",
    source_file="charon-agent-host/internal/cli/subcommands.go",
    success_codes=(0,),
    benign_codes=(17,),  # ErrServiceExists
    error_codes=(1, 2),
    stdout_by_code={
        0: 'Service "NetManagerAgent" installed.\n',
        17: None,
        1: None,
        2: None,
    },
    stderr_by_code={
        0: None,
        # Format strings — the live Go code calls fmt.Fprintln(errOut,
        # "install:", err) which produces "install: <err>\n".
        17: "install: service: already exists\n",
        1: "install: {err}\n",
        2: "config: {field} is required\n",
    },
    flags=("--service-name",),
)


UNINSTALL = SubcommandSpec(
    name="uninstall",
    source_function="uninstallCmd",
    source_file="charon-agent-host/internal/cli/subcommands.go",
    success_codes=(0,),
    benign_codes=(18, 19),  # ErrServiceNotFound, ErrDeletePending
    error_codes=(1, 2),
    stdout_by_code={
        0: 'Service "NetManagerAgent" uninstalled.\n',
        # Note: exit 19 emits to STDOUT, not stderr, per source.
        19: 'Service "NetManagerAgent" delete pending — retry install in a moment.\n',
        18: None,
        1: None,
        2: None,
    },
    stderr_by_code={
        0: None,
        19: None,
        18: 'Service "NetManagerAgent" not found.\n',
        1: "uninstall: {err}\n",
        2: None,
    },
    flags=("--service-name", "--delete-timeout-sec"),
)


START = SubcommandSpec(
    name="start",
    source_function="startCmd",
    source_file="charon-agent-host/internal/cli/subcommands.go",
    success_codes=(0,),
    benign_codes=(),
    error_codes=(1, 2, 18),
    stdout_by_code={
        0: 'Start signal sent to "NetManagerAgent".\n',
        18: None,
        1: None,
        2: None,
    },
    stderr_by_code={
        0: None,
        # exit 18 = ErrServiceNotFound; silent (no Fprintln in source).
        18: None,
        1: "start: {err}\n",
        2: None,
    },
    flags=("--service-name",),
)


STOP = SubcommandSpec(
    name="stop",
    source_function="stopCmd",
    source_file="charon-agent-host/internal/cli/subcommands.go",
    success_codes=(0,),
    # NOTE: stop on an already-Stopped service returns exit 1 (generic),
    # NOT a benign code (correction #60). The installer must skip stop
    # for InitialServiceState=Stopped.
    benign_codes=(),
    error_codes=(1, 2, 18),
    stdout_by_code={
        0: 'Stop signal sent to "NetManagerAgent".\n',
        18: None,
        1: None,
        2: None,
    },
    stderr_by_code={
        0: None,
        18: None,
        1: "stop: {err}\n",
        2: None,
    },
    flags=("--service-name",),
)


# Status states emitted by `stateString()` in manager_windows.go.
STATUS_STATE_STRINGS: tuple[str, ...] = (
    "Stopped",
    "StartPending",
    "StopPending",
    "Running",
    "ContinuePending",
    "PausePending",
    "Paused",
    "Unknown",
)


STATUS = SubcommandSpec(
    name="status",
    source_function="statusCmd",
    source_file="charon-agent-host/internal/cli/subcommands.go",
    success_codes=(0,),
    benign_codes=(),
    error_codes=(1, 2, 18),
    stdout_by_code={
        # exit 0 ONLY when state is Running.
        0: "Running\n",
        # exit 1: ANY other known state. The actual stdout is one of
        # the strings in STATUS_STATE_STRINGS \ {Running}. Test
        # parametrizes across the set.
        1: "<state-line>\n",
        18: None,
        2: None,
    },
    stderr_by_code={
        0: None,
        # exit 18 writes "not-found\n" to stderr (NOT stdout).
        18: "not-found\n",
        # exit 1 from a non-state error path writes "status: <err>\n";
        # but a state-driven exit 1 has NO stderr. The installer
        # tolerates both.
        1: None,
        2: None,
    },
    flags=("--service-name",),
)


SUBCOMMANDS: dict[str, SubcommandSpec] = {
    s.name: s
    for s in (INSTALL, UNINSTALL, START, STOP, STATUS)
}


# --------------------------------------------------------------------- #
# Install flag set + Validate() (Section C.7.2).
# --------------------------------------------------------------------- #


@dataclass(frozen=True)
class InstallFlag:
    name: str
    default: str
    required: bool
    must_be_absolute_path: bool = False
    enforced_by_validate: bool = False


INSTALL_FLAGS: tuple[InstallFlag, ...] = (
    InstallFlag(
        name="--service-name",
        default="NetManagerAgent",
        required=True,
        enforced_by_validate=True,
    ),
    InstallFlag(
        name="--display-name",
        default="NetManager Proxy Agent",
        required=True,
        enforced_by_validate=True,
    ),
    InstallFlag(
        name="--description",
        default=(
            "Charon agent host - manages the NetManager proxy agent "
            "child process."
        ),
        required=False,
        enforced_by_validate=False,
    ),
    InstallFlag(
        name="--child-exe",
        default="",
        required=True,
        must_be_absolute_path=True,
        enforced_by_validate=True,
    ),
    InstallFlag(
        name="--child-arg",
        default="",  # repeatable; no useful default
        required=False,
        enforced_by_validate=False,
    ),
    InstallFlag(
        name="--work-dir",
        default="",
        required=True,
        must_be_absolute_path=True,
        enforced_by_validate=True,
    ),
    InstallFlag(
        name="--env-file",
        default="",
        required=False,
        enforced_by_validate=False,
    ),
    InstallFlag(
        name="--log-dir",
        default="",
        required=True,
        must_be_absolute_path=True,
        enforced_by_validate=True,
    ),
    InstallFlag(
        name="--service-account",
        default="LocalSystem",
        required=True,
        enforced_by_validate=True,
    ),
)


# Service-name characters that `config.Validate()` rejects.
SERVICE_NAME_FORBIDDEN_CHARS: str = " \t\r\n\"'/\\"


# --------------------------------------------------------------------- #
# Canonical install argv builder (Section C.7.4).
# --------------------------------------------------------------------- #


@dataclass(frozen=True)
class CanonicalInstallArgs:
    """Resolved canonical argv for the Stage 10 install call."""

    host_exe: str
    private_python: str
    entrypoint: str
    app_dir: str
    config_path: str
    log_dir: str

    def to_argv(self) -> list[str]:
        """The argv (after the executable) passed to `& $HostExe ...`."""
        return [
            "install",
            "--service-name", "NetManagerAgent",
            "--display-name", "NetManager Proxy Agent",
            "--description",
            "Charon agent host - manages the NetManager proxy agent child process.",
            "--child-exe", self.private_python,
            "--child-arg", "-E",
            "--child-arg", "-I",
            "--child-arg", self.entrypoint,
            "--work-dir", self.app_dir,
            "--env-file", self.config_path,
            "--log-dir", self.log_dir,
            "--service-account", "LocalSystem",
        ]


# --------------------------------------------------------------------- #
# Canonical SCM ImagePath argv builder (Section C.7.3).
# --------------------------------------------------------------------- #


def canonical_image_path_argv(args: CanonicalInstallArgs) -> list[str]:
    """The argv stored in the SCM service registration's ImagePath.

    Per `buildRegistryArgs()` in `flags.go`: starts with `run` (not
    `install`), emits the flag pairs in the documented order, and
    appends repeated `--child-arg` pairs LAST.
    """
    return [
        "run",
        "--service-name", "NetManagerAgent",
        "--display-name", "NetManager Proxy Agent",
        "--description",
        "Charon agent host - manages the NetManager proxy agent child process.",
        "--child-exe", args.private_python,
        "--work-dir", args.app_dir,
        "--env-file", args.config_path,
        "--log-dir", args.log_dir,
        "--service-account", "LocalSystem",
        "--child-arg", "-E",
        "--child-arg", "-I",
        "--child-arg", args.entrypoint,
    ]
