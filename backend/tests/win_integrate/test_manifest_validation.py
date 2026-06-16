"""Detached runtime-bundle manifest schema tests.

The Pydantic `Manifest` schema must:
  - accept the synthetic fixture manifest (positive case),
  - reject duplicate canonical `files[].path` entries,
  - reject path-format violations (per Section F),
  - reject unsupported schema_version / platform / version shapes,
  - require `metadata\\runtime-smoke-imports.txt` AND the entrypoint in
    `files[]`.
"""
from __future__ import annotations

import hashlib

import pytest
from pydantic import ValidationError

from app.services.windows_runtime.manifest import Manifest
from tests.win_integrate.fixtures.build_fixtures import (
    synthetic_runtime_manifest,
    synthetic_runtime_zip,
)


@pytest.fixture
def valid_manifest_dict():
    z = synthetic_runtime_zip()
    return synthetic_runtime_manifest(zip_bytes=z)


# --------------------------------------------------------------------- #
# Positive.
# --------------------------------------------------------------------- #


def test_accepts_synthetic_manifest(valid_manifest_dict):
    m = Manifest(**valid_manifest_dict)
    assert m.schema_version == 1
    assert m.python_version == "3.12.6"
    assert m.platform == "windows-amd64"
    assert m.entrypoint == r"app\run_agent.py"


# --------------------------------------------------------------------- #
# Negatives.
# --------------------------------------------------------------------- #


def test_rejects_duplicate_canonical_paths(valid_manifest_dict):
    valid_manifest_dict["files"].append(
        # Case-different duplicate of the existing entry.
        {
            "path": r"App\Run_Agent.py",
            "size": 1,
            "sha256": hashlib.sha256(b"x").hexdigest().upper(),
        }
    )
    with pytest.raises(ValidationError) as exc_info:
        Manifest(**valid_manifest_dict)
    assert "files" in str(exc_info.value).lower() or "duplicate" in str(exc_info.value).lower()


def test_rejects_path_with_traversal(valid_manifest_dict):
    valid_manifest_dict["files"][0]["path"] = r"..\escape.py"
    with pytest.raises(ValidationError):
        Manifest(**valid_manifest_dict)


def test_rejects_path_with_forward_slash(valid_manifest_dict):
    # `files[].path` must be already-canonical (separator = `\`); a raw
    # forward-slash path is invalid even if it would normalize.
    valid_manifest_dict["files"][0]["path"] = "app/run_agent.py"
    with pytest.raises(ValidationError):
        Manifest(**valid_manifest_dict)


def test_rejects_unsupported_schema_version(valid_manifest_dict):
    valid_manifest_dict["schema_version"] = 2
    with pytest.raises(ValidationError):
        Manifest(**valid_manifest_dict)


def test_rejects_non_amd64_platform(valid_manifest_dict):
    valid_manifest_dict["platform"] = "linux-amd64"
    with pytest.raises(ValidationError):
        Manifest(**valid_manifest_dict)


def test_rejects_bad_built_utc(valid_manifest_dict):
    valid_manifest_dict["built_utc"] = "2026-06-12 00:00:00"
    with pytest.raises(ValidationError):
        Manifest(**valid_manifest_dict)


def test_rejects_lowercase_zip_sha256(valid_manifest_dict):
    valid_manifest_dict["zip_sha256"] = valid_manifest_dict["zip_sha256"].lower()
    with pytest.raises(ValidationError):
        Manifest(**valid_manifest_dict)


def test_rejects_unsupported_core_range(valid_manifest_dict):
    valid_manifest_dict["compatible_host_core_range"] = "^2.0.0"
    with pytest.raises(ValidationError):
        Manifest(**valid_manifest_dict)


def test_rejects_missing_smoke_list_entry(valid_manifest_dict):
    valid_manifest_dict["files"] = [
        entry
        for entry in valid_manifest_dict["files"]
        if entry["path"] != r"metadata\runtime-smoke-imports.txt"
    ]
    with pytest.raises(ValidationError) as exc_info:
        Manifest(**valid_manifest_dict)
    assert "smoke" in str(exc_info.value).lower() or "metadata" in str(exc_info.value).lower()


