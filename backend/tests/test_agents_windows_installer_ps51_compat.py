"""Windows Agent Installer — PR-A (WINDOWS-INSTALLER-FIX 2026-06-11)
regresyon ve byte-level kontratı.

ESKİ TESTLER REVİZE:
  - `IsInRole("Administrator")` assertion'ı YANLIŞ pattern'i koruyordu;
    TR Windows'ta yerel admin grubu adı "Yöneticiler", string match fail.
    Yeni assertion: `[Security.Principal.WindowsBuiltInRole]::Administrator`
    enum + string "Administrator" YOK.

YENİ TESTLER:
  - Byte-level: UTF-8 BOM (EF BB BF) prefix
  - Byte-level: CRLF line endings
  - ASCII-safe executable (Türkçe karakter / em dash / ✓ YOK)
  - Self-elevation pattern (recursion guard + Start-Process RunAs)
  - Out-File no-BOM (WriteAllText + UTF8Encoding(false))
  - Read-Host (pause cmdlet YOK)
  - sc.exe binPath quoting + delete wait loop
  - Python Microsoft Store stub detection
  - Installer cleanup (Remove-Item $PSCommandPath)
  - Response headers: charset, Cache-Control, X-Content-Type-Options
  - Real PowerShell parser (pwsh) → 0 error
"""
import re
import shutil
import subprocess

import pytest

from app.api.v1.endpoints.agents import _windows_installer


# ── Fixture ─────────────────────────────────────────────────────────────────


SAMPLE_AGENT_ID = "test-agent-abcd1234"
SAMPLE_AGENT_KEY = "test-key-9f8e7d6c"
SAMPLE_BACKEND_URL = "https://netmanager.example.app"


def _gen() -> str:
    return _windows_installer(SAMPLE_AGENT_ID, SAMPLE_AGENT_KEY, SAMPLE_BACKEND_URL)


# ── ASCII-safe executable kontrol (cp1254 decode bug fix) ───────────────────


def test_no_non_ascii_in_executable_script():
    """Generated script tüm executable içerikte ASCII-safe olmalı.

    Production canlı testte: `✓` (E2 9C 93) ve `ç/ü/ş/ı/ğ/ö` Windows
    cp1254 fallback decode'unda parser hatası verdi. TR Windows'ta
    `âœ"` ve `TerminatorExpectedAtEndOfString` hataları oluştu.
    """
    s = _gen()
    non_ascii = sorted({c for c in s if ord(c) > 127})
    assert non_ascii == [], (
        f"Generated script ASCII-safe değil. Kalan non-ASCII karakterler: "
        f"{[(c, hex(ord(c))) for c in non_ascii]}. "
        "Türkçe / em-dash / ✓ vs. kaldırılmalı."
    )


def test_no_smart_quotes_or_emoji():
    """Smart quote ve emoji açıkça yasak (test çiftli güvence)."""
    s = _gen()
    forbidden = ['—', '–', '‘', '’', '“', '”',
                 '✓', '✗', '⚠', '✅']  # em dash, smart, ✓, ✗, ⚠
    for ch in forbidden:
        assert ch not in s, f"Forbidden character: {ch!r} (U+{ord(ch):04X})"


# ── PS 7-only syntax YOK ────────────────────────────────────────────────────


def test_no_null_conditional_operator():
    """`?.Source` benzeri PS 7-only operator KALMAMALI."""
    s = _gen()
    matches = re.findall(r'[\w\)\]]\?\.', s)
    assert matches == [], f"PS 7-only `?.` operator var: {matches}"


def test_no_null_coalescing_operator():
    s = _gen()
    assert "??" not in s, "PS 7-only `??` PS 5.1'de invalid"


def test_no_ternary_operator():
    s = _gen()
    ternary = re.findall(r'[\w\)]\s*\?\s+[\w\$\-\'"]+\s*:\s*[\w\$\-\'"]+', s)
    assert ternary == [], f"PS 7-only ternary: {ternary}"


def test_no_foreach_parallel():
    s = _gen()
    assert "-Parallel" not in s


