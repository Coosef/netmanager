"""Windows-aware ZIP and manifest path canonicalization.

Section F of the architecture plan. The same canonicalization runs
against:
  - every ZIP entry path produced by the bundle ZIP (the wrapper
    rejects entries with named errors),
  - every manifest `files[].path` value (the backend integrity check
    refuses any path that fails canonicalization).

The function returns the canonical key (separator `\\`) OR raises a
`CanonicalPathError` whose `code` field names the specific rule that
fired. Callers MAY map the code to a user-facing message; tests check
`code` directly.

All rules are explicit (no implicit folding into "ends in . / contains :")
per correction #68. Trailing space, control characters, NT device
paths, ADS markers, reserved Windows device names, file-vs-directory
collisions, and explicit-directory ZIP entries are each rejected with
their own named code.
"""
from __future__ import annotations

import re
from dataclasses import dataclass


# All rule codes. Keep these stable — they're test fixtures.
class CanonicalPathRule:
    EMPTY = "empty_path"
    LEADING_SEPARATOR = "leading_separator"
    DRIVE_LETTER = "drive_letter"
    UNC = "unc"
    NT_DEVICE = "nt_device"
    EMPTY_SEGMENT = "empty_segment"
    DOT_SEGMENT = "dot_segment"
    DOTDOT_SEGMENT = "dotdot_segment"
    CONTROL_CHAR = "control_char"
    TRAILING_DOT = "trailing_dot"
    TRAILING_SPACE = "trailing_space"
    COLON_IN_SEGMENT = "colon_in_segment"
    RESERVED_DEVICE_NAME = "reserved_device_name"
    DUPLICATE_CANONICAL_KEY = "duplicate_canonical_key"
    FILE_DIRECTORY_COLLISION = "file_directory_collision"
    EXPLICIT_DIRECTORY_ENTRY = "explicit_directory_entry"


class CanonicalPathError(ValueError):
    """Named-code rejection from the canonicalization pipeline."""

    def __init__(self, code: str, message: str, *, path: str = "") -> None:
        super().__init__(f"{code}: {message} (path={path!r})")
        self.code = code
        self.path = path
        self.detail = message


_RESERVED_DEVICE_NAME_RE = re.compile(
    r"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$",
    re.IGNORECASE,
)
_DRIVE_LETTER_PREFIX_RE = re.compile(r"^[A-Za-z]:")


def _has_control_char(segment: str) -> bool:
    for ch in segment:
        cp = ord(ch)
        if cp <= 0x1F or cp == 0x7F:
            return True
    return False


def canonicalize(path: str) -> str:
    """Apply Section F steps 1–8 to a path. Returns the canonical key.

    Raises `CanonicalPathError` (with `code`) on the first failed rule.
    Step 9 (duplicate-key) and step 10 (file-vs-dir collision) are NOT
    applied here; they require a state-bearing set tracker — see
    `CanonicalPathSet`.
    """
    if path is None or path == "":
        raise CanonicalPathError(
            CanonicalPathRule.EMPTY, "path is empty or null", path=path or ""
        )
    # Step 1: / → \
    normalized = path.replace("/", "\\")
    # Step 3 / step 4: reject leading separators, drive letters, UNC,
    # NT device paths. (Performed before splitting so we don't lose the
    # diagnostic.)
    if normalized.startswith("\\\\?\\") or normalized.startswith("\\\\.\\"):
        raise CanonicalPathError(
            CanonicalPathRule.NT_DEVICE,
            "NT device path is rejected",
            path=path,
        )
    if normalized.startswith("\\\\"):
        raise CanonicalPathError(
            CanonicalPathRule.UNC,
            "UNC path is rejected",
            path=path,
        )
    if normalized.startswith("\\"):
        raise CanonicalPathError(
            CanonicalPathRule.LEADING_SEPARATOR,
            "absolute / leading-separator paths are rejected",
            path=path,
        )
    if _DRIVE_LETTER_PREFIX_RE.match(normalized):
        raise CanonicalPathError(
            CanonicalPathRule.DRIVE_LETTER,
            "drive-letter prefix is rejected",
            path=path,
        )
    # Step 4: split on \
    segments = normalized.split("\\")
    # Step 5: per-segment rules.
    for segment in segments:
        _validate_segment(segment, path=path)
    # Step 6: recombine.
    return "\\".join(segments)


