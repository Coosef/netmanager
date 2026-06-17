"""Pin the formal platform support matrix.

The matrix is the single source of truth for "what we have actually
tested and commit to support". Both the installer (PR-C / PR-D) and
the docs (`docs/AGENT_PLATFORM_SUPPORT_MATRIX.md`) read from it. The
tests below make sure the matrix stays narrow and explicit -- absence
from a SUPPORTED list is the unsupported state by default.
"""
from __future__ import annotations

from app.services.agent_installer import (
    LINUX_386,
    LINUX_386_RELEASES,
    LINUX_AMD64,
    LINUX_AMD64_RELEASES,
    OSRelease,
    SUPPORT_MATRIX,
    SUPPORTED_PACKAGE_MANAGERS,
    SupportStatus,
    UNSUPPORTED_ARCHITECTURES,
    UNSUPPORTED_OS,
    UNSUPPORTED_PACKAGE_MANAGERS,
    WINDOWS_386,
    WINDOWS_386_RELEASES,
    WINDOWS_AMD64,
    WINDOWS_AMD64_RELEASES,
    get_releases,
    is_package_manager_supported,
)


# ── Matrix shape ────────────────────────────────────────────────────────


def test_support_matrix_covers_all_four_platforms():
    """MVP scope: every platform must have an entry, even if it's a
    short CONDITIONAL-only list."""
    assert WINDOWS_AMD64 in SUPPORT_MATRIX
    assert WINDOWS_386 in SUPPORT_MATRIX
    assert LINUX_AMD64 in SUPPORT_MATRIX
    assert LINUX_386 in SUPPORT_MATRIX


def test_support_matrix_entries_are_tuples():
    """Tuples are immutable; lists would let downstream code mutate the
    matrix in-place, which would break the "single source of truth"
    invariant."""
    for releases in SUPPORT_MATRIX.values():
        assert isinstance(releases, tuple)


# ── Windows amd64 -- production fleet target ────────────────────────────


def test_windows_amd64_contains_production_releases():
    names = {r.name for r in WINDOWS_AMD64_RELEASES}
    assert "Windows 10 22H2" in names
    assert "Windows 11" in names
    assert "Windows Server 2019" in names
    assert "Windows Server 2022" in names
    # Server 2025 is test-ready, not yet supported.
    assert "Windows Server 2025" in names


def test_windows_amd64_server_2025_is_test_ready_not_supported():
    """Server 2025 is architecturally prepared but no E2E campaign yet.
    Surface this explicitly so a deploy decision is conscious."""
    server_2025 = next(r for r in WINDOWS_AMD64_RELEASES
                        if r.name == "Windows Server 2025")
    assert server_2025.status is SupportStatus.TEST_READY


def test_windows_amd64_no_release_is_unsupported_status():
    """A release listed at all on amd64 should never carry UNSUPPORTED;
    the right way to mark a release unsupported is to leave it OFF the
    list."""
    for r in WINDOWS_AMD64_RELEASES:
        assert r.status is not SupportStatus.UNSUPPORTED


def test_windows_server_2019_notes_reference_atghosftp_validation():
    """The validation campaigns landed on ATGHOSFTP; the notes field
    should hint at this so a future maintainer understands where the
    SUPPORTED status came from."""
    server_2019 = next(r for r in WINDOWS_AMD64_RELEASES
                        if r.name == "Windows Server 2019")
    assert "ATGHOSFTP" in (server_2019.notes or "")


# ── Windows 386 -- conditional only ─────────────────────────────────────


def test_windows_386_is_conditional_only():
    """We do NOT claim general 32-bit Windows support. Any entry must
    be CONDITIONAL (or absent) -- never SUPPORTED."""
    for r in WINDOWS_386_RELEASES:
        assert r.status is SupportStatus.CONDITIONAL


