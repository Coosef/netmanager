"""RBAC-SPRINT-2.2C-BR — port_change_rollbacks location-scoped RLS

Pre-2.2C-BR the `pcr_isolation` policy on `port_change_rollbacks`
(installed by f9a6portchg) scoped ONLY on organization_id:

    USING (
      current_setting('app.is_super_admin', true) = 'on'
      OR organization_id = NULLIF(
           current_setting('app.current_org_id', true), '')::int
    )

That matched the org-only pattern in the `_ORG_ONLY` bucket of the
Faz 7 f7a4_enable_rls layer, but rollback rows are inherently
device-bound (each row references a device via `device_id`, and every
device belongs to exactly one location). The Faz 7 `_DEVICE_BOUND`
bucket already applies the composite `(org AND (loc IS NULL OR
loc = current))` guard to every device-scoped table (`devices`,
`config_backups`, `topology_links`, etc.), so `port_change_rollbacks`
is currently the only device-bound RLS table whose policy is missing
the location filter.

Observed consequences before this fix:

  * a location_admin with `current_location_id=1` could enumerate,
    commit, or cancel rollback rows targeting devices in `location_id=2`
    of the same organization — `GET /port-control/{device_id}/_rollbacks`
    returned rows the caller should never see, and
    `POST /_rollback/{id}/commit` succeeded even when the device row
    itself was invisible to the caller under the `devices` RLS;
  * `POST /_rollback/{id}/cancel` reached `db.get(Device, device_id)`
    which correctly returned None under the device policy, but the
    endpoint still wrote `status='failed'` + `completed_at=NOW()` on
    the rollback row before failing, muddying the audit trail for the
    "true" owning location.

This migration replaces the org-only policy with the composite
location-aware policy the operator brief describes:

    current_setting('app.is_super_admin', true) = 'on'
    OR (
      organization_id = NULLIF(
         current_setting('app.current_org_id', true), '')::int
      AND (
        NULLIF(current_setting('app.current_location_id', true), '')
          IS NULL
        OR location_id = NULLIF(
             current_setting('app.current_location_id', true), '')::int
      )
    )

Semantics:

  * super_admin: `app.is_super_admin='on'` still bypasses the whole
    check — platform maintenance is unaffected.
  * org_admin: `app.current_location_id` is NULL/empty (deps.py:103
    passes `ctx.active_location_id` which is None when the request
    is org-wide — see the `is_org_wide` branch at deps.py:303).
    The OR arm is true, so the caller sees every rollback in their
    organization regardless of which location.
  * location_admin: `app.current_location_id` is set to the caller's
    resolved location (enforced by `resolve_location_context` at the
    auth dep, validated against `user_locations`, never trusted from
    a header). Only rows with the matching `location_id` are visible.
  * missing `app.current_org_id`: `NULLIF(...)::int` is NULL, the
    equality is false, the caller sees zero rows — fail-closed, as
    the surrounding f7a4 RLS layer already establishes.
  * `port_change_rollbacks.location_id` is NULLABLE in the schema
    (f9a6 line 47 — `sa.ForeignKey("locations.id", ondelete="SET NULL"),
    nullable=True`), so a rollback row whose owning device was moved
    to a NULL location later would ONLY be visible to super_admin or
    to callers with a NULL `current_location_id` (i.e. org_admin);
    location_admin never matches. That is the intended fail-closed
    behavior — an unresolved-location rollback must not silently leak
    to a random location_admin.

The USING and WITH CHECK clauses carry the SAME expression so both
read and write attempts obey the same scope contract. `WITH CHECK`
also prevents a caller from INSERTing or UPDATE-relocating a row
into a location outside their own scope — a defensive backstop even
though the endpoint code today stamps `location_id` from `device.
location_id` (port_control.py:146, 552) rather than from user input.

Downgrade restores the exact f9a6 org-only policy verbatim so a
`downgrade f9amfirmwarereadauth` returns the table to its
pre-2.2C-BR state byte-identically.

The migration is data-independent — it only manipulates the policy
definition, so the offline `alembic upgrade head --sql` plan flow
still works (unlike the RBAC permission-set backfill migrations
which read/write JSON rows).

Revision ID: f9aopcrlocrls
Revises: f9amfirmwarereadauth
"""
from alembic import op


revision = "f9aopcrlocrls"
down_revision = "f9amfirmwarereadauth"
branch_labels = None
depends_on = None


# ── Constants ─────────────────────────────────────────────────────────────

# The composite location-aware clause used in both USING and WITH CHECK.
# Kept as a single triple-quoted constant so USING and WITH CHECK cannot
# drift.
_LOCATION_AWARE_CLAUSE = """\
current_setting('app.is_super_admin', true) = 'on'
    OR (
        organization_id = NULLIF(current_setting('app.current_org_id', true), '')::int
        AND (
            NULLIF(current_setting('app.current_location_id', true), '') IS NULL
            OR location_id = NULLIF(current_setting('app.current_location_id', true), '')::int
        )
    )
"""

# The f9a6 org-only clause — used ONLY by the downgrade path so the
# pre-2.2C-BR state can be restored byte-identically.
_ORG_ONLY_CLAUSE_LEGACY = """\
current_setting('app.is_super_admin', true) = 'on'
    OR organization_id = NULLIF(current_setting('app.current_org_id', true), '')::int
"""


def _install_policy(clause: str) -> None:
    """DROP + CREATE the pcr_isolation policy with the given USING /
    WITH CHECK clause. Postgres does not offer `ALTER POLICY` for the
    USING expression on all versions equally, so drop-and-recreate is
    the portable path. `DROP POLICY IF EXISTS` handles the case where
    a partial prior migration left the policy off — fail-loudly at
    CREATE if the ENABLE ROW LEVEL SECURITY table state disagrees."""
    op.execute("DROP POLICY IF EXISTS pcr_isolation ON port_change_rollbacks")
    op.execute(
        f"""
        CREATE POLICY pcr_isolation ON port_change_rollbacks
        FOR ALL
        USING (
            {clause}
        )
        WITH CHECK (
            {clause}
        )
        """
    )


def upgrade() -> None:
    _install_policy(_LOCATION_AWARE_CLAUSE)


def downgrade() -> None:
    _install_policy(_ORG_ONLY_CLAUSE_LEGACY)
