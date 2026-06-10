"""Windows Agent Installer — PowerShell 5.1 compatibility regresyon koruması.

Hedef Windows makinelerde PowerShell 7 (pwsh) kurulu OLMAYABİLİR — kullanıcının
gerçek senaryosunda Windows default 5.1 üzerinden installer çalıştırıldı,
ilk hata `(Get-Command python ...)?.Source` yüzünden PS 7-only `?.` operator
PS 5.1 parser hatası verdi.

Bu testler `_windows_installer` üreticisinin döndürdüğü PowerShell script'inde
PS 7-only syntax KALMADIĞINI sabitler. Yeni regression olursa CI yakalar.
"""
import re

from app.api.v1.endpoints.agents import _windows_installer


# ── Fixture ─────────────────────────────────────────────────────────────────


SAMPLE_AGENT_ID = "test-agent-abcd1234"
SAMPLE_AGENT_KEY = "test-key-9f8e7d6c"
SAMPLE_BACKEND_URL = "https://netmanager.example.app"


def _gen() -> str:
    return _windows_installer(SAMPLE_AGENT_ID, SAMPLE_AGENT_KEY, SAMPLE_BACKEND_URL)


# ── PS 7-only syntax YOK ────────────────────────────────────────────────────


def test_no_null_conditional_operator():
    """`?.Source` benzeri null-conditional operator PS 7-only — PS 5.1
    parser'da `operator expected` hatası verir."""
    script = _gen()
    # Match `)?.` veya `]?.` veya benzer null-conditional patterni.
    # Whitespace toleranslı: ` )?.`, `]?.`, `name?.foo`.
    matches = re.findall(r'[\w\)\]]\?\.', script)
    assert matches == [], (
        f"PS 7-only null-conditional `?.` operator generated installer'da "
        f"hala VAR — PS 5.1 parser hata verir. Match: {matches}"
    )


def test_no_null_coalescing_operator():
    """`??` null-coalescing PS 7+."""
    script = _gen()
    # `??` (ama `???` PS regex pattern değildir, sadece `??` token)
    # `$x ?? $default` benzeri pattern aranıyor.
    assert "??" not in script, "PS 7-only null-coalescing `??` PS 5.1 parser hata verir"


def test_no_ternary_operator():
    """`condition ? a : b` ternary PS 7+ (PS 5.1 if-else gerekir)."""
    script = _gen()
    # PowerShell ternary `(...) ? ... : ...` — basit heuristic: `? ... : `
    # ile başlayan satır PS 7 ternary belirtisi. False positive korumak için
    # comment'leri çıkar ve regex sıkı.
    # Ternary pattern: WORD WHITESPACE ? WHITESPACE EXPRESSION WHITESPACE : WHITESPACE EXPRESSION
    ternary = re.findall(r'[\w\)]\s*\?\s+[\w\$\-\'"]+\s*:\s*[\w\$\-\'"]+', script)
    assert ternary == [], f"PS 7-only ternary operator bulundu: {ternary}"


def test_no_foreach_object_parallel():
    """`ForEach-Object -Parallel` PS 7+."""
    script = _gen()
    assert "-Parallel" not in script, (
        "PS 7-only `-Parallel` parameter (ForEach-Object) PS 5.1'de invalid"
    )


def test_no_ps7_only_cmdlets_or_flags():
    """Diğer PS 7-only cmdlet / parameter pattern'leri."""
    script = _gen()
    forbidden = [
        "Where-Object -CombineWith",   # PS 7+ -or/-and combine
        "ConvertFrom-Markdown",         # PS 7+
        "Test-Json -Schema",            # PS 7+ -Schema parameter
        "Get-Random -SetSeed",          # PS 7+ -SetSeed
    ]
    for f in forbidden:
        assert f not in script, f"PS 7-only pattern: {f}"


# ── Pozitif kontrol — PS 5.1 uyumlu pattern'ler ─────────────────────────────


def test_uses_if_else_pattern_for_get_command():
    """Get-Command çıktısı null-check için PS 5.1 uyumlu `if ($x) { ... }`
    pattern'i ile yapılmalı."""
    script = _gen()
    # `if ($pythonCmd) {` veya benzer pattern bekleniyor (PS 5.1 uyumlu).
    assert "$pythonCmd = Get-Command python" in script, (
        "Get-Command çıktısı bir değişkene atanmalı (PS 5.1 uyumlu pattern)"
    )
    assert "if ($pythonCmd)" in script, "if-else null-check pattern eksik"