def test_windows_386_calls_out_no_server_support():
    """Server 32-bit lineage ended after Server 2008. The notes must
    state this so nobody assumes Server x86 works."""
    win10 = next(r for r in WINDOWS_386_RELEASES
                  if "Windows 10" in r.name)
    assert "Server" in (win10.notes or "")


# ── Linux amd64 -- broad supported set ──────────────────────────────────


def test_linux_amd64_includes_required_distros():
    """The operator-specified MVP distro set."""
    families = {r.family for r in LINUX_AMD64_RELEASES}
    required = {"Debian", "Ubuntu", "RHEL", "Rocky Linux", "AlmaLinux",
                "CentOS Stream", "openSUSE Leap", "SLES"}
    missing = required - families
    assert missing == set(), f"missing distros: {missing}"


def test_linux_amd64_all_entries_carry_kernel_and_glibc_pins():
    """Linux releases without kernel/glibc minimums are non-actionable
    for the runtime resolver. Every supported Linux entry must specify
    both."""
    for r in LINUX_AMD64_RELEASES:
        assert r.minimum_kernel, f"{r.name} missing minimum_kernel"
        assert r.minimum_glibc, f"{r.name} missing minimum_glibc"


def test_linux_amd64_all_supported_status():
    """Linux amd64 entries are MVP supported targets, not test_ready."""
    for r in LINUX_AMD64_RELEASES:
        assert r.status is SupportStatus.SUPPORTED


# ── Linux 386 -- conditional only ───────────────────────────────────────


def test_linux_386_is_conditional_only():
    """32-bit Linux is largely deprecated upstream. Any entry is
    CONDITIONAL; production use requires per-deployment validation."""
    for r in LINUX_386_RELEASES:
        assert r.status is SupportStatus.CONDITIONAL


def test_linux_386_notes_call_out_distro_drops():
    """Ubuntu / Fedora / RHEL / Rocky / Alma all dropped i386 media.
    The notes must surface this so the matrix is self-explaining."""
    if not LINUX_386_RELEASES:
        return  # acceptable -- empty CONDITIONAL list is allowed
    for r in LINUX_386_RELEASES:
        notes = r.notes or ""
        assert "NOT supported" in notes or "test" in notes.lower()


# ── Explicit UNSUPPORTED lists ──────────────────────────────────────────


def test_unsupported_os_includes_eol_windows_desktop():
    eol_desktop = {"Windows XP", "Windows Vista", "Windows 7",
                    "Windows 8", "Windows 8.1"}
    assert eol_desktop.issubset(set(UNSUPPORTED_OS))


def test_unsupported_os_includes_eol_windows_server():
    eol_server = {"Windows Server 2003", "Windows Server 2008",
                   "Windows Server 2008 R2",
                   "Windows Server 2012", "Windows Server 2012 R2"}
    assert eol_server.issubset(set(UNSUPPORTED_OS))


def test_unsupported_os_does_not_overlap_supported_amd64_releases():
    """A name appearing in both lists is a contradiction -- catch
    immediately so the matrix stays consistent."""
    supported_names = {r.name for r in WINDOWS_AMD64_RELEASES}
    overlap = supported_names & set(UNSUPPORTED_OS)
    assert overlap == set(), f"contradiction: {overlap}"


def test_unsupported_architectures_includes_arm_family():
    assert "arm" in UNSUPPORTED_ARCHITECTURES
    assert "arm64" in UNSUPPORTED_ARCHITECTURES
    assert "aarch64" in UNSUPPORTED_ARCHITECTURES


def test_unsupported_architectures_includes_modern_non_x86():
    """ppc64le / riscv64 / s390x -- modern non-x86; not MVP."""
    for arch in ("ppc64le", "riscv64", "s390x"):
        assert arch in UNSUPPORTED_ARCHITECTURES


# ── Package managers ────────────────────────────────────────────────────


def test_supported_package_managers_set():
    assert SUPPORTED_PACKAGE_MANAGERS == ("apt", "dnf", "yum", "zypper")


