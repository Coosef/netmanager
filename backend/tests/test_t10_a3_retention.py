"""
T10 Faz A3 — Customer-based Retention.

A3.1 — retention.* registry key'leri (org-override edilebilir) + per-org
etkili saklama çözücüsü (floor/ceiling clamp). A3.2 cleanup_old_data'yı
org-aware + dry-run yapar; A3.3 önizleme endpoint'i ekler.

clamp semantiği (effective_retention_days):
  * tavan = org.max_retention_days (lisanstan fazla saklanamaz)
  * taban = RETENTION_FLOOR_DAYS (bundan taze veri silinmez)
  * çakışmada taban kazanır (fazla saklamak güvenli).
"""
from app.services import system_settings_service as svc
from app.workers.tasks.retention_tasks import (
    RETENTION_FLOOR_DAYS, _RETENTION_KEYS, effective_retention_days,
)


RETENTION_KEYS = [
    "retention.network_events_days", "retention.audit_logs_days",
    "retention.notification_logs_days", "retention.command_executions_days",
    "retention.agent_command_logs_days", "retention.mac_arp_inactive_days",
    "retention.config_backup_days",
]


# ── registry ─────────────────────────────────────────────────────────────────

def test_retention_keys_registered_with_guardrails():
    d = svc.defaults()
    for key in RETENTION_KEYS:
        assert key in d
        lo, hi = svc.guardrail(key)
        assert lo == 7 and hi == 3650
        assert lo <= d[key] <= hi


def test_retention_keys_are_org_scoped():
    # Retention org-override edilebilir (operasyonel tuning gibi global değil).
    for key in RETENTION_KEYS:
        assert svc.scope(key) == "org"


def test_retention_category():
    assert svc.category("retention.network_events_days") == "Veri Saklama (Retention)"


def test_retention_defaults_match_prior_hardcoded():
    d = svc.defaults()
    assert d["retention.notification_logs_days"] == 30
    assert d["retention.command_executions_days"] == 90
    assert d["retention.network_events_days"] == 90
    assert d["retention.audit_logs_days"] == 180
    assert d["retention.agent_command_logs_days"] == 90
    assert d["retention.mac_arp_inactive_days"] == 30
    assert d["retention.config_backup_days"] == 90


def test_retention_key_map_covers_regular_tables():
    # _RETENTION_KEYS regular (non-hypertable) tabloları kapsar.
    assert set(_RETENTION_KEYS) == {
        "notification_logs", "command_executions", "network_events",
        "audit_logs", "agent_command_logs",
    }
    # Her eşleme (settings_key, ts_col) ve settings_key registry'de var.
    for table, (key, ts_col) in _RETENTION_KEYS.items():
        assert key in svc.defaults()
        assert ts_col


# ── effective_retention_days — floor/ceiling clamp ──────────────────────────

def test_clamp_normal_within_bounds():
    # raw=90, tavan=180 → 90 (floor 7 etkisiz)
    assert effective_retention_days(90, 180) == 90


def test_clamp_ceiling_caps_to_license():
    # Müşteri 365 istedi ama lisans tavanı 90 → 90'a indir.
    assert effective_retention_days(365, 90) == 90


def test_clamp_floor_protects_recent_data():
    # raw=2 gün (yanlış küçük değer), tavan=90 → taban 7'ye yüksel.
    assert effective_retention_days(2, 90) == RETENTION_FLOOR_DAYS
    assert effective_retention_days(2, 90) == 7


def test_clamp_floor_wins_over_low_ceiling():
    # Pathological: lisans tavanı tabandan küçük (3 < 7). Taban kazanır —
    # fazla saklamak güvenli, az saklamak veri kaybı.
    assert effective_retention_days(90, 3) == RETENTION_FLOOR_DAYS


def test_clamp_custom_floor():
    assert effective_retention_days(5, 90, floor=14) == 14
