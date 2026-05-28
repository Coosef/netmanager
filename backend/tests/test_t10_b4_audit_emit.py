"""
T10 Faz B4.3 — audit dual-emit.

audit_service.log_action DB'ye yazdıktan sonra aynı olayı `netmanager.audit`
(log_category=audit via B4.1) structured log satırı olarak da emit eder.
DB audit_logs kayıt-of-truth olarak kalır; bu satır SIEM/aggregator içindir.

Fake async DB ile (bind=None → sqlite path, execute/commit no-op) çağrılır;
structlog.testing.capture_logs ile emit edilen satır doğrulanır.
"""
import pytest
from structlog.testing import capture_logs

from app.services import audit_service


class _FakeDB:
    bind = None  # log_action: db.bind None → dialect='sqlite' (JSON), execute/commit no-op

    async def execute(self, *a, **k):
        return None

    async def commit(self):
        return None


@pytest.mark.asyncio
async def test_log_action_dual_emits_audit_line():
    with capture_logs() as logs:
        await audit_service.log_action(_FakeDB(), None, "device_moved", status="success")
    audit = [l for l in logs if l.get("audit_action") == "device_moved"]
    assert audit, "audit dual-emit log satırı yok"
    e = audit[0]
    assert e["status"] == "success"
    assert e["username"] == "system"      # user=None → system
    assert e["log_level"] == "info"


@pytest.mark.asyncio
async def test_failure_status_is_warning():
    with capture_logs() as logs:
        await audit_service.log_action(_FakeDB(), None, "login_failed", status="failure")
    e = [l for l in logs if l.get("audit_action") == "login_failed"][0]
    assert e["log_level"] == "warning"
    assert e["status"] == "failure"


@pytest.mark.asyncio
async def test_resource_fields_carried():
    with capture_logs() as logs:
        await audit_service.log_action(
            _FakeDB(), None, "organization_updated", status="success",
            resource_type="organization", resource_id=42, resource_name="Acme",
        )
    e = [l for l in logs if l.get("audit_action") == "organization_updated"][0]
    assert e["resource_type"] == "organization"
    assert e["resource_id"] == "42"        # str'e çevrilir
    assert e["resource_name"] == "Acme"