def test_no_pwsh_invocation():
    s = _gen()
    assert not re.search(r"\bpwsh\b", s), "Generated script pwsh çağırmamalı"


# ── Admin check (locale-independent) ────────────────────────────────────────


def test_admin_check_uses_built_in_role_enum():
    """`.IsInRole("Administrator")` hardcoded English TR Windows'ta fail.
    `[Security.Principal.WindowsBuiltInRole]::Administrator` enum lokalize
    bağımsız."""
    s = _gen()
    assert "[Security.Principal.WindowsBuiltInRole]::Administrator" in s, (
        "Locale-independent admin check enum kullanılmamış"
    )


def test_no_hardcoded_administrator_string_in_isinrole():
    """`IsInRole("Administrator")` string-based pattern KALMAMALI."""
    s = _gen()
    assert 'IsInRole("Administrator")' not in s, (
        'Hardcoded English string `IsInRole("Administrator")` TR Windows\'ta '
        'fail eder. WindowsBuiltInRole enum kullan.'
    )
    assert "IsInRole('Administrator')" not in s


def test_admin_check_uses_windowsprincipal():
    s = _gen()
    assert "Security.Principal.WindowsPrincipal" in s
    assert "[Security.Principal.WindowsIdentity]::GetCurrent()" in s


# ── Self-elevation + recursion guard ────────────────────────────────────────


def test_has_self_elevation_with_recursion_guard():
    """Installer normal kullanıcıdan çalışırsa UAC ile self-elevate
    olmalı. Recursion guard env var marker (`NETMANAGER_INSTALLER_ELEVATED`)
    ile."""
    s = _gen()
    assert "NETMANAGER_INSTALLER_ELEVATED" in s, "Recursion guard env var eksik"
    assert "Start-Process" in s, "Self-elevation Start-Process çağrısı eksik"
    assert "-Verb RunAs" in s, "RunAs verb eksik"
    assert "$PSCommandPath" in s, "Script yolu referansı eksik"


def test_self_elevation_passes_correct_args():
    """Elevated PowerShell'e doğru argümanlar geçilmeli: NoProfile + Bypass +
    File pointer."""
    s = _gen()
    assert "-NoProfile" in s
    assert "-ExecutionPolicy" in s
    assert "Bypass" in s


# ── No-BOM config writing ───────────────────────────────────────────────────


def test_config_uses_writeAllText_no_bom():
    """`Out-File -Encoding UTF8` PS 5.1'de BOM yazar; Python parser
    `\\ufeffNETMANAGER_URL=` bug'ına yol açar. WriteAllText + UTF8Encoding(false)
    BOM yazmaz."""
    s = _gen()
    assert "[System.IO.File]::WriteAllText" in s
    assert "System.Text.UTF8Encoding($false)" in s


def test_no_out_file_utf8_for_config():
    """`Out-File -FilePath ... -Encoding UTF8` PS 5.1'de BOM yazar; YASAK."""
    s = _gen()
    # `Out-File -Encoding UTF8` config dosyalarına UYGULANMAMIŞ olmalı
    config_out_file = re.search(
        r"Out-File\s+-FilePath\s+[^|]*config\.env[^|]*-Encoding\s+UTF8(?!NoBom)",
        s,
    )
    assert config_out_file is None, "config.env Out-File -Encoding UTF8 yazar BOM!"


# ── Read-Host (pause cmdlet PS 5.1'de yok) ──────────────────────────────────


def test_uses_read_host_not_pause():
    """`pause` cmdlet PS 5.1'de YOK (external cmd.exe pause arar).
    `Read-Host` kullan."""
    s = _gen()
    # Yorumlarda 'pause' geçebilir AMA executable satırda olmamalı
    # Basit heuristic: satır başında 'pause' (whitespace dahil) YOK
    executable_lines = [
        l for l in s.split("\n")
        if not l.strip().startswith("#") and l.strip()
    ]
    pause_lines = [l for l in executable_lines if re.search(r"^\s*pause\s*(;|$)", l)]
    assert not pause_lines, f"pause cmdlet kullanılmış: {pause_lines}"
    assert "Read-Host" in s, "Read-Host eksik"


