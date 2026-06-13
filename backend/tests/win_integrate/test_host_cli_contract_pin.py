"""Go host CLI source-projection pin verification (corrections #54 + #64).

These tests open the live Go source files at the pinned commit and
verify the `host_cli_contract.py` projection matches them. The
verification is intentionally string-based (grep + AST-lite); changing
any literal in the Go source without updating the Python projection
fails this gate.

If these tests fail on `main`, the pin SHA in `host_cli_pin.py` is
out-of-date and a maintainer must explicitly update it (after auditing
the new behavior).
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest

from app.services.windows_runtime import host_cli_contract as C
from app.services.windows_runtime.host_cli_pin import (
    HOST_CLI_CONTRACT_COMMIT,
    HOST_CLI_CONTRACT_FILE,
    HOST_CLI_CONTRACT_REPOSITORY,
    HOST_CLI_CONTRACT_SCHEMA_VERSION,
    HOST_CLI_FLAGS_FILE,
    HOST_CLI_MANAGER_FILE,
    HOST_CLI_PIN_FILES,
    HOST_CONFIG_FILE,
)


REPO_ROOT = Path(__file__).resolve().parents[3]


# --------------------------------------------------------------------- #
# Pin sanity.
# --------------------------------------------------------------------- #


def test_pin_commit_is_full_40_char_sha():
    assert re.fullmatch(r"[0-9a-f]{40}", HOST_CLI_CONTRACT_COMMIT), (
        f"HOST_CLI_CONTRACT_COMMIT must be a full 40-char SHA; "
        f"got {HOST_CLI_CONTRACT_COMMIT!r}"
    )


def test_pin_schema_version_is_two():
    assert HOST_CLI_CONTRACT_SCHEMA_VERSION == 2


def test_pin_files_exist_on_disk():
    for relpath in HOST_CLI_PIN_FILES:
        abs_path = REPO_ROOT / relpath
        assert abs_path.is_file(), (
            f"Pinned source file {relpath} does not exist on disk "
            f"(expected at {abs_path}). The pin commit might be ahead "
            f"of the current worktree."
        )


def test_pin_repo_matches_origin():
    """If the working tree is a git checkout of Coosef/netmanager, the
    pin's repo identity matches the remote URL."""
    try:
        url = subprocess.check_output(
            ["git", "config", "--get", "remote.origin.url"],
            cwd=REPO_ROOT,
            text=True,
        ).strip()
    except subprocess.CalledProcessError:
        pytest.skip("not a git checkout")
    assert HOST_CLI_CONTRACT_REPOSITORY in url, (
        f"pin repo {HOST_CLI_CONTRACT_REPOSITORY} not present in remote URL {url}"
    )


def test_pin_commit_is_reachable_from_head():
    """The pinned commit must be an ancestor of the current HEAD; we
    enforce this so that PR branches can't accidentally pin a SHA
    that isn't merged."""
    try:
        rc = subprocess.call(
            [
                "git",
                "merge-base",
                "--is-ancestor",
                HOST_CLI_CONTRACT_COMMIT,
                "HEAD",
            ],
            cwd=REPO_ROOT,
        )
    except FileNotFoundError:
        pytest.skip("git not available")
    assert rc == 0, (
        f"pinned commit {HOST_CLI_CONTRACT_COMMIT} is not reachable "
        f"from HEAD; merge it (or update the pin) before relying on the "
        f"projection."
    )


# --------------------------------------------------------------------- #
# Source-literal verification.
# --------------------------------------------------------------------- #


def _read(path: str) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")


def test_install_success_stdout_literal_matches_source():
    source = _read(HOST_CLI_CONTRACT_FILE)
    expected = C.INSTALL.stdout_by_code[0].rstrip("\n")
    # The Go literal uses `%q` formatting which wraps in escaped quotes.
    # We check for the unquoted body which uniquely identifies the line.
    assert "Service %q installed." in source
    # Cross-check our projection's literal value.
    assert expected == 'Service "NetManagerAgent" installed.'


def test_uninstall_success_stdout_literal_matches_source():
    source = _read(HOST_CLI_CONTRACT_FILE)
    assert "Service %q uninstalled." in source


