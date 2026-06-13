"""Programmatic ZIP fixture builders for PR #1 tests.

We don't check binary ZIP files into git. Each helper returns the raw
bytes of a ZIP whose contents are crafted to hit a specific Section F
rejection rule (or — for the runtime fixture — to satisfy the manifest
contract).

These helpers are deliberately verbose: they hand-craft `ZipInfo`
records so the per-entry external-attributes hacks (explicit-dir bit,
trailing-space filenames, etc.) are explicit.
"""
from __future__ import annotations

import hashlib
import io
import json
import zipfile
from typing import Iterable


# --------------------------------------------------------------------- #
# Helpers.
# --------------------------------------------------------------------- #


def _empty_zip() -> bytes:
    """The smallest possible (still valid) ZIP."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED):
        pass
    return buf.getvalue()


def _zip_with_files(entries: Iterable[tuple[str, bytes]]) -> bytes:
    """Build a ZIP whose entries are just (name, payload) pairs."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, payload in entries:
            info = zipfile.ZipInfo(filename=name)
            info.external_attr = 0o644 << 16
            zf.writestr(info, payload)
    return buf.getvalue()


def _zip_with_explicit_directory(name: str) -> bytes:
    """Emit a ZIP entry whose name carries a trailing `/` (directory)."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w") as zf:
        info = zipfile.ZipInfo(filename=name)
        # Directory bit in external attrs.
        info.external_attr = (0o40755 << 16) | 0x10
        zf.writestr(info, b"")
    return buf.getvalue()


# --------------------------------------------------------------------- #
# Negative fixtures (one per Section F rule).
# --------------------------------------------------------------------- #


def case_collision_zip() -> bytes:
    return _zip_with_files([("app/Foo.py", b"x"), ("app/foo.py", b"y")])


def separator_collision_zip() -> bytes:
    return _zip_with_files([("Lib/Foo.py", b"x"), (r"Lib\Foo.py", b"y")])


def reserved_name_bare_zip() -> bytes:
    return _zip_with_files([("CON", b"x")])


def reserved_name_with_extension_zip() -> bytes:
    return _zip_with_files([("CON.txt", b"x")])


def reserved_name_compound_zip() -> bytes:
    return _zip_with_files([("CON.foo.txt", b"x")])


def trailing_dot_zip() -> bytes:
    return _zip_with_files([("app/foo.", b"x")])


def trailing_space_zip() -> bytes:
    return _zip_with_files([("app/foo ", b"x")])


def file_directory_collision_zip() -> bytes:
    return _zip_with_files([("app/foo", b"x"), ("app/foo/bar.txt", b"y")])


def empty_segment_zip() -> bytes:
    return _zip_with_files([("app//foo.py", b"x")])


def dot_segment_zip() -> bytes:
    return _zip_with_files([("app/./foo.py", b"x")])


def double_dot_segment_zip() -> bytes:
    return _zip_with_files([("app/../foo.py", b"x")])


def triple_dot_segment_zip() -> bytes:
    # `...` ends in a dot → trailing-dot rule fires.
    return _zip_with_files([("app/.../foo.py", b"x")])


def control_character_zip() -> bytes:
    return _zip_with_files([("app/foo\x01bar.py", b"x")])


def absolute_path_zip() -> bytes:
    return _zip_with_files([("C:/foo", b"x")])


def unc_path_zip() -> bytes:
    return _zip_with_files([("//server/share/foo", b"x")])


def nt_device_path_zip() -> bytes:
    return _zip_with_files([("//?/C:/foo", b"x")])


def traversal_zip() -> bytes:
    return _zip_with_files([("../../escape.txt", b"x")])


def ads_zip() -> bytes:
    return _zip_with_files([("foo:bar.txt", b"x")])


def explicit_directory_entry_zip() -> bytes:
    return _zip_with_explicit_directory("runtime/python/")


# --------------------------------------------------------------------- #
# Synthetic runtime fixture (positive case).
# --------------------------------------------------------------------- #


def synthetic_runtime_payload() -> dict[str, bytes]:
    """Map of canonical (forward-slash) entry-name → payload bytes for
    the synthetic runtime fixture used by manifest-validation tests.

    The smoke list payload mirrors the canonical 12-module set. Sizes
    are real; SHAs are computed against these bytes.
    """
    smoke_bytes = (
        b"ssl\nsocket\nctypes\nasyncio\nnetmanager_agent\nwebsockets\n"
        b"netmiko\nparamiko\ncryptography\nbcrypt\nnacl\npsutil\n"
    )
    assert len(smoke_bytes) == 103, "canonical smoke list must be 103 bytes"
    return {
        "runtime/python/python.exe": b"\x4d\x5a" + b"\x00" * 64,
        "runtime/python/python312.dll": b"\x4d\x5a" + b"\x00" * 64,
        "runtime/python/python312._pth": (
            b"python312.zip\n.\nLib\\site-packages\n..\\..\\app\n\nimport site\n"
        ),
        "app/run_agent.py": b'# entrypoint\n',
        "app/netmanager_agent.py": b'# agent\n',
        "licenses/THIRD_PARTY_NOTICES.json": b'[]\n',
        "metadata/runtime-smoke-imports.txt": smoke_bytes,
    }


def synthetic_runtime_zip(*, source_date_epoch: int = 1_735_689_600) -> bytes:
    """Deterministic ZIP of the synthetic runtime payload."""
    entries = synthetic_runtime_payload()
    # MS-DOS 2-second resolution.
    bucket = source_date_epoch - (source_date_epoch % 2)
    import datetime
    dt = datetime.datetime.fromtimestamp(bucket, datetime.timezone.utc)
    dt_tuple = (dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for name in sorted(entries):
            info = zipfile.ZipInfo(filename=name)
            info.date_time = dt_tuple
            # 0o644 for files; PR #4 will set 0o755 for executables.
            info.external_attr = 0o644 << 16
            zf.writestr(info, entries[name])
    return buf.getvalue()


def synthetic_runtime_manifest(
    *,
    zip_bytes: bytes,
    source_date_epoch: int = 1_735_689_600,
    runtime_version: str = "1.0.0",
    python_version: str = "3.12.6",
    compatible_host_core_range: str = ">=2.0.0 <3.0.0",
) -> dict:
    """The detached manifest matching `synthetic_runtime_zip()`."""
    entries = synthetic_runtime_payload()
    files = []
    for name in sorted(entries):
        payload = entries[name]
        files.append({
            "path": name.replace("/", "\\"),
            "size": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest().upper(),
        })
    import datetime
    built_utc = (
        datetime.datetime.fromtimestamp(source_date_epoch, datetime.timezone.utc)
        .strftime("%Y-%m-%dT%H:%M:%SZ")
    )
    return {
        "schema_version": 1,
        "runtime_version": runtime_version,
        "python_version": python_version,
        "platform": "windows-amd64",
        "built_utc": built_utc,
        "embedded_python_source_sha256": "0" * 64
            and hashlib.sha256(b"embedded-python-fixture").hexdigest().upper(),
        "zip_size_bytes": len(zip_bytes),
        "zip_sha256": hashlib.sha256(zip_bytes).hexdigest().upper(),
        "compatible_host_core_range": compatible_host_core_range,
        "entrypoint": "app\\run_agent.py",
        "files": files,
    }


def synthetic_runtime_triplet() -> tuple[bytes, bytes, bytes]:
    """Return (zip_bytes, manifest_bytes, sha256_sidecar_bytes)."""
    z = synthetic_runtime_zip()
    manifest = synthetic_runtime_manifest(zip_bytes=z)
    manifest_json = json.dumps(
        manifest, sort_keys=True, indent=2, ensure_ascii=False
    ) + "\n"
    sha = hashlib.sha256(z).hexdigest().upper()
    sidecar = f"{sha}  charon-runtime-windows-amd64-1.0.0.zip\n"
    return z, manifest_json.encode("utf-8"), sidecar.encode("utf-8")


# Compatibility export for tests importing one-off helpers.
__all__ = [name for name in dir() if name.endswith("_zip") or name.startswith("synthetic_")]
