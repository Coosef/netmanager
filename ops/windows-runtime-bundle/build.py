"""NetManager Windows Agent v2 — runtime bundle builder.

Offline, deterministic, fail-closed. Implements the architecture plan's
Section C.1–C.6 + the runtime-smoke-imports.txt canonical contract
(#34 + #47 + #63) + SOURCE_DATE_EPOCH rules (#22 + #31 + #39 + corrections
through v11).

PR #1 scope: this is the builder source. It supports a `--check` mode
that exercises every fail-closed precondition WITHOUT downloading any
embedded Python or any wheels. The full `--build` path (network download
+ pip install --target + ZIP assembly) ships in PR #4 once the
`windows-runtime-bundle.yml` CI workflow is in place.

The build mode REQUIRES SOURCE_DATE_EPOCH. The check mode also reads it
(missing / malformed → exit 1) because that gate is the single most
likely place for an operator mistake to slip through.
"""
from __future__ import annotations

import argparse
import datetime
import os
import re
import sys
from pathlib import Path

# Builder is a small enough script that we accept the toml-stdlib
# dependency directly. Python 3.11+ has tomllib; 3.10 and earlier are
# not supported (the project floor is 3.11+).
try:
    import tomllib  # type: ignore[import-not-found]
except ModuleNotFoundError:  # pragma: no cover
    print("FATAL: builder requires Python >= 3.11 (tomllib).", file=sys.stderr)
    sys.exit(1)


# --------------------------------------------------------------------- #
# Constants derived from the architecture plan.
# --------------------------------------------------------------------- #

# 1980-01-01 00:00:00 UTC — DOS time epoch lower bound. SOURCE_DATE_EPOCH
# below this value would break ZIP entry timestamp encoding (per #31).
SOURCE_DATE_EPOCH_MIN = 315_532_800

# Practical upper bound: the year 2107 is the last representable
# `ZipInfo.date_time` year. The exact maximum is library-defined and is
# probed at startup against the actual `zipfile.ZipInfo.date_time`
# setter. The fallback constant below is the documented contract value.
SOURCE_DATE_EPOCH_MAX_FALLBACK = 4_354_819_198  # ~2107-12-31 23:59:58 UTC

# Smoke-list canonical byte format (#63).
SMOKE_LIST_FILENAME = "runtime-smoke-imports.txt"
SMOKE_LINE_REGEX = re.compile(r"^[A-Za-z_][A-Za-z0-9_.]*$")


# --------------------------------------------------------------------- #
# Errors.
# --------------------------------------------------------------------- #


class BuilderError(RuntimeError):
    """Fail-closed builder error.

    Exit code 1 is reserved for all builder validation failures (so the
    operator's CI loop can distinguish "lock invalid" from "network
    failure" without parsing the message body).
    """


# --------------------------------------------------------------------- #
# SOURCE_DATE_EPOCH validation.
# --------------------------------------------------------------------- #


def _probe_zip_upper_bound() -> int:
    """Return the last SOURCE_DATE_EPOCH that the active zipfile library
    will accept as a `ZipInfo.date_time`.

    We don't hard-code a magic number per #31. Instead we walk back from
    the documented fallback upper bound until `ZipInfo` accepts the
    epoch. In practice 2107-12-31 23:59:58 is the canonical answer on
    CPython 3.11+; older interpreters may stop a few seconds earlier and
    that's fine — the probe finds the real edge.
    """
    import zipfile

    candidate = SOURCE_DATE_EPOCH_MAX_FALLBACK
    while candidate > SOURCE_DATE_EPOCH_MIN:
        try:
            dt = datetime.datetime.fromtimestamp(candidate, datetime.timezone.utc)
            zi = zipfile.ZipInfo(filename="x")
            zi.date_time = (dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second)
            return candidate
        except (OverflowError, ValueError):
            candidate -= 60
    # If the library can't accept anything above 1980 we have bigger
    # problems; fall back to the documented value rather than recurse.
    return SOURCE_DATE_EPOCH_MAX_FALLBACK