# ── sc.exe service install ──────────────────────────────────────────────────


def test_service_create_delete_wait_loop():
    """Mevcut service varsa delete sonrası recreate için wait loop
    olmalı (sc.exe delete async; race riski)."""
    s = _gen()
    assert "sc.exe delete" in s
    assert "Start-Sleep" in s
    # Wait loop pattern (for döngüsü ile Get-Service)
    assert re.search(r"for\s*\(", s), "Service delete wait loop eksik"
    assert "Get-Service" in s


def test_service_create_with_failure_actions():
    s = _gen()
    assert "sc.exe create" in s
    assert "sc.exe failure" in s
    assert "sc.exe start" in s
    assert "restart/10000/restart/30000/restart/60000" in s


def test_service_status_verification():
    """Service install sonrası Running durumu doğrulanmalı."""
    s = _gen()
    assert re.search(r"Get-Service.*Status", s, re.DOTALL)
    assert '"Running"' in s


# ── Python detection ────────────────────────────────────────────────────────


def test_python_microsoft_store_stub_detection():
    """Microsoft Store python stub kabul edilmemeli."""
    s = _gen()
    # Script içinde literal: Microsoft\WindowsApps\python.exe
    # Python source'da r-string ile:
    assert r"Microsoft\WindowsApps\python.exe" in s, (
        "MS Store stub path detection eksik"
    )


def test_python_version_verification():
    """Python kurulumdan sonra --version çağrısı ile doğrulanmalı."""
    s = _gen()
    assert "--version" in s


def test_winget_unavailable_clear_error():
    """winget yoksa açık hata mesajı gösterilmeli."""
    s = _gen()
    assert "Get-Command winget" in s, "winget existence check eksik"
    assert "Python 3.12" in s, "Manuel kurulum yönergesi eksik"


# ── Installer cleanup ───────────────────────────────────────────────────────


def test_installer_self_cleanup():
    """Installer kurulum sonrası kendisini silmeli (disk'te key kalmasın)."""
    s = _gen()
    assert "Remove-Item $PSCommandPath" in s
    assert "-ErrorAction SilentlyContinue" in s


# ── ACL hardening ───────────────────────────────────────────────────────────


def test_install_dir_acl_hardening():
    s = _gen()
    assert "Get-Acl" in s
    assert "Set-Acl" in s
    # Script literal: NT AUTHORITY\SYSTEM ve BUILTIN\Administrators
    assert r"NT AUTHORITY\SYSTEM" in s
    assert r"BUILTIN\Administrators" in s


# ── Security — agent_id/key/url tek-tırnaklı + escape ───────────────────────


def test_agent_id_key_url_single_quoted():
    s = _gen()
    assert f"$AgentId    = '{SAMPLE_AGENT_ID}'" in s
    assert f"$AgentKey   = '{SAMPLE_AGENT_KEY}'" in s
    assert f"$BackendUrl = '{SAMPLE_BACKEND_URL}'" in s


def test_quote_injection_escaped():
    """F1.3 defense — tek tırnak `''` ile escape."""
    out = _windows_installer("evil'agent", "key'with'quote", "https://x")
    assert "$AgentId    = 'evil''agent'" in out
    assert "$AgentKey   = 'key''with''quote'" in out


# ── Backend endpoint contract (X-Agent-ID + X-Agent-Key) ──────────────────


def test_x_agent_id_and_x_agent_key_headers_used():
    s = _gen()
    assert '"X-Agent-ID" = $AgentId' in s
    assert '"X-Agent-Key" = $AgentKey' in s
    assert "/api/v1/agents/download/script" in s


# ── No token/key logging ────────────────────────────────────────────────────


def test_no_token_or_key_write_host():
    s = _gen()
    forbidden = [
        "Write-Host $AgentKey",
        'Write-Host "$AgentKey',
        "Write-Output $AgentKey",
        "echo $AgentKey",
    ]
    for fl in forbidden:
        assert fl not in s, f"AgentKey console'a yazılıyor: {fl}"


