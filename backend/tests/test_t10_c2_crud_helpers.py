"""
T10 Faz C C2 — CRUD validate/serialize yardımcıları (saf).

Endpoint'in iş mantığı (RLS/feature gate) canlı doğrulandı:
  GET switch (super-admin org1+org2 = 6), create id=8, update cpu_critical=92
  (poe_warn NULL korunur), bad severity→400, delete→204, get→404.
Bu test allowlist/validate/serialize sözleşmesini sabitler.
"""
import pytest
from fastapi import HTTPException

from app.api.v1.endpoints.security_policies import _allowed, _serialize, _validate
from app.models.security_policy import PortSecurityPolicy, SwitchSecurityPolicy


def test_allowed_excludes_reserved():
    a = _allowed(SwitchSecurityPolicy)
    assert "cpu_critical" in a and "config_change_policy" in a
    for r in ("id", "organization_id", "created_at", "updated_at"):
        assert r not in a


def test_validate_rejects_unknown_field():
    with pytest.raises(HTTPException) as e:
        _validate(SwitchSecurityPolicy, {"name": "x", "nope_field": 1}, is_create=True)
    assert e.value.status_code == 400


def test_validate_requires_name_on_create():
    with pytest.raises(HTTPException) as e:
        _validate(SwitchSecurityPolicy, {"cpu_critical": 85}, is_create=True)
    assert e.value.status_code == 400
    # update'te name zorunlu değil
    _validate(SwitchSecurityPolicy, {"cpu_critical": 85}, is_create=False)


def test_validate_severity_enum():
    with pytest.raises(HTTPException):
        _validate(SwitchSecurityPolicy, {"name": "x", "ssh_login_severity": "BOGUS"}, is_create=True)
    # geçerli + null serbest
    _validate(SwitchSecurityPolicy, {"name": "x", "ssh_login_severity": "info"}, is_create=True)
    _validate(SwitchSecurityPolicy, {"name": "x", "ssh_login_severity": None}, is_create=True)


def test_validate_config_change_policy_enum():
    with pytest.raises(HTTPException):
        _validate(SwitchSecurityPolicy, {"name": "x", "config_change_policy": "nope"}, is_create=True)
    _validate(SwitchSecurityPolicy, {"name": "x", "config_change_policy": "auto_ack"}, is_create=True)


def test_serialize_roundtrip_null_semantic():
    p = SwitchSecurityPolicy(id=1, organization_id=1, name="X", cpu_critical=85)
    s = _serialize(p)
    assert s["name"] == "X" and s["cpu_critical"] == 85
    assert s["poe_budget_warning_pct"] is None       # NULL semantic
    assert "organization_id" in s


def test_port_allowed_has_quarantine_field():
    a = _allowed(PortSecurityPolicy)
    assert "auto_quarantine_on_nth_flap" in a and "mac_flood_warning" in a
