"""Detached runtime-bundle manifest schema.

Pydantic v2 schema for the JSON document the backend serves at
`/api/v1/agents/{id}/download/runtime/windows-amd64/manifest` and that
the installer downloads at Stage 4. Schema mirrors Section C.2 of the
architecture plan.

Validators enforce, in addition to the field types:

  - every `files[].path` passes `canonical_path.canonicalize()`,
  - no duplicate canonical keys in `files`,
  - `compatible_host_core_range` parses under the restricted grammar
    (Section C.3),
  - `zip_sha256`, `embedded_python_source_sha256`, and every
    `files[].sha256` are 64-character UPPER-CASE hex,
  - the `metadata\\runtime-smoke-imports.txt` entry exists,
  - `schema_version == 1` (the only currently-supported version).
"""
from __future__ import annotations

import re
from typing import Annotated, Optional

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

from .canonical_path import (
    CanonicalPathError,
    CanonicalPathSet,
    canonicalize,
)
from .core_range import CoreRangeError, parse_core_range


_HEX64_UPPER_RE = re.compile(r"^[0-9A-F]{64}$")

Hex64Upper = Annotated[
    str,
    StringConstraints(pattern=r"^[0-9A-F]{64}$"),
]


class ManifestFileEntry(BaseModel):
    """A single inventory entry in the manifest's `files` array."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    path: str
    size: int = Field(ge=0)
    sha256: Hex64Upper

    @field_validator("path")
    @classmethod
    def _canonical_path(cls, value: str) -> str:
        try:
            canonical = canonicalize(value)
        except CanonicalPathError as err:
            raise ValueError(f"files[].path rejected: {err}") from err
        if canonical != value:
            raise ValueError(
                f"files[].path {value!r} is not in canonical form; "
                f"expected {canonical!r} (separator must be `\\\\`, no "
                f"normalization needed)"
            )
        return value


class Manifest(BaseModel):
    """Top-level detached runtime-bundle manifest."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: int = Field(ge=1)
    runtime_version: str
    python_version: str
    platform: str
    built_utc: str
    embedded_python_source_sha256: Hex64Upper
    zip_size_bytes: int = Field(ge=0)
    zip_sha256: Hex64Upper
    compatible_host_core_range: str
    entrypoint: str
    files: list[ManifestFileEntry]

    # ── Optional cross-platform fields (PR-A foundation) ──────────────
    # Added for the multi-PR cross-platform installer refactor. All
    # default to None so existing Windows amd64 manifests produced by
    # ops/windows-runtime-bundle/build.py validate UNCHANGED. Future
    # PRs (PR-C / PR-D) populate these for new architectures + Linux.
    #
    # When present, the values are normalised via
    # `backend/app/services/agent_installer/architecture.py` so the
    # canonical-string form ("windows-amd64", "linux-386") is the
    # single source of truth.
    architecture: Optional[str] = None
    os_family: Optional[str] = None
    minimum_os_version: Optional[str] = None
    minimum_kernel: Optional[str] = None
    minimum_glibc: Optional[str] = None

    # The metadata entry MUST exist (correction #34 — the deployed
    # runtime reads its smoke list from this path).
    _REQUIRED_METADATA_PATH = "metadata\\runtime-smoke-imports.txt"

    @field_validator("schema_version")
    @classmethod
    def _supported_schema(cls, value: int) -> int:
        if value != 1:
            raise ValueError(
                f"schema_version {value} not supported (only 1)"
            )
        return value

    @field_validator("platform")
    @classmethod
    def _platform(cls, value: str) -> str:
        if value != "windows-amd64":
            raise ValueError(
                f"platform {value!r} not supported (only `windows-amd64`)"
            )
        return value

    @field_validator("python_version")
    @classmethod
    def _python_version(cls, value: str) -> str:
        if not re.fullmatch(r"\d+\.\d+\.\d+", value):
            raise ValueError(
                f"python_version {value!r} must be N.N.N"
            )
        return value

    @field_validator("runtime_version")
    @classmethod
    def _runtime_version(cls, value: str) -> str:
        if not re.fullmatch(r"\d+\.\d+\.\d+", value):
            raise ValueError(
                f"runtime_version {value!r} must be N.N.N"
            )
        return value

    @field_validator("built_utc")
    @classmethod
    def _built_utc(cls, value: str) -> str:
        if not re.fullmatch(
            r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", value
        ):
            raise ValueError(
                f"built_utc {value!r} must be ISO-8601 UTC `YYYY-MM-DDTHH:MM:SSZ`"
            )
        return value

    @field_validator("compatible_host_core_range")
    @classmethod
    def _core_range(cls, value: str) -> str:
        try:
            parse_core_range(value)
        except CoreRangeError as err:
            raise ValueError(f"compatible_host_core_range rejected: {err}") from err
        return value

    @field_validator("entrypoint")
    @classmethod
    def _entrypoint_canonical(cls, value: str) -> str:
        try:
            canonical = canonicalize(value)
        except CanonicalPathError as err:
            raise ValueError(f"entrypoint rejected: {err}") from err
        if canonical != value:
            raise ValueError(
                f"entrypoint {value!r} is not in canonical form (separator must be `\\\\`)"
            )
        return value

    @model_validator(mode="after")
    def _check_files(self) -> "Manifest":
        if not self.files:
            raise ValueError("files[] is empty")
        seen = CanonicalPathSet()
        for entry in self.files:
            try:
                seen.add(entry.path)
            except CanonicalPathError as err:
                raise ValueError(
                    f"files[] inventory rejection: {err}"
                ) from err
        if self._REQUIRED_METADATA_PATH not in seen:
            raise ValueError(
                f"files[] must include {self._REQUIRED_METADATA_PATH!r} "
                f"(the deployed smoke list)"
            )
        # entrypoint must also appear in the inventory.
        if self.entrypoint not in seen:
            raise ValueError(
                f"entrypoint {self.entrypoint!r} is not present in files[]"
            )
        return self