def parse_source_date_epoch(env: dict[str, str], *, upper_bound: int) -> int:
    """Validate $SOURCE_DATE_EPOCH per corrections #22 + #31 + #39.

    REQUIRED. Must be a non-negative integer, must lie in
    [SOURCE_DATE_EPOCH_MIN, upper_bound]. Empty / negative / non-integer
    → BuilderError.
    """
    raw = env.get("SOURCE_DATE_EPOCH")
    if raw is None:
        raise BuilderError(
            "SOURCE_DATE_EPOCH is REQUIRED (correction #22). Set it explicitly "
            "before invoking the builder; there is no wall-clock fallback."
        )
    raw_stripped = raw.strip()
    if raw_stripped == "":
        raise BuilderError("SOURCE_DATE_EPOCH is empty — refused (correction #22).")
    if raw_stripped != raw:
        raise BuilderError(
            f"SOURCE_DATE_EPOCH must have no surrounding whitespace; got {raw!r}."
        )
    if not re.fullmatch(r"-?\d+", raw_stripped):
        raise BuilderError(
            f"SOURCE_DATE_EPOCH must be an integer; got {raw_stripped!r}."
        )
    value = int(raw_stripped)
    if value < 0:
        raise BuilderError(
            f"SOURCE_DATE_EPOCH must be non-negative; got {value}."
        )
    if value < SOURCE_DATE_EPOCH_MIN:
        raise BuilderError(
            f"SOURCE_DATE_EPOCH {value} is below the ZIP DOS-time lower bound "
            f"{SOURCE_DATE_EPOCH_MIN} (1980-01-01 UTC) — refused per #31."
        )
    if value > upper_bound:
        raise BuilderError(
            f"SOURCE_DATE_EPOCH {value} exceeds the zipfile library's upper "
            f"bound {upper_bound} — refused per #31."
        )
    return value


def epoch_to_iso8601_utc(epoch: int) -> str:
    """Format SOURCE_DATE_EPOCH as the manifest's `built_utc` field.

    Per #39: `built_utc` uses the ORIGINAL epoch (NOT the DOS-bucket-
    normalized one used for ZIP entry timestamps).
    """
    return (
        datetime.datetime.fromtimestamp(epoch, datetime.timezone.utc)
        .strftime("%Y-%m-%dT%H:%M:%SZ")
    )


def epoch_to_dos_bucket(epoch: int) -> int:
    """Round DOWN to the nearest even second (MS-DOS 2-second resolution).

    Per #39: ZIP entry timestamps use the bucket-normalized value.
    """
    return epoch - (epoch % 2)


# --------------------------------------------------------------------- #
# Smoke-list canonical byte-format validation (#63).
# --------------------------------------------------------------------- #


def validate_smoke_list_bytes(path: Path) -> list[str]:
    """Validate the runtime-smoke-imports.txt canonical contract.

    Encoding: UTF-8. BOM: forbidden. Line endings: LF only.
    Blank lines: forbidden. Comments: forbidden. Duplicates: forbidden.
    Trailing newline: exactly one. Each line matches the import regex.

    Returns the parsed module list in source order.
    """
    if not path.is_file():
        raise BuilderError(f"smoke list not found at {path}")
    data = path.read_bytes()
    if not data:
        raise BuilderError("smoke list is empty — refused (correction #63).")
    if data.startswith(b"\xef\xbb\xbf"):
        raise BuilderError(
            "smoke list carries a UTF-8 BOM — refused (correction #63)."
        )
    if b"\r" in data:
        raise BuilderError(
            "smoke list contains CR bytes; LF-only line endings required "
            "(correction #63)."
        )
    if not data.endswith(b"\n"):
        raise BuilderError(
            "smoke list must end in exactly one LF (correction #63)."
        )
    if data.endswith(b"\n\n"):
        raise BuilderError(
            "smoke list ends in more than one LF — refused (correction #63)."
        )
    text = data.decode("utf-8")
    # `splitlines(keepends=False)` collapses the trailing LF; explicit
    # split keeps the contract crisp.
    lines = text.split("\n")
    # `data ends in \n` means split yields a trailing empty string.
    if lines[-1] != "":
        raise BuilderError("smoke list trailing-LF invariant broken.")
    modules = lines[:-1]
    seen: set[str] = set()
    for idx, line in enumerate(modules):
        if line == "":
            raise BuilderError(
                f"smoke list line {idx + 1} is blank — refused (correction #63)."
            )
        if not SMOKE_LINE_REGEX.fullmatch(line):
            raise BuilderError(
                f"smoke list line {idx + 1} {line!r} fails the import regex "
                f"^[A-Za-z_][A-Za-z0-9_.]*$ (correction #34)."
            )
        if line in seen:
            raise BuilderError(
                f"smoke list contains duplicate module {line!r} (correction #63)."
            )
        seen.add(line)
    return modules


# --------------------------------------------------------------------- #
# Release-pins loader.
# --------------------------------------------------------------------- #


# fields that release-pins.toml MUST carry. Builder treats anything
# else as informational; missing fields → BuilderError. Note: there is
# NO timestamp field; the operator's correction #22 forbids it.
_REQUIRED_PIN_FIELDS = (
    "RUNTIME_VERSION",
    "EMBEDDED_PYTHON_URL",
    "EMBEDDED_PYTHON_SHA256",
    "PYTHON_VERSION",
    "BUNDLE_PLATFORM",
    "COMPATIBLE_HOST_CORE_RANGE",
    "SIZE_LOWER_BOUND_BYTES",
    "SIZE_UPPER_BOUND_BYTES",
)

# Pin fields that MUST NOT exist (correction #22).
_FORBIDDEN_PIN_FIELDS = (
    "RELEASE_TIMESTAMP_UTC",
    "RELEASE_TIMESTAMP",
    "BUILT_UTC",
    "BUILD_TIMESTAMP",
)


