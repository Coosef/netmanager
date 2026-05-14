"""Shared utility functions (no external dependencies)."""
import re

_PATH_ID_RE = re.compile(r"/\d+")


def normalize_path(path: str) -> str:
    """Replace numeric path segments with {id} to limit Prometheus label cardinality.

    Example: /api/v1/devices/42/interfaces/7 → /api/v1/devices/{id}/interfaces/{id}
    """
    return _PATH_ID_RE.sub("/{id}", path)