def _validate_segment(segment: str, *, path: str) -> None:
    if segment == "":
        raise CanonicalPathError(
            CanonicalPathRule.EMPTY_SEGMENT,
            "empty segment (e.g. consecutive separators)",
            path=path,
        )
    if segment == ".":
        raise CanonicalPathError(
            CanonicalPathRule.DOT_SEGMENT,
            "`.` segment is rejected",
            path=path,
        )
    if segment == "..":
        raise CanonicalPathError(
            CanonicalPathRule.DOTDOT_SEGMENT,
            "`..` segment is rejected",
            path=path,
        )
    if _has_control_char(segment):
        raise CanonicalPathError(
            CanonicalPathRule.CONTROL_CHAR,
            "segment contains a control character (0x00-0x1F or 0x7F)",
            path=path,
        )
    if segment.endswith("."):
        raise CanonicalPathError(
            CanonicalPathRule.TRAILING_DOT,
            "segment ends in `.` (Windows silently strips trailing dots)",
            path=path,
        )
    if segment.endswith(" "):
        raise CanonicalPathError(
            CanonicalPathRule.TRAILING_SPACE,
            "segment ends in U+0020 SPACE (Windows silently strips trailing spaces)",
            path=path,
        )
    if ":" in segment:
        raise CanonicalPathError(
            CanonicalPathRule.COLON_IN_SEGMENT,
            "segment contains `:` (ADS marker)",
            path=path,
        )
    # Reserved Windows device name (FIRST-dot base name; correction #29).
    base = segment.split(".", 1)[0] if "." in segment else segment
    if _RESERVED_DEVICE_NAME_RE.match(base):
        raise CanonicalPathError(
            CanonicalPathRule.RESERVED_DEVICE_NAME,
            f"reserved Windows device name {base!r} (case-insensitive)",
            path=path,
        )


# --------------------------------------------------------------------- #
# Set tracker — steps 7 + 8 (duplicate canonical key + file-vs-directory
# collision). Stateful because the rule fires across multiple entries.
# --------------------------------------------------------------------- #


@dataclass
class CanonicalPathSet:
    """Track canonical keys across a ZIP / manifest's full entry set.

    `add()` runs canonicalize() then enforces:
      - case-insensitive duplicate
      - separator-normalization duplicate (subsumed by canonicalize())
      - file-vs-directory collision (this set tracks every PARENT
        directory implied by seen file paths; a new entry whose key
        equals a seen parent, or whose key has a seen file as a strict
        prefix-with-separator, is rejected)
      - explicit-directory ZIP entry (caller signals via
        `is_explicit_directory_entry`)
    """

    _seen: dict[str, str] = None  # canonical-lower → original canonical
    _parent_dirs: set[str] = None  # canonical-lower of every parent

    def __post_init__(self) -> None:
        self._seen = {}
        self._parent_dirs = set()

    def add(
        self,
        path: str,
        *,
        is_explicit_directory_entry: bool = False,
    ) -> str:
        """Add `path` to the set. Returns the canonical key on success."""
        if is_explicit_directory_entry:
            raise CanonicalPathError(
                CanonicalPathRule.EXPLICIT_DIRECTORY_ENTRY,
                "explicit ZIP directory entry is rejected",
                path=path,
            )
        canonical = canonicalize(path)
        key = canonical.lower()
        if key in self._seen:
            raise CanonicalPathError(
                CanonicalPathRule.DUPLICATE_CANONICAL_KEY,
                "case-insensitive / separator-normalization duplicate",
                path=path,
            )
        if key in self._parent_dirs:
            raise CanonicalPathError(
                CanonicalPathRule.FILE_DIRECTORY_COLLISION,
                "this file path collides with a parent directory of a "
                "previously seen entry",
                path=path,
            )
        # If this new entry is a STRICT prefix of any seen file
        # (`old.lower().startswith(key + "\\")`), the new file is a
        # parent of an existing one — also a collision.
        for seen_key in self._seen:
            if seen_key.startswith(key + "\\"):
                raise CanonicalPathError(
                    CanonicalPathRule.FILE_DIRECTORY_COLLISION,
                    "this path serves as a directory of a previously "
                    "seen file entry",
                    path=path,
                )
            if key.startswith(seen_key + "\\"):
                raise CanonicalPathError(
                    CanonicalPathRule.FILE_DIRECTORY_COLLISION,
                    "this path uses a previously seen file as its parent",
                    path=path,
                )
        # Register the file + all of its implied parent directories.
        self._seen[key] = canonical
        parts = canonical.split("\\")
        for i in range(1, len(parts)):
            self._parent_dirs.add("\\".join(parts[:i]).lower())
        return canonical

    def __contains__(self, path: str) -> bool:
        try:
            return canonicalize(path).lower() in self._seen
        except CanonicalPathError:
            return False

    def __len__(self) -> int:
        return len(self._seen)