def test_rejects_missing_entrypoint_entry(valid_manifest_dict):
    valid_manifest_dict["files"] = [
        entry
        for entry in valid_manifest_dict["files"]
        if entry["path"] != r"app\run_agent.py"
    ]
    with pytest.raises(ValidationError) as exc_info:
        Manifest(**valid_manifest_dict)
    assert "entrypoint" in str(exc_info.value).lower()


def test_rejects_extra_top_level_field(valid_manifest_dict):
    valid_manifest_dict["extra_field"] = "no"
    with pytest.raises(ValidationError):
        Manifest(**valid_manifest_dict)


# ============================================================================
# PR-A foundation: optional cross-platform fields on Manifest.
#
# Five new optional fields default to None on every existing
# windows-amd64 manifest. Existing Windows runtime manifests (produced
# by ops/windows-runtime-bundle/build.py) MUST continue to validate
# unchanged. Future PRs populate the optional fields for Linux + 386
# bundles.
# ============================================================================


def test_legacy_manifest_without_cross_platform_fields_still_valid(valid_manifest_dict):
    """The valid_manifest_dict fixture carries the legacy field set
    only. Validation must succeed without the new optional fields --
    that is the backward-compat invariant PR-A commits to."""
    m = Manifest(**valid_manifest_dict)
    assert m.architecture is None
    assert m.os_family is None
    assert m.minimum_os_version is None
    assert m.minimum_kernel is None
    assert m.minimum_glibc is None


def test_manifest_accepts_architecture_field(valid_manifest_dict):
    """When present, `architecture` carries the Go-convention string."""
    valid_manifest_dict["architecture"] = "amd64"
    m = Manifest(**valid_manifest_dict)
    assert m.architecture == "amd64"


def test_manifest_accepts_os_family_field(valid_manifest_dict):
    valid_manifest_dict["os_family"] = "windows"
    m = Manifest(**valid_manifest_dict)
    assert m.os_family == "windows"


def test_manifest_accepts_minimum_os_version_field(valid_manifest_dict):
    valid_manifest_dict["minimum_os_version"] = "Windows Server 2019"
    m = Manifest(**valid_manifest_dict)
    assert m.minimum_os_version == "Windows Server 2019"


def test_manifest_accepts_linux_kernel_and_glibc_fields(valid_manifest_dict):
    """On Linux manifests, kernel and glibc minimums describe the
    syscall + crypto surface the private runtime needs."""
    valid_manifest_dict["minimum_kernel"] = "5.10"
    valid_manifest_dict["minimum_glibc"] = "2.31"
    m = Manifest(**valid_manifest_dict)
    assert m.minimum_kernel == "5.10"
    assert m.minimum_glibc == "2.31"


def test_manifest_accepts_all_five_optional_fields_together(valid_manifest_dict):
    valid_manifest_dict["architecture"] = "amd64"
    valid_manifest_dict["os_family"] = "linux"
    valid_manifest_dict["minimum_os_version"] = "Ubuntu 20.04+"
    valid_manifest_dict["minimum_kernel"] = "5.4"
    valid_manifest_dict["minimum_glibc"] = "2.31"
    m = Manifest(**valid_manifest_dict)
    assert m.architecture == "amd64"
    assert m.os_family == "linux"
    assert m.minimum_os_version == "Ubuntu 20.04+"
    assert m.minimum_kernel == "5.4"
    assert m.minimum_glibc == "2.31"


def test_manifest_still_rejects_non_amd64_platform_field(valid_manifest_dict):
    """The existing `platform` validator still rejects anything other
    than `windows-amd64`. PR-A does not enable Linux/386 platform
    strings on the validator -- that is PR-D / PR-E scope."""
    valid_manifest_dict["platform"] = "linux-amd64"
    with pytest.raises(ValidationError):
        Manifest(**valid_manifest_dict)


def test_manifest_still_rejects_truly_extra_top_level_field(valid_manifest_dict):
    """The new optional fields must NOT loosen the `extra=forbid`
    contract for unknown top-level fields. Anything outside the
    explicit schema is still rejected."""
    valid_manifest_dict["random_new_thing"] = "no"
    with pytest.raises(ValidationError):
        Manifest(**valid_manifest_dict)