def test_tls_12_explicit_set():
    """PS 5.1 default'unda Windows Server 2016/2019 SystemDefault TLS hâlâ
    1.0/1.1 olabilir. Cloudflare Faz 0 sonrası edge TLS 1.2 min; explicit
    set olmazsa Invoke-WebRequest fail eder."""
    script = _gen()
    assert "[Net.ServicePointManager]::SecurityProtocol" in script, (
        "TLS protocol explicit set edilmemiş — Cloudflare TLS 1.2+ olduğu için "
        "PS 5.1 default'unda Invoke-WebRequest fail edebilir"
    )
    assert "Tls12" in script, "TLS 1.2 explicit set edilmemiş"


# ── X-Agent-Key + X-Agent-ID header contract korundu mu? ───────────────────


def test_x_agent_id_and_x_agent_key_headers_used():
    """Backend download endpoint'i `X-Agent-ID` + `X-Agent-Key` header ister.
    Installer template bu header'ları doğru sırada ve doğru değerlerle
    göndermek zorunda."""
    script = _gen()
    assert '"X-Agent-ID" = $AgentId' in script, "X-Agent-ID header eksik"
    assert '"X-Agent-Key" = $AgentKey' in script, "X-Agent-Key header eksik"
    # Invoke-WebRequest çağrısı içinde header doğru bağlanmış mı?
    assert "/api/v1/agents/download/script" in script, "Download URL contract bozuk"


# ── Embed edilen değerler doğru quote edilmiş mi? (T8.4 F1.3 — injection guard) ─


def test_agent_id_key_url_single_quoted():
    """`_psq()` agent_id/key/url tek tırnaklı string'e embed eder; tek tırnak
    `''` ile escape. Injection korunması korunmalı."""
    script = _gen()
    assert f"$AgentId   = '{SAMPLE_AGENT_ID}'" in script
    assert f"$AgentKey  = '{SAMPLE_AGENT_KEY}'" in script
    assert f"$BackendUrl = '{SAMPLE_BACKEND_URL}'" in script


def test_quote_injection_escaped_when_present():
    """Agent değerlerinde tek tırnak olursa `''` ile escape edilmeli."""
    out = _windows_installer("evil'agent", "key'with'quote", "https://x")
    assert "$AgentId   = 'evil''agent'" in out
    assert "$AgentKey  = 'key''with''quote'" in out


# ── Diğer önemli davranış sabitleri ─────────────────────────────────────────


def test_admin_check_present():
    """Yönetici kontrolü template'te kalmalı (security)."""
    script = _gen()
    assert "IsInRole(\"Administrator\")" in script, "Admin kontrolü eksik"


def test_service_install_pattern_intact():
    """sc.exe ile servis kurulumu / failure restart pattern korundu mu?"""
    script = _gen()
    assert "sc.exe create $ServiceName" in script
    assert "sc.exe failure $ServiceName" in script
    assert "sc.exe start $ServiceName" in script


def test_no_token_or_key_logged_to_host():
    """AgentKey'in Write-Host gibi konsola yazıldığı yer YOK."""
    script = _gen()
    # AgentKey'in atandığı satır hariç hiçbir yerde değişkenin
    # konsola yazıldığı kullanım olmamalı.
    # Basit heuristic: Write-Host $AgentKey veya echo $AgentKey YOK.
    forbidden_logs = [
        "Write-Host $AgentKey",
        "Write-Host \"$AgentKey",
        "Write-Output $AgentKey",
        "echo $AgentKey",
    ]
    for fl in forbidden_logs:
        assert fl not in script, f"AgentKey konsola loglanıyor: {fl}"


def test_first_30_lines_snapshot():
    """İlk 30 satır generated installer örnek snapshot — rapora konacak
    içeriği belgelendir."""
    script = _gen()
    lines = script.splitlines()
    assert len(lines) > 30, "Installer 30 satırdan kısa — beklenmedik"
    head = "\n".join(lines[:30])
    # Critical content checks
    assert "NetManager Proxy Agent" in head
    assert "$AgentId" in head
    assert "Tls12" in head
    assert "$PythonExe" in head