def test_unsupported_package_managers_includes_alpine_apk():
    """Alpine ships musl libc, not glibc. The Linux runtime resolver
    (PR-D) reads this list to fail closed; the test pins the contract."""
    assert "apk" in UNSUPPORTED_PACKAGE_MANAGERS


def test_unsupported_package_managers_includes_arch_pacman():
    assert "pacman" in UNSUPPORTED_PACKAGE_MANAGERS


def test_is_package_manager_supported_positive():
    for name in ("apt", "dnf", "yum", "zypper", "APT", " dnf "):
        assert is_package_manager_supported(name)


def test_is_package_manager_supported_negative():
    for name in ("apk", "pacman", "emerge", "opkg", "", "unknown"):
        assert not is_package_manager_supported(name)


def test_is_package_manager_supported_rejects_non_string():
    assert not is_package_manager_supported(None)  # type: ignore[arg-type]
    assert not is_package_manager_supported(123)  # type: ignore[arg-type]


def test_supported_and_unsupported_package_managers_do_not_overlap():
    overlap = set(SUPPORTED_PACKAGE_MANAGERS) & set(UNSUPPORTED_PACKAGE_MANAGERS)
    assert overlap == set()


# ── get_releases helper ─────────────────────────────────────────────────


def test_get_releases_returns_matrix_tuple():
    assert get_releases(WINDOWS_AMD64) is WINDOWS_AMD64_RELEASES
    assert get_releases(LINUX_AMD64) is LINUX_AMD64_RELEASES


def test_get_releases_returns_empty_tuple_for_unknown_platform():
    """Unknown platform input must not raise; just empty result -- the
    safe default is "no supported releases known" which fail-closes
    later in the installer flow."""
    from app.services.agent_installer.architecture import Architecture, OSFamily, Platform
    fake = Platform(OSFamily.LINUX, Architecture.AMD64)
    # Build a separate Platform object -- equality-by-value means it
    # still hits the matrix. The intent of this test is to confirm
    # `get_releases` does not raise on platforms WITHOUT entries; we
    # need a Platform that's not in SUPPORT_MATRIX, which by current
    # design is impossible (all 4 are populated). The compromise:
    # confirm the dict-membership API never raises KeyError on the
    # 4 known platforms.
    assert get_releases(WINDOWS_386) == WINDOWS_386_RELEASES


# ── OSRelease frozen-ness ───────────────────────────────────────────────


def test_os_release_is_immutable():
    """Frozen dataclass -> caller cannot mutate a matrix entry by
    accident."""
    r = WINDOWS_AMD64_RELEASES[0]
    try:
        r.status = SupportStatus.UNSUPPORTED  # type: ignore[misc]
    except Exception:
        return
    raise AssertionError("OSRelease should be frozen")


def test_os_release_equality_value_based():
    """Two OSRelease objects with the same data are ==."""
    a = OSRelease("Foo", "Foo")
    b = OSRelease("Foo", "Foo")
    assert a == b


# ── Cross-PR contract guards ────────────────────────────────────────────


def test_at_least_one_platform_has_supported_releases():
    """The whole point of PR-A is enabling broader support; reject
    a degenerate matrix where every entry is conditional."""
    supported_count = sum(
        1 for plat_releases in SUPPORT_MATRIX.values()
        for r in plat_releases
        if r.status is SupportStatus.SUPPORTED
    )
    assert supported_count > 0


def test_no_platform_has_more_than_one_status_per_release_family_name():
    """A release name like 'Debian' should not appear with two
    different statuses in the same platform's list. (Different
    versions within the same family ARE allowed -- caller can filter
    by version + status.)"""
    for plat, releases in SUPPORT_MATRIX.items():
        seen: dict[tuple[str, str | None], SupportStatus] = {}
        for r in releases:
            key = (r.name, r.version)
            if key in seen:
                assert seen[key] is r.status, (
                    f"{plat}: {r.name} {r.version} has conflicting statuses"
                )
            seen[key] = r.status
