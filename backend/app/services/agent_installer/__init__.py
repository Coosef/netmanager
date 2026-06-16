"""Cross-platform agent-installer architecture model + support matrix.

This package is the foundation for the multi-PR cross-platform agent
installer refactor (Windows amd64 + 386, Linux amd64 + 386, each with
a private embedded runtime). It carries only data-model types and the
formal platform support matrix; no runtime behavior change ships in
this layer. Existing Windows amd64 install/runtime flow and the Linux
installer template are untouched.

See:
  - docs/AGENT_INSTALLER_ARCHITECTURE.md
  - docs/AGENT_PLATFORM_SUPPORT_MATRIX.md
  - docs/adr/ADR-001-SELF-CONTAINED-AGENT-RUNTIME.md
"""

from .architecture import (
    ALL_PLATFORMS,
    Architecture,
    LINUX_386,
    LINUX_AMD64,
    OSFamily,
    Platform,
    WINDOWS_386,
    WINDOWS_AMD64,
    parse_architecture,
    parse_os_family,
    parse_platform_string,
)
from .support_matrix import (
    LINUX_386_RELEASES,
    LINUX_AMD64_RELEASES,
    OSRelease,
    SUPPORT_MATRIX,
    SUPPORTED_PACKAGE_MANAGERS,
    SupportStatus,
    UNSUPPORTED_ARCHITECTURES,
    UNSUPPORTED_OS,
    UNSUPPORTED_PACKAGE_MANAGERS,
    WINDOWS_386_RELEASES,
    WINDOWS_AMD64_RELEASES,
    get_releases,
    is_package_manager_supported,
)

__all__ = [
    "ALL_PLATFORMS",
    "Architecture",
    "LINUX_386",
    "LINUX_386_RELEASES",
    "LINUX_AMD64",
    "LINUX_AMD64_RELEASES",
    "OSFamily",
    "OSRelease",
    "Platform",
    "SUPPORT_MATRIX",
    "SUPPORTED_PACKAGE_MANAGERS",
    "SupportStatus",
    "UNSUPPORTED_ARCHITECTURES",
    "UNSUPPORTED_OS",
    "UNSUPPORTED_PACKAGE_MANAGERS",
    "WINDOWS_386",
    "WINDOWS_386_RELEASES",
    "WINDOWS_AMD64",
    "WINDOWS_AMD64_RELEASES",
    "get_releases",
    "is_package_manager_supported",
    "parse_architecture",
    "parse_os_family",
    "parse_platform_string",
]
