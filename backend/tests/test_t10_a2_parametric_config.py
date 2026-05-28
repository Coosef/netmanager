"""
T10 Faz A2 — Parametric Config.

Hardcoded operasyonel değerlerin system_settings registry'sine taşınması.
A2.1 bu registry'yi genişletir (saf, davranış değişmez): yeni key'ler +
guardrail'ler + kategori/scope metası. Bu test registry sözleşmesini
sabitler — değerleri tüketen task'ların testleri A2.2+ commit'lerinde
eklenir.

scope semantiği:
  * "global" → yalnız super-admin, organization_id=None satırına yazılır
    (fleet-wide worker'lar org context'siz okur, org override anlamsız).
  * "org"    → org_admin kendi org'una override yazabilir.
"""
from app.services import system_settings_service as svc


# ── yeni operasyonel key'ler registry'de ─────────────────────────────────────

NEW_OPERATIONAL_KEYS = [
    "dedup.offline_event_sec", "dedup.online_event_sec",
    "dedup.flap_alert_sec", "dedup.correlation_incident_sec",
    "dedup.agent_event_sec",
    "flap.device_threshold_per_hour", "flap.incident_threshold",
    "correlation.group_wait_sec", "correlation.bounce_guard_sec",
    "correlation.recovery_confirm_sec", "correlation.upstream_settle_sec",
    "correlation.flap_window_sec",
    "maintenance.spawn_horizon_days",
    "session.terminal_stale_min", "session.poe_snapshot_stale_min",
]


def test_new_keys_have_defaults_and_guardrails():
    d = svc.defaults()
    for key in NEW_OPERATIONAL_KEYS:
        assert key in d, f"{key} eksik (defaults)"
        lo, hi = svc.guardrail(key)
        assert lo is not None and hi is not None, f"{key} guardrail eksik"
        assert lo < hi
        # Varsayılan, guardrail penceresinin içinde olmalı.
        assert lo <= d[key] <= hi, f"{key} default guardrail dışında"


def test_defaults_match_prior_hardcoded_values():
    # Davranış korunması: yeni default'lar eski kod sabitleriyle birebir.
    d = svc.defaults()
    assert d["dedup.offline_event_sec"] == 1800
    assert d["dedup.flap_alert_sec"] == 3600
    assert d["dedup.agent_event_sec"] == 600
    assert d["flap.device_threshold_per_hour"] == 10
    assert d["flap.incident_threshold"] == 8
    assert d["correlation.group_wait_sec"] == 30
    assert d["correlation.bounce_guard_sec"] == 60
    assert d["correlation.recovery_confirm_sec"] == 120
    assert d["correlation.upstream_settle_sec"] == 35
    assert d["correlation.flap_window_sec"] == 300
    assert d["maintenance.spawn_horizon_days"] == 14
    assert d["session.terminal_stale_min"] == 30
    assert d["session.poe_snapshot_stale_min"] == 45


# ── validate — guardrail enforcement ─────────────────────────────────────────

def test_validate_accepts_in_range():
    ok, msg = svc.validate("dedup.flap_alert_sec", 7200)
    assert ok and msg == ""


def test_validate_rejects_below_min():
    ok, msg = svc.validate("correlation.group_wait_sec", 1)   # min 5
    assert not ok
    assert "en az" in msg


def test_validate_rejects_above_max():
    ok, msg = svc.validate("maintenance.spawn_horizon_days", 999)  # max 90
    assert not ok
    assert "en fazla" in msg


def test_validate_rejects_unknown_key():
    ok, msg = svc.validate("totally.unknown_key", 5)
    assert not ok
    assert "Bilinmeyen" in msg


# ── kategori / scope metası ──────────────────────────────────────────────────

def test_category_from_prefix():
    assert svc.category("scan.poll_snmp_sec") == "Tarama Frekansları"
    assert svc.category("dedup.flap_alert_sec") == "Alarm / Dedup"
    assert svc.category("flap.incident_threshold") == "Flap Tespiti"
    assert svc.category("correlation.group_wait_sec") == "Korelasyon Motoru"
    assert svc.category("maintenance.spawn_horizon_days") == "Bakım Pencereleri"
    assert svc.category("session.terminal_stale_min") == "Oturum / Stale"


def test_scope_operational_keys_are_global():
    for key in NEW_OPERATIONAL_KEYS:
        assert svc.scope(key) == "global", f"{key} global olmalı"


def test_scope_scan_keys_are_org_overridable():
    assert svc.scope("scan.poll_snmp_sec") == "org"
    assert svc.scope("scan.mac_arp_sec") == "org"


def test_scope_unknown_defaults_to_org():
    assert svc.scope("totally.unknown_key") == "org"


# ── A2.2 — get_sync resolution (org → global → _DEFAULTS) ────────────────────
# SystemSetting JSONB kolonu SQLite'ta create edilemediği için gerçek tablo
# yerine sahte senkron session ile çözünürlük mantığını sabitliyoruz.

class _FakeResult:
    def __init__(self, row):
        self._row = row

    def scalar_one_or_none(self):
        return self._row


class _FakeRow:
    def __init__(self, value):
        self.value = value


class _FakeSyncSession:
    """execute() çağrı sırasına göre kuyruktan sonuç döndürür.
    get_sync: org_id=None → 1 execute (global); org_id=X → 2 execute (org, global).
    begin_nested() no-op savepoint (get_sync onu sarmalıyor)."""
    def __init__(self, *rows):
        self._rows = list(rows)

    def begin_nested(self):
        import contextlib
        return contextlib.nullcontext()

    def execute(self, _stmt):
        return _FakeResult(self._rows.pop(0) if self._rows else None)


def test_get_sync_falls_back_to_default():
    svc.invalidate_cache()
    # Global lookup boş → kod default'u (3600).
    val = svc.get_sync(_FakeSyncSession(None), "dedup.flap_alert_sec")
    assert val == 3600


def test_get_sync_returns_global_row():
    svc.invalidate_cache()
    val = svc.get_sync(_FakeSyncSession(_FakeRow(7200)), "dedup.flap_alert_sec")
    assert val == 7200


def test_get_sync_org_override_wins_over_global():
    svc.invalidate_cache()
    # org_id verildi: ilk execute org satırı (9000) → global'e bakmadan döner.
    val = svc.get_sync(
        _FakeSyncSession(_FakeRow(9000), _FakeRow(7200)),
        "dedup.flap_alert_sec", organization_id=5,
    )
    assert val == 9000


def test_get_sync_uses_cache_on_second_call():
    svc.invalidate_cache()
    # İlk çağrı global satırı cache'ler; ikinci çağrı boş session'a rağmen
    # cache'ten 7200 döndürmeli (30s TTL).
    svc.get_sync(_FakeSyncSession(_FakeRow(7200)), "dedup.online_event_sec")
    val = svc.get_sync(_FakeSyncSession(None), "dedup.online_event_sec")
    assert val == 7200
    svc.invalidate_cache()