def test_uninstall_delete_pending_stdout_to_stdout_not_stderr():
    """Correction #45: uninstall exit 19 emits to STDOUT, not stderr."""
    source = _read(HOST_CLI_CONTRACT_FILE)
    # The Go source's exit-19 branch calls Fprintf(out, ...).
    # We use a single-line grep that proves stdout (`out`) is the target.
    assert re.search(
        r"Service\s+%q\s+delete\s+pending.+retry\s+install\s+in\s+a\s+moment\.",
        source,
    ), "delete-pending literal missing from source"
    # And it's emitted to `out`, not `errOut`.
    line = [
        ln for ln in source.splitlines()
        if "delete pending" in ln and "Fprintf" in ln
    ]
    assert line and "out," in line[0] and "errOut" not in line[0]


def test_start_and_stop_success_literals_match_source():
    source = _read(HOST_CLI_CONTRACT_FILE)
    assert 'Start signal sent to %q.' in source
    assert 'Stop signal sent to %q.' in source


def test_status_not_found_emits_to_stderr():
    source = _read(HOST_CLI_CONTRACT_FILE)
    # The not-found path is `fmt.Fprintln(errOut, "not-found")`.
    assert re.search(r'Fprintln\(errOut,\s*"not-found"\)', source)


def test_status_states_match_source_literal_set():
    """Every state in `STATUS_STATE_STRINGS` must appear in
    `manager_windows.go`'s `stateString()` switch."""
    source = _read(HOST_CLI_MANAGER_FILE)
    for state in C.STATUS_STATE_STRINGS:
        assert re.search(
            rf'return\s+"{re.escape(state)}"', source
        ), f"state {state!r} missing from stateString()"


def test_status_exit_codes_match_source():
    source = _read(HOST_CLI_CONTRACT_FILE)
    # `if state == "Running" { return 0 }` immediately followed by
    # `return 1` is the canonical exit shape.
    assert re.search(
        r'if\s+state\s*==\s*"Running"\s*\{\s*return\s+0\s*\}',
        source,
    )


def test_uninstall_exit_19_is_err_delete_pending():
    source = _read(HOST_CLI_CONTRACT_FILE)
    assert "ErrDeletePending" in source and "return 19" in source


def test_uninstall_exit_18_is_err_service_not_found():
    source = _read(HOST_CLI_CONTRACT_FILE)
    assert "ErrServiceNotFound" in source and "return 18" in source


def test_install_exit_17_is_err_service_exists():
    source = _read(HOST_CLI_CONTRACT_FILE)
    assert "ErrServiceExists" in source and "return 17" in source


# --------------------------------------------------------------------- #
# Install flag set + Validate() projection.
# --------------------------------------------------------------------- #


def test_install_flag_names_match_source():
    source = _read(HOST_CLI_FLAGS_FILE)
    declared = re.findall(r'"(service-name|display-name|description|child-exe|child-arg|work-dir|env-file|log-dir|service-account)"', source)
    declared_set = set(declared)
    expected = {flag.name.lstrip("-") for flag in C.INSTALL_FLAGS}
    assert declared_set == expected, (
        f"Install flag set drift: source has {declared_set}, projection has {expected}"
    )


def test_child_arg_is_repeatable_via_stringSliceFlag():
    """`stringSliceFlag` is the repeatable accumulator the source uses."""
    source = _read(HOST_CLI_FLAGS_FILE)
    assert "stringSliceFlag" in source
    # The flag declaration uses `.Var(&childArgs, "child-arg", ...)`.
    assert re.search(r'\.Var\(&childArgs,\s*"child-arg"', source)


def test_validate_required_field_set_matches_source():
    source = _read(HOST_CONFIG_FILE)
    # `config.Validate()` rejects empty ServiceName, DisplayName, ChildExe,
    # WorkDir, LogDir, and non-LocalSystem ServiceAccount.
    for field in ("ServiceName", "DisplayName", "ChildExe", "WorkDir", "LogDir"):
        assert re.search(
            rf'if\s+c\.{re.escape(field)}\s*==\s*""',
            source,
        ), f"Validate() missing required check for {field}"
    assert re.search(
        r'if\s+c\.ServiceAccount\s*!=\s*"LocalSystem"', source
    )