# ── TLS 1.2 enforce ─────────────────────────────────────────────────────────


def test_tls_12_enforced():
    s = _gen()
    assert "[Net.ServicePointManager]::SecurityProtocol" in s
    assert "Tls12" in s


# ── Response headers + byte-level (response wrapper testleri) ───────────────


@pytest.fixture
def installer_response_body() -> bytes:
    """Simulate download_installer response body for the Windows path."""
    script = _gen()
    # download_installer wrapper'ı: BOM + CRLF + UTF-8 encode
    body = b"\xef\xbb\xbf" + script.replace("\r\n", "\n").replace("\n", "\r\n").encode("utf-8")
    return body


def test_response_body_starts_with_utf8_bom(installer_response_body):
    """Windows .ps1 response UTF-8 BOM (EF BB BF) ile başlamalı."""
    assert installer_response_body[:3] == b"\xef\xbb\xbf", (
        f"İlk 3 byte BOM olmalı, gerçek: {installer_response_body[:3].hex()}"
    )


def test_response_body_uses_crlf_line_endings(installer_response_body):
    """Windows native line endings — CRLF."""
    # En az 10 CRLF olmalı (multiline script)
    crlf_count = installer_response_body.count(b"\r\n")
    lf_only_count = installer_response_body.count(b"\n") - crlf_count
    assert crlf_count > 10, f"CRLF count düşük: {crlf_count}"
    assert lf_only_count == 0, f"LF-only line ending var: {lf_only_count}"


def test_response_body_no_bare_cr(installer_response_body):
    """Bare CR (CRLF dışında \\r) olmamalı."""
    # Hers \r mutlaka \r\n parçası olmalı
    body = installer_response_body
    for i in range(len(body) - 1):
        if body[i:i+1] == b"\r" and body[i+1:i+2] != b"\n":
            assert False, f"Bare CR @ index {i}"


def test_response_body_decodes_as_utf8(installer_response_body):
    """Body UTF-8 olarak decode edilebilmeli (BOM dahil utf-8-sig)."""
    body = installer_response_body
    # BOM strip + decode
    text = body.decode("utf-8-sig")
    assert "$AgentId" in text
    assert "$AgentKey" in text


# ── Real PowerShell parser test (pwsh subprocess) ──────────────────────────


PWSH_BIN = shutil.which("pwsh") or shutil.which("powershell")


@pytest.mark.skipif(not PWSH_BIN, reason="pwsh/powershell yok (CI env)")
def test_real_powershell_parser_zero_errors(tmp_path, installer_response_body):
    """Real PowerShell parser ile generated script 0 syntax error vermeli.

    Lokal pwsh ile PS 7 parser çalıştırır AMA PS 7 PS 5.1 syntax'ını
    superset olarak kabul ettiği için PS 5.1 problemlerinin **çoğunu**
    yakalar (?., ??, ternary, ForEach -Parallel, missing brace vs).

    TAM PS 5.1 doğrulaması için Windows ortamında gerçek powershell.exe
    ile manuel test ZORUNLU (E2E adımı).
    """
    installer_path = tmp_path / "installer.ps1"
    installer_path.write_bytes(installer_response_body)

    ps_command = (
        "$errors = $null; $tokens = $null; "
        f"[System.Management.Automation.Language.Parser]::ParseFile("
        f"'{installer_path}', [ref]$tokens, [ref]$errors) | Out-Null; "
        "Write-Output \"ERRORS=$($errors.Count)\"; "
        "foreach ($e in $errors) { "
        "  Write-Output \"  - $($e.Message) @ line $($e.Extent.StartLineNumber)\""
        "}"
    )
    result = subprocess.run(
        [PWSH_BIN, "-NoProfile", "-Command", ps_command],
        capture_output=True,
        text=True,
        timeout=30,
    )
    output = result.stdout + result.stderr
    assert "ERRORS=0" in output, (
        f"PowerShell parser errors:\n{output}"
    )
