"""faz7 M7 — soft-delete: RLS hides deleted_at rows

Faz 7 Phase 6b. The devices / agents / locations tables carry a
deleted_at column (added by M1). This migration rebuilds their RLS
org_isolation policy so a soft-deleted row (deleted_at IS NOT NULL) is
invisible to ordinary queries — and stays invisible — unless the request
runs in the explicit admin restore flow, which sets the GUC
app.include_archived = 'on'.

Result: a soft-deleted device/agent/location simply disappears from
every list, dashboard and topology query, with no per-query
`WHERE deleted_at IS NULL` needed; only the restore flow can see it.

Revision ID: f7a7softdel
Revises: f7a6roles
Create Date: 2026-05-18
"""
from alembic import op

revision = "f7a7softdel"
down_revision = "f7a6roles"
branch_labels = None
depends_on = None

_ORG = (
    "current_setting('app.is_super_admin', true) = 'on' "
    "OR organization_id = "
    "NULLIF(current_setting('app.current_org_id', true), '')::int"
)
_LOC = (
    "NULLIF(current_setting('app.current_location_id', true), '') IS NULL "
    "OR location_id = "
    "NULLIF(current_setting('app.current_location_id', true), '')::int"
)
# A soft-deleted row is hidden unless the restore flow opted in.
_NOT_ARCHIVED = (
    "deleted_at IS NULL "
    "OR current_setting('app.include_archived', true) = 'on'"
)


def _recreate(table: str, using: str) -> None:
    op.execute(f"DROP POLICY IF EXISTS org_isolation ON {table}")
    op.execute(
        f"CREATE POLICY org_isolation ON {table} "
        f"USING ({using}) WITH CHECK ({_ORG})"
    )


def upgrade() -> None:
    # devices / agents — device-bound: org + location + not-archived.
    for tbl in ("devices", "agents"):
        _recreate(tbl, f"(({_ORG}) AND ({_LOC})) AND ({_NOT_ARCHIVED})")
    # locations — org-direct: org + not-archived.
    _recreate("locations", f"({_ORG}) AND ({_NOT_ARCHIVED})")


def downgrade() -> None:
    for tbl in ("devices", "agents"):
        _recreate(tbl, f"({_ORG}) AND ({_LOC})")
    _recreate("locations", _ORG)
