"""ZIP namespace safety tests — every named negative fixture rejected.

For each fixture we materialize the ZIP, iterate its entries through
the same `CanonicalPathSet` the runtime ZIP wrapper will use, and
assert the expected rule code fires.

The synthetic positive fixture passes the full per-entry walk without
raising.
"""
from __future__ import annotations

import io
import zipfile

import pytest

from app.services.windows_runtime.canonical_path import (
    CanonicalPathError,
    CanonicalPathRule,
    CanonicalPathSet,
)
from tests.win_integrate.fixtures import build_fixtures as F


def _walk_zip(zip_bytes: bytes) -> list[zipfile.ZipInfo]:
    return list(zipfile.ZipFile(io.BytesIO(zip_bytes)).infolist())


def _run_canonical_pipeline(zip_bytes: bytes) -> None:
    """Apply the same Section F walk the runtime wrapper applies.

    Raises the FIRST canonical-path error encountered.
    """
    seen = CanonicalPathSet()
    for entry in _walk_zip(zip_bytes):
        # Explicit-directory entries — name ends in `/` or external-attrs
        # carry the directory bit (0x10).
        is_dir = (
            entry.filename.endswith("/")
            or entry.filename.endswith("\\")
            or (entry.external_attr & 0x10) == 0x10
        )
        seen.add(entry.filename, is_explicit_directory_entry=is_dir)


# --------------------------------------------------------------------- #
# Negative fixture matrix.
# --------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "builder, expected_code",
    [
        (F.case_collision_zip, CanonicalPathRule.DUPLICATE_CANONICAL_KEY),
        (F.separator_collision_zip, CanonicalPathRule.DUPLICATE_CANONICAL_KEY),
        (F.reserved_name_bare_zip, CanonicalPathRule.RESERVED_DEVICE_NAME),
        (F.reserved_name_with_extension_zip, CanonicalPathRule.RESERVED_DEVICE_NAME),
        (F.reserved_name_compound_zip, CanonicalPathRule.RESERVED_DEVICE_NAME),
        (F.trailing_dot_zip, CanonicalPathRule.TRAILING_DOT),
        (F.trailing_space_zip, CanonicalPathRule.TRAILING_SPACE),
        (F.file_directory_collision_zip, CanonicalPathRule.FILE_DIRECTORY_COLLISION),
        (F.empty_segment_zip, CanonicalPathRule.EMPTY_SEGMENT),
        (F.dot_segment_zip, CanonicalPathRule.DOT_SEGMENT),
        (F.double_dot_segment_zip, CanonicalPathRule.DOTDOT_SEGMENT),
        (F.triple_dot_segment_zip, CanonicalPathRule.TRAILING_DOT),
        (F.control_character_zip, CanonicalPathRule.CONTROL_CHAR),
        (F.absolute_path_zip, CanonicalPathRule.DRIVE_LETTER),
        (F.unc_path_zip, CanonicalPathRule.UNC),
        (F.nt_device_path_zip, CanonicalPathRule.NT_DEVICE),
        (F.traversal_zip, CanonicalPathRule.DOTDOT_SEGMENT),
        (F.ads_zip, CanonicalPathRule.COLON_IN_SEGMENT),
        (F.explicit_directory_entry_zip, CanonicalPathRule.EXPLICIT_DIRECTORY_ENTRY),
    ],
)
def test_named_fixture_rejected(builder, expected_code):
    with pytest.raises(CanonicalPathError) as excinfo:
        _run_canonical_pipeline(builder())
    assert excinfo.value.code == expected_code, (
        f"{builder.__name__}: expected {expected_code}, got {excinfo.value.code}"
    )


# --------------------------------------------------------------------- #
# Positive synthetic runtime fixture passes the full walk.
# --------------------------------------------------------------------- #


def test_synthetic_runtime_fixture_passes_pipeline():
    z = F.synthetic_runtime_zip()
    # Should NOT raise.
    _run_canonical_pipeline(z)