def load_release_pins(path: Path) -> dict[str, object]:
    if not path.is_file():
        raise BuilderError(f"release-pins.toml not found at {path}")
    pins = tomllib.loads(path.read_text("utf-8"))
    for field in _REQUIRED_PIN_FIELDS:
        if field not in pins:
            raise BuilderError(
                f"release-pins.toml missing required field {field!r}."
            )
    for field in _FORBIDDEN_PIN_FIELDS:
        if field in pins:
            raise BuilderError(
                f"release-pins.toml carries forbidden field {field!r} — "
                "release pins MUST NOT include any timestamp (correction #22)."
            )
    sha = pins["EMBEDDED_PYTHON_SHA256"]
    if not isinstance(sha, str) or not re.fullmatch(r"[0-9A-Fa-f]{64}", sha):
        raise BuilderError(
            "EMBEDDED_PYTHON_SHA256 must be a 64-character hex string."
        )
    return pins


# --------------------------------------------------------------------- #
# Lock-file loader.
# --------------------------------------------------------------------- #

_LOCK_LINE_HASH_RE = re.compile(r"--hash=sha256:[0-9a-f]{64}")


def parse_requirements_lock(path: Path) -> list[str]:
    """Parse the pinned lock and validate every line carries a hash.

    Returns the list of pinned distribution-version specifiers in source
    order. Empty results, or any pinned entry without a SHA-256 hash,
    raises BuilderError.
    """
    if not path.is_file():
        raise BuilderError(f"requirements-windows.lock not found at {path}")
    pinned: list[str] = []
    body = path.read_text("utf-8")
    current_pin: str | None = None
    for raw_line in body.splitlines():
        line = raw_line.rstrip()
        if not line:
            current_pin = None
            continue
        if line.lstrip().startswith("#"):
            current_pin = None
            continue
        if line.startswith(" ") or line.startswith("\t"):
            # continuation; usually `    --hash=sha256:...`
            if current_pin is not None and "--hash=sha256:" in line:
                pinned[-1] = pinned[-1] + " " + line.strip()
            continue
        # new pin line — may be either:
        #   websockets==12.0 \
        # or with the hash inline:
        #   websockets==12.0 --hash=sha256:...
        if "==" not in line:
            # tolerate `pip-compile` header comments and extras-only lines.
            continue
        current_pin = line.split(" ", 1)[0]
        pinned.append(line)
    for line in pinned:
        if not _LOCK_LINE_HASH_RE.search(line):
            raise BuilderError(
                f"lock entry has no --hash=sha256 token: {line!r}"
            )
    return pinned


# --------------------------------------------------------------------- #
# `--check` driver.
# --------------------------------------------------------------------- #


def run_check(root: Path) -> int:
    pins = load_release_pins(root / "release-pins.toml")
    upper = _probe_zip_upper_bound()
    epoch = parse_source_date_epoch(dict(os.environ), upper_bound=upper)
    modules = validate_smoke_list_bytes(root / SMOKE_LIST_FILENAME)
    pinned = parse_requirements_lock(root / "requirements-windows.lock")
    min_count = int(pins.get("LOCK_MIN_DEPENDENCY_COUNT", 0))
    if len(pinned) < min_count:
        raise BuilderError(
            f"lock has {len(pinned)} pinned entries; floor is {min_count}."
        )

    bucket_epoch = epoch_to_dos_bucket(epoch)
    print(f"runtime_version         : {pins['RUNTIME_VERSION']}")
    print(f"python_version          : {pins['PYTHON_VERSION']}")
    print(f"platform                : {pins['BUNDLE_PLATFORM']}")
    print(f"compatible_host_core_range : {pins['COMPATIBLE_HOST_CORE_RANGE']}")
    print(f"SOURCE_DATE_EPOCH       : {epoch} ({epoch_to_iso8601_utc(epoch)})")
    print(f"ZIP DOS-bucket epoch    : {bucket_epoch}")
    print(f"smoke modules           : {len(modules)} ({', '.join(modules)})")
    print(f"lock entries            : {len(pinned)}")
    print("CHECK_RESULT=OK")
    return 0


# --------------------------------------------------------------------- #
# CLI entry.
# --------------------------------------------------------------------- #


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="build.py",
        description=(
            "NetManager Windows Agent v2 runtime bundle builder. "
            "The --check mode validates every fail-closed precondition "
            "without producing a bundle; the full --build mode is wired "
            "up in PR #4."
        ),
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Validate inputs and SOURCE_DATE_EPOCH without building.",
    )
    args = parser.parse_args(argv)
    root = Path(__file__).resolve().parent
    try:
        if args.check:
            return run_check(root)
        print(
            "FATAL: --build mode is gated to PR #4; this PR ships only --check.",
            file=sys.stderr,
        )
        return 1
    except BuilderError as err:
        print(f"BUILDER_ERROR: {err}", file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
