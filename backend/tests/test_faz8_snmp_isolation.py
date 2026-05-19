"""
Faz 8 Phase A — snmp_poll_results org/location isolation.

`snmp_poll_results` is a TimescaleDB hypertable with columnstore enabled,
so RLS cannot be applied to it. Migration f8a1snmpview renames the
hypertable to `snmp_poll_results_raw` and exposes a SECURITY BARRIER
view `snmp_poll_results` that re-applies the org+location predicate; the
app role's direct access to the raw table is revoked.

These tests prove an org-A session cannot read org-B metrics, that an
unscoped (no-context) query is empty, and that the raw hypertable is
unreachable for the application role. PostgreSQL-only (the mechanism is
a DB view + grants); skipped on the SQLite unit path.
"""
import pytest
from sqlalchemy import func, select, text

from app.core.config import settings

_IS_PG = "postgresql" in (settings.DATABASE_URL or "")
pytestmark = pytest.mark.skipif(
    not _IS_PG, reason="snmp isolation is a DB view + grants — requires PostgreSQL",
)


async def _count(org_id, *, super_admin=False):
    from app.core.database import AsyncSessionLocal
    from app.core.org_context import (
        set_org_context, clear_org_context, superadmin_context,
    )
    from app.core.rls import apply_rls_context
    from app.models.snmp_metric import SnmpPollResult

    async with AsyncSessionLocal() as db:
        if super_admin:
            with superadmin_context():
                await apply_rls_context(db)
                return (await db.execute(
                    select(func.count()).select_from(SnmpPollResult))).scalar()
        if org_id is None:
            clear_org_context()
        else:
            set_org_context(org_id, None, False)
        await apply_rls_context(db)
        try:
            return (await db.execute(
                select(func.count()).select_from(SnmpPollResult))).scalar()
        finally:
            clear_org_context()


@pytest.mark.asyncio
async def test_snmp_metrics_are_org_isolated():
    """org-A sees only its own metrics; org-B and no-context see none of A's."""
    n_super = await _count(None, super_admin=True)
    n_org1 = await _count(1)
    n_org2 = await _count(2)
    n_none = await _count(None)

    assert n_none == 0, f"no-context must see 0 metric rows, saw {n_none}"
    assert n_org1 + n_org2 <= n_super, "per-org metrics exceed the super-admin total"
    assert n_org1 > 0, "org 1 should have seeded metrics"
    # org-2 must not see org-1's metrics
    assert n_org2 < n_super, "org 2 leaked the full metric set"


@pytest.mark.asyncio
async def test_snmp_view_rows_belong_to_the_scoped_org():
    """Every row the org-1 session reads through the view is an org-1 row."""
    from app.core.database import AsyncSessionLocal
    from app.core.org_context import set_org_context, clear_org_context
    from app.core.rls import apply_rls_context
    from app.models.snmp_metric import SnmpPollResult

    async with AsyncSessionLocal() as db:
        set_org_context(1, None, False)
        await apply_rls_context(db)
        try:
            foreign = (await db.execute(
                select(func.count()).select_from(SnmpPollResult)
                .where(SnmpPollResult.organization_id != 1)
            )).scalar()
        finally:
            clear_org_context()
    assert foreign == 0, f"org-1 view exposed {foreign} non-org-1 metric rows"


@pytest.mark.asyncio
async def test_raw_hypertable_is_not_directly_readable():
    """The application role cannot bypass the view via the raw hypertable."""
    from app.core.database import AsyncSessionLocal
    from app.core.org_context import set_org_context, clear_org_context
    from app.core.rls import apply_rls_context

    async with AsyncSessionLocal() as db:
        set_org_context(1, None, False)
        await apply_rls_context(db)
        try:
            with pytest.raises(Exception) as exc:
                await db.execute(text("SELECT count(*) FROM snmp_poll_results_raw"))
            assert "permission denied" in str(exc.value).lower()
        finally:
            clear_org_context()