def test_validate_required_set_matches_projection():
    source = _read(HOST_CONFIG_FILE)
    expected_required = {
        flag.name.lstrip("-")
        for flag in C.INSTALL_FLAGS
        if flag.enforced_by_validate
    }
    # Re-derive required field set from Validate() source.
    required_in_source: set[str] = set()
    for field in ("ServiceName", "DisplayName", "ChildExe", "WorkDir", "LogDir", "ServiceAccount"):
        if re.search(rf'if\s+c\.{re.escape(field)}\s*==\s*""', source):
            required_in_source.add(_camel_to_kebab(field))
    # ServiceAccount uses a value comparison, not an emptiness check.
    if re.search(r'if\s+c\.ServiceAccount\s*!=\s*"LocalSystem"', source):
        required_in_source.add("service-account")
    assert required_in_source == expected_required


def _camel_to_kebab(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "-", name).lower()


def test_service_account_default_is_LocalSystem():
    source = _read(HOST_CONFIG_FILE)
    assert re.search(r'ServiceAccount:\s*"LocalSystem"', source)
    for flag in C.INSTALL_FLAGS:
        if flag.name == "--service-account":
            assert flag.default == "LocalSystem"


def test_service_name_forbidden_chars_match_source():
    source = _read(HOST_CONFIG_FILE)
    # The Go source rejects via `strings.ContainsAny(...)`. The forbidden
    # set contains an escaped `"` and a literal `\\` so we match the
    # whole token including escaped characters.
    match = re.search(
        r'strings\.ContainsAny\(c\.ServiceName,\s*"((?:\\.|[^"\\])*)"\)',
        source,
    )
    assert match is not None, "Go source no longer matches expected shape"
    forbidden = match.group(1).encode().decode("unicode_escape")
    assert forbidden == C.SERVICE_NAME_FORBIDDEN_CHARS


# --------------------------------------------------------------------- #
# Canonical install + ImagePath argv shape.
# --------------------------------------------------------------------- #


def test_canonical_install_argv_matches_validate_required_fields():
    args = C.CanonicalInstallArgs(
        host_exe=r"C:\ProgramData\NetManagerAgent\bin\charon-agent-host.exe",
        private_python=r"C:\ProgramData\NetManagerAgent\payload\current\runtime\python\python.exe",
        entrypoint=r"C:\ProgramData\NetManagerAgent\payload\current\app\run_agent.py",
        app_dir=r"C:\ProgramData\NetManagerAgent\payload\current\app",
        config_path=r"C:\ProgramData\NetManagerAgent\config.env",
        log_dir=r"C:\ProgramData\NetManagerAgent\logs",
    )
    argv = args.to_argv()
    assert argv[0] == "install"
    # Every flag enforced by Validate() must appear.
    for flag in C.INSTALL_FLAGS:
        if flag.required:
            assert flag.name in argv, f"required flag {flag.name} missing from argv"


def test_canonical_install_repeats_child_arg_in_order():
    args = C.CanonicalInstallArgs(
        host_exe="H", private_python="P", entrypoint="E",
        app_dir="A", config_path="C", log_dir="L",
    )
    argv = args.to_argv()
    child_args = [argv[i + 1] for i, x in enumerate(argv) if x == "--child-arg"]
    assert child_args == ["-E", "-I", "E"], (
        f"--child-arg sequence must be -E, -I, <entrypoint> in this order; "
        f"got {child_args}"
    )


def test_canonical_image_path_starts_with_run_not_install():
    """`buildRegistryArgs()` prepends `run`, not `install`."""
    args = C.CanonicalInstallArgs(
        host_exe="H", private_python="P", entrypoint="E",
        app_dir="A", config_path="C", log_dir="L",
    )
    image_argv = C.canonical_image_path_argv(args)
    assert image_argv[0] == "run"


def test_canonical_image_path_emits_child_args_last():
    args = C.CanonicalInstallArgs(
        host_exe="H", private_python="P", entrypoint="E",
        app_dir="A", config_path="C", log_dir="L",
    )
    image_argv = C.canonical_image_path_argv(args)
    # All `--child-arg` pairs come AFTER the static flag block.
    static_block_end = image_argv.index("--child-arg")
    static_block = image_argv[:static_block_end]
    child_block = image_argv[static_block_end:]
    assert "--service-name" in static_block
    assert "--service-account" in static_block
    # Every `--child-arg` in the child block.
    for i in range(0, len(child_block), 2):
        assert child_block[i] == "--child-arg"
