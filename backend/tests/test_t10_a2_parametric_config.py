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
