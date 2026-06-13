"""Runtime bundle integrity check — Section D of the architecture plan.

Memoized read-once-per-process integrity result for the embedded
Windows runtime bundle. Reads:

  - the `.current` single-line version sidecar at
    `/opt/netmanager/agent-bins/charon-runtime-windows-amd64.current`,
  - the versioned `<...>-<version>.zip`,
    `<...>-<version>.zip.sha256`, and
    `<...>-<version>.manifest.json` assets,
  - applies size bounds 5 MiB – 200 MiB (mirrors
    `ops/windows-runtime-bundle/release-pins.toml`),
  - asserts SHA-256 equality across ZIP bytes, the `.sha256` sidecar,
    and the manifest's `zip_sha256` field,
  - delegates canonical-path + duplicate + entrypoint + smoke-list
    inventory rules to the Pydantic `Manifest` schema,
  - delegates `compatible_host_core_range` grammar to the schema,
  - cross-checks the baked Go host binary's version against that
    range (a runtime bundle whose `compatible_host_core_range`
    excludes the live host binary MUST NOT be served — the
    installer would refuse it at Stage 4 anyway, but the backend
    surfaces a 503 instead of letting a doomed download start).

A bad result — asset missing, SHA mismatch, manifest malformed, host
version outside the manifest's range — is a permanent "runtime
endpoint unavailable" until the next process boot; flipping it
requires an image rebuild. Linux endpoints, login, dashboard and the
rest of the backend stay up regardless.

The module is import-safe: opens no files at import time, makes no
network calls, reads no environment. All I/O happens inside
`_read_runtime_integrity()`.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from dataclasses import dataclass

from .core_range import CoreRangeError, satisfies
from .manifest import Manifest

log = logging.getLogger("netmanager.security")


# Section D + parity with `agents.py:718-720` (host binary paths).
RUNTIME_BIN_DIR = "/opt/netmanager/agent-bins"
RUNTIME_CURRENT_PATH = RUNTIME_BIN_DIR + "/charon-runtime-windows-amd64.current"

# Section D ZIP size bounds; mirrors release-pins.toml's
# SIZE_LOWER_BOUND_BYTES / SIZE_UPPER_BOUND_BYTES.
SIZE_LOWER_BOUND_BYTES = 5 * 1024 * 1024     # 5 MiB
SIZE_UPPER_BOUND_BYTES = 200 * 1024 * 1024   # 200 MiB

# `.current` sidecar grammar — single line, N.N.N only.
_CURRENT_VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")
_HEX64_RE = re.compile(r"^[0-9a-fA-F]{64}$")


def _versioned_paths(version: str) -> tuple[str, str, str]:
    """Return `(zip_path, sha_path, manifest_path)` for `version`."""
    base = f"{RUNTIME_BIN_DIR}/charon-runtime-windows-amd64-{version}"
    return base + ".zip", base + ".zip.sha256", base + ".manifest.json"


@dataclass
class RuntimeIntegrity:
    """Cached integrity result for the runtime bundle.

    A populated `ok=True` instance guarantees:
      - `version`, `zip_path`, `zip_sha256` (UPPER hex), `zip_size`,
        `manifest_path`, `manifest_bytes`, and `manifest` are all set,
      - the on-disk ZIP at `zip_path` hashes to `zip_sha256`,
      - the manifest JSON parses + validates under `Manifest`,
      - `manifest.zip_sha256` / `zip_size_bytes` / `runtime_version`
        match the on-disk reality,
      - the supplied baked host version satisfies
        `manifest.compatible_host_core_range`.
    """

    ok: bool = False
    error: str | None = None
    version: str | None = None              # from `.current`
    zip_path: str | None = None
    zip_sha256: str | None = None           # UPPER hex
    zip_size: int | None = None
    manifest_path: str | None = None
    manifest_bytes: bytes | None = None     # verbatim disk bytes
    manifest: Manifest | None = None


def _read_current_version() -> tuple[str | None, str | None]:
    if not os.path.isfile(RUNTIME_CURRENT_PATH):
        return None, ".current sidecar missing"
    try:
        with open(RUNTIME_CURRENT_PATH, "r") as f:
            raw = f.read()
    except OSError:
        return None, ".current sidecar unreadable"
    # Trailing newline tolerated; embedded newlines rejected.
    stripped = raw.rstrip("\n").rstrip("\r")
    if "\n" in stripped or "\r" in stripped:
        return None, ".current sidecar must be a single line"
    if not _CURRENT_VERSION_RE.match(stripped):
        return None, ".current sidecar malformed (must be N.N.N)"
    return stripped, None


def _sha256_stream(path: str) -> str:
    """SHA-256 of a file by streaming 64 KiB chunks; returns lowercase hex."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(64 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _read_runtime_integrity(baked_host_version: str | None) -> RuntimeIntegrity:
    """Validate the runtime bundle on disk. Never raises."""
    out = RuntimeIntegrity()

    # 1. Read `.current` single-line version.
    version, err = _read_current_version()
    if err is not None:
        out.error = err
        return out
    out.version = version

    # 2. Versioned asset paths.
    zip_path, sha_path, manifest_path = _versioned_paths(version)
    out.zip_path = zip_path
    out.manifest_path = manifest_path

    # 3. ZIP existence + size bounds.
    if not os.path.isfile(zip_path):
        out.error = "runtime zip missing"
        return out
    try:
        size = os.path.getsize(zip_path)
    except OSError:
        out.error = "runtime zip stat failed"
        return out
    if size < SIZE_LOWER_BOUND_BYTES or size > SIZE_UPPER_BOUND_BYTES:
        out.error = f"runtime zip size {size} out of sanity range"
        return out
    out.zip_size = size

    # 4. `.sha256` sidecar.
    if not os.path.isfile(sha_path):
        out.error = "runtime sha sidecar missing"
        return out
    try:
        with open(sha_path, "r") as f:
            sha_text = f.read()
    except OSError:
        out.error = "runtime sha sidecar unreadable"
        return out
    stripped_sha = sha_text.strip()
    sidecar = stripped_sha.split()[0] if stripped_sha else ""
    if not _HEX64_RE.match(sidecar):
        out.error = "runtime sha sidecar format invalid"
        return out

    try:
        actual_lower = _sha256_stream(zip_path)
    except OSError:
        out.error = "runtime zip read failed during hashing"
        return out
    if actual_lower.lower() != sidecar.lower():
        out.error = "runtime sha256 mismatch (zip vs sidecar)"
        log.error("runtime integrity: sha mismatch (zip vs sidecar)")
        return out
    out.zip_sha256 = actual_lower.upper()

    # 5. Manifest bytes (kept verbatim for the manifest endpoint).
    if not os.path.isfile(manifest_path):
        out.error = "runtime manifest missing"
        return out
    try:
        with open(manifest_path, "rb") as f:
            manifest_bytes = f.read()
    except OSError:
        out.error = "runtime manifest unreadable"
        return out
    out.manifest_bytes = manifest_bytes

    # 6. Manifest schema validation.
    try:
        manifest_obj = json.loads(manifest_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        out.error = "runtime manifest is not valid UTF-8 JSON"
        return out

    try:
        manifest = Manifest(**manifest_obj)
    except Exception as e:  # pydantic.ValidationError + anything else
        out.error = f"runtime manifest schema invalid: {type(e).__name__}"
        log.error("runtime integrity: manifest schema invalid (%s)", type(e).__name__)
        return out
    out.manifest = manifest

    # 7. Manifest field cross-checks vs on-disk reality.
    if manifest.zip_size_bytes != size:
        out.error = (
            f"runtime manifest zip_size_bytes {manifest.zip_size_bytes} "
            f"!= actual {size}"
        )
        return out
    if manifest.zip_sha256.lower() != actual_lower:
        out.error = "runtime manifest zip_sha256 != actual"
        return out
    if manifest.runtime_version != version:
        out.error = (
            f"runtime manifest runtime_version {manifest.runtime_version!r} "
            f"!= .current sidecar {version!r}"
        )
        return out

    # 8. Baked host version must satisfy compatible_host_core_range.
    # A missing baked host version is a hard reject — the integrity
    # contract in Section D requires the cross-check, and serving a
    # runtime whose compat range cannot be verified is fail-open.
    if baked_host_version is None:
        out.error = (
            "baked host version unavailable; cannot verify "
            "compatible_host_core_range"
        )
        return out
    try:
        if not satisfies(baked_host_version, manifest.compatible_host_core_range):
            out.error = (
                f"baked host version {baked_host_version} does not satisfy "
                f"manifest compatible_host_core_range "
                f"{manifest.compatible_host_core_range}"
            )
            log.error("runtime integrity: host version outside compat range")
            return out
    except CoreRangeError as err:
        out.error = f"host version / core-range parse failed: {err}"
        return out

    out.ok = True
    return out


# Module-level memoization cache — mirrors `agents.py:_HOST_INTEGRITY_CACHE`.
_RUNTIME_INTEGRITY_CACHE: RuntimeIntegrity | None = None


def runtime_integrity(baked_host_version: str | None) -> RuntimeIntegrity:
    """Memoized per-process runtime integrity result.

    The `baked_host_version` is fixed for the life of the process (it
    is read from a `.version` sidecar baked into the backend image at
    build time), so the first call's value is reused for every later
    call. Tests that vary the input MUST call
    `reset_runtime_integrity_cache()` between cases.
    """
    global _RUNTIME_INTEGRITY_CACHE
    if _RUNTIME_INTEGRITY_CACHE is None:
        _RUNTIME_INTEGRITY_CACHE = _read_runtime_integrity(baked_host_version)
    return _RUNTIME_INTEGRITY_CACHE


def reset_runtime_integrity_cache() -> None:
    """Test-only — clear the memoization cache."""
    global _RUNTIME_INTEGRITY_CACHE
    _RUNTIME_INTEGRITY_CACHE = None
