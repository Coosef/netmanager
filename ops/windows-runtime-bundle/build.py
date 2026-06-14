"""NetManager Windows Agent v2 — runtime bundle builder.

Offline, deterministic, fail-closed. Implements the architecture plan's
Section C.1–C.6 + the runtime-smoke-imports.txt canonical contract
(#34 + #47 + #63) + SOURCE_DATE_EPOCH rules (#22 + #31 + #39 + corrections
through v11).

Two modes:

  --check  — Validate every fail-closed precondition WITHOUT producing
             a bundle. Confirms release-pins.toml grammar, lock-file
             hashes, smoke-list canonical bytes, SOURCE_DATE_EPOCH
             range. Same gate fires in both modes.
  --build  — Assemble a deterministic ZIP + detached manifest + SHA-256
             sidecar from a PRE-STAGED source tree. The fetch + stage
             step (download Python embed, pip download wheelhouse, pip
             install --target) is the workflow's responsibility; this
             builder does not touch the network and does not write
             outside `--output-dir`. Two clean builds with the same
             SOURCE_DATE_EPOCH against an identical source tree produce
             byte-identical ZIP + manifest + sidecar.
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import re
import sys
import zipfile
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
# `--build` driver (Section C.1 + C.5).
# --------------------------------------------------------------------- #
#
# `--build` operates on a PRE-STAGED source tree that already contains:
#
#   <source-tree>/runtime/python/...                  (embed + .pyd + .dll)
#   <source-tree>/app/run_agent.py                    (entrypoint)
#   <source-tree>/app/netmanager_agent.py             (agent module)
#   <source-tree>/licenses/...                        (per #8)
#   <source-tree>/metadata/runtime-smoke-imports.txt  (byte copy of ops/)
#
# It NEVER reaches out to the network. The CI workflow stages everything
# above (download python.org embed, pip-download wheelhouse, pip install
# --target) BEFORE invoking the builder.

# Deterministic ZIP constants — mirrored from release-pins.toml (those
# are documentation; these are the source of truth at build time).
ZIP_COMPRESSION_LEVEL = 6
ZIP_FILE_MODE = 0o644
# Unix (3) on the create-system byte makes the ZIP deterministic across
# Linux- and Windows-hosted CI runners (Windows zipfile defaults to
# create_system=0 = MS-DOS, which embeds the host's local timezone in
# the extra field — kills cross-platform byte-equality).
ZIP_CREATE_SYSTEM = 3
ZIP_CREATE_VERSION = 20
ZIP_EXTRACT_VERSION = 20

# Reproducibility lexical order (#7) — UTF-8 binary, lowercased.
_ZIP_SORT_KEY = lambda zip_name: zip_name.encode("utf-8").lower()

# Per the architecture plan, the manifest's `entrypoint` is the canonical
# Windows form `app\run_agent.py`. Any deviation in the staged tree is a
# fail-closed builder error.
EXPECTED_ENTRYPOINT_CANONICAL = "app\\run_agent.py"

# Required top-level subtree roots (presence enforced before ZIP).
_REQUIRED_SOURCE_ROOTS = ("runtime", "app", "licenses", "metadata")


class _CollectedFile:
    """A single staged file ready for ZIP assembly."""

    __slots__ = ("zip_name", "canonical", "abs_path", "size", "sha256_lower")

    def __init__(self, zip_name: str, canonical: str, abs_path: Path) -> None:
        self.zip_name = zip_name        # POSIX form (forward slashes) — PKZIP standard
        self.canonical = canonical      # Windows form (backslashes) — manifest schema
        self.abs_path = abs_path
        data = abs_path.read_bytes()
        self.size = len(data)
        self.sha256_lower = hashlib.sha256(data).hexdigest()


def _collect_source_tree(source_tree: Path) -> list[_CollectedFile]:
    """Walk the staged tree and return a sorted, deterministic file list.

    Symlinks are NOT followed (`is_file()` returns True for files only;
    Path.rglob does include directories, which we skip). Every file's
    relative path is converted to canonical Windows form for the
    manifest, with a POSIX twin for the ZIP entry name.

    Sorted lexically by UTF-8-binary lowercase of the POSIX name — per
    correction #7's reproducibility rule.
    """
    if not source_tree.is_dir():
        raise BuilderError(f"source tree {source_tree} is not a directory")
    files: list[_CollectedFile] = []
    for entry in source_tree.rglob("*"):
        if entry.is_symlink():
            raise BuilderError(
                f"source tree contains symlink {entry} — refused (Section F)"
            )
        if not entry.is_file():
            continue
        rel_posix = entry.relative_to(source_tree).as_posix()
        canonical = rel_posix.replace("/", "\\")
        files.append(_CollectedFile(rel_posix, canonical, entry))
    files.sort(key=lambda f: _ZIP_SORT_KEY(f.zip_name))
    return files


def _enforce_top_level_subtree(source_tree: Path) -> None:
    """Every top-level root listed in `_REQUIRED_SOURCE_ROOTS` MUST exist."""
    missing = [
        name for name in _REQUIRED_SOURCE_ROOTS
        if not (source_tree / name).is_dir()
    ]
    if missing:
        raise BuilderError(
            f"source tree missing required top-level subtree(s): {missing}"
        )


def _enforce_smoke_list_parity(
    source_tree: Path,
    ops_smoke_list: Path,
) -> None:
    """The in-tree smoke list MUST be byte-identical to the ops/ source."""
    in_tree = source_tree / "metadata" / SMOKE_LIST_FILENAME
    if not in_tree.is_file():
        raise BuilderError(
            f"source tree missing metadata/{SMOKE_LIST_FILENAME}"
        )
    if in_tree.read_bytes() != ops_smoke_list.read_bytes():
        raise BuilderError(
            "in-tree metadata/runtime-smoke-imports.txt does not match "
            "ops/windows-runtime-bundle/runtime-smoke-imports.txt — the "
            "deployed copy MUST be a byte-for-byte mirror (correction #63)."
        )


def _emit_deterministic_zip(
    zip_path: Path,
    files: list[_CollectedFile],
    bucket_epoch: int,
) -> None:
    """Write the ZIP at `zip_path` deterministically.

    Two clean builds with the same `bucket_epoch` and the same `files`
    list produce byte-identical ZIPs. Compression level is fixed at 6.
    External attributes are normalized to `0o644 << 16` regardless of
    host OS. `create_system` is forced to Unix (3) so a Windows host
    runner cannot poison the file with DOS-time extra fields.
    """
    dt = datetime.datetime.fromtimestamp(bucket_epoch, datetime.timezone.utc)
    date_time = (dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second)

    if zip_path.exists():
        zip_path.unlink()
    zip_path.parent.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(
        zip_path,
        mode="w",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=ZIP_COMPRESSION_LEVEL,
    ) as zf:
        for entry in files:
            zi = zipfile.ZipInfo(filename=entry.zip_name)
            zi.date_time = date_time
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.create_system = ZIP_CREATE_SYSTEM
            zi.create_version = ZIP_CREATE_VERSION
            zi.extract_version = ZIP_EXTRACT_VERSION
            zi.external_attr = (ZIP_FILE_MODE << 16)
            zi.internal_attr = 0
            with entry.abs_path.open("rb") as src:
                zf.writestr(zi, src.read())


def _emit_manifest(
    manifest_path: Path,
    pins: dict[str, object],
    epoch: int,
    files: list[_CollectedFile],
    zip_size: int,
    zip_sha256_lower: str,
) -> bytes:
    """Write the detached manifest JSON; return the bytes written.

    Schema: Section C.2 of the architecture plan. Sorted keys, two-space
    indent, trailing newline (per correction #7).
    """
    files_inventory = [
        {
            "path": f.canonical,
            "size": f.size,
            "sha256": f.sha256_lower.upper(),
        }
        for f in files
    ]
    canonical_inventory_paths = {f.canonical for f in files}
    if EXPECTED_ENTRYPOINT_CANONICAL not in canonical_inventory_paths:
        raise BuilderError(
            f"staged tree does not contain entrypoint "
            f"{EXPECTED_ENTRYPOINT_CANONICAL!r} (file missing from app/)"
        )
    smoke_canonical = "metadata\\" + SMOKE_LIST_FILENAME
    if smoke_canonical not in canonical_inventory_paths:
        raise BuilderError(
            f"staged tree does not contain {smoke_canonical!r} "
            f"(metadata subtree missing the deployed smoke list)"
        )

    manifest = {
        "schema_version": 1,
        "runtime_version": pins["RUNTIME_VERSION"],
        "python_version": pins["PYTHON_VERSION"],
        "platform": pins["BUNDLE_PLATFORM"],
        "built_utc": epoch_to_iso8601_utc(epoch),
        "embedded_python_source_sha256": str(pins["EMBEDDED_PYTHON_SHA256"]).upper(),
        "zip_size_bytes": zip_size,
        "zip_sha256": zip_sha256_lower.upper(),
        "compatible_host_core_range": pins["COMPATIBLE_HOST_CORE_RANGE"],
        "entrypoint": EXPECTED_ENTRYPOINT_CANONICAL,
        "files": files_inventory,
    }
    body = (
        json.dumps(manifest, sort_keys=True, indent=2).encode("utf-8")
        + b"\n"
    )
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_bytes(body)
    return body


def _emit_sha_sidecar(sha_path: Path, zip_sha256_lower: str) -> None:
    """Write the `.zip.sha256` sidecar (lowercase + LF, matches the
    backend's `_read_runtime_integrity()` parser exactly)."""
    sha_path.parent.mkdir(parents=True, exist_ok=True)
    sha_path.write_text(zip_sha256_lower + "\n", encoding="utf-8")


def run_build(
    root: Path,
    *,
    source_tree: Path,
    output_dir: Path,
) -> dict[str, object]:
    """Build the runtime bundle from a pre-staged source tree.

    Returns a result dict with paths + the computed SHA + the byte size.
    Raises `BuilderError` (caught by `main`) on any validation failure.
    """
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

    _enforce_top_level_subtree(source_tree)
    _enforce_smoke_list_parity(source_tree, root / SMOKE_LIST_FILENAME)
    files = _collect_source_tree(source_tree)
    if not files:
        raise BuilderError("source tree contains no files")

    runtime_version = str(pins["RUNTIME_VERSION"])
    bundle_platform = str(pins["BUNDLE_PLATFORM"])
    base = f"charon-runtime-{bundle_platform}-{runtime_version}"
    zip_path      = output_dir / f"{base}.zip"
    sha_path      = output_dir / f"{base}.zip.sha256"
    manifest_path = output_dir / f"{base}.manifest.json"
    current_path  = output_dir / f"charon-runtime-{bundle_platform}.current"

    bucket_epoch = epoch_to_dos_bucket(epoch)
    _emit_deterministic_zip(zip_path, files, bucket_epoch)
    zip_bytes = zip_path.read_bytes()
    zip_size = len(zip_bytes)
    lower_bound = int(pins["SIZE_LOWER_BOUND_BYTES"])
    upper_bound = int(pins["SIZE_UPPER_BOUND_BYTES"])
    if zip_size < lower_bound:
        raise BuilderError(
            f"built ZIP size {zip_size} below SIZE_LOWER_BOUND_BYTES {lower_bound}"
        )
    if zip_size > upper_bound:
        raise BuilderError(
            f"built ZIP size {zip_size} above SIZE_UPPER_BOUND_BYTES {upper_bound}"
        )
    zip_sha256_lower = hashlib.sha256(zip_bytes).hexdigest()

    manifest_bytes = _emit_manifest(
        manifest_path, pins, epoch, files, zip_size, zip_sha256_lower,
    )
    _emit_sha_sidecar(sha_path, zip_sha256_lower)
    current_path.parent.mkdir(parents=True, exist_ok=True)
    current_path.write_text(runtime_version + "\n", encoding="utf-8")

    return {
        "zip_path":         zip_path,
        "sha_path":         sha_path,
        "manifest_path":    manifest_path,
        "current_path":     current_path,
        "zip_size":         zip_size,
        "zip_sha256_lower": zip_sha256_lower,
        "zip_sha256_upper": zip_sha256_lower.upper(),
        "bucket_epoch":     bucket_epoch,
        "runtime_version":  runtime_version,
        "files":            files,
        "manifest_bytes":   manifest_bytes,
    }


def _print_build_summary(result: dict[str, object]) -> None:
    print(f"runtime_version         : {result['runtime_version']}")
    print(f"bucket_epoch            : {result['bucket_epoch']}")
    print(f"file_count              : {len(result['files'])}")
    print(f"zip_size                : {result['zip_size']}")
    print(f"zip_sha256              : {result['zip_sha256_upper']}")
    print(f"zip_path                : {result['zip_path']}")
    print(f"sha_path                : {result['sha_path']}")
    print(f"manifest_path           : {result['manifest_path']}")
    print(f"current_path            : {result['current_path']}")
    print("BUILD_RESULT=OK")


# --------------------------------------------------------------------- #
# CLI entry.
# --------------------------------------------------------------------- #


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="build.py",
        description=(
            "NetManager Windows Agent v2 runtime bundle builder. "
            "--check validates every fail-closed precondition without "
            "producing a bundle. --build assembles the deterministic ZIP "
            "+ detached manifest + .sha256 sidecar from a pre-staged "
            "source tree (fetch + stage is the workflow's responsibility)."
        ),
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument(
        "--check",
        action="store_true",
        help="Validate inputs and SOURCE_DATE_EPOCH without building.",
    )
    mode.add_argument(
        "--build",
        action="store_true",
        help="Build the runtime bundle from a pre-staged source tree.",
    )
    parser.add_argument(
        "--source-tree",
        type=Path,
        help=(
            "Directory containing the pre-staged runtime / app / licenses "
            "/ metadata subtrees. REQUIRED when --build is set."
        ),
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        help=(
            "Directory to write <prefix>.zip, <prefix>.zip.sha256, "
            "<prefix>.manifest.json and the .current sidecar. REQUIRED "
            "when --build is set."
        ),
    )
    args = parser.parse_args(argv)
    root = Path(__file__).resolve().parent
    try:
        if args.check:
            return run_check(root)
        if args.build:
            if args.source_tree is None or args.output_dir is None:
                raise BuilderError(
                    "--build requires --source-tree and --output-dir"
                )
            result = run_build(
                root,
                source_tree=args.source_tree,
                output_dir=args.output_dir,
            )
            _print_build_summary(result)
            return 0
        # Unreachable — argparse mutually-exclusive group enforces it.
        return 1
    except BuilderError as err:
        print(f"BUILDER_ERROR: {err}", file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
