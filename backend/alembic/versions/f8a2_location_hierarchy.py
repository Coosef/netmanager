"""faz8 phase C — complete the Organization > Location hierarchy

Logs (`syslog_events`) and discovery results (`discovery_results`) were
organization-scoped only — they had no `location_id` and so did not sit
under the intended `Organization > Location > …` hierarchy. This
migration:

  * adds `location_id` to both (nullable — an unresolved row is a
    review bucket, never a silent default)
  * backfills it from the originating agent's location
  * rebuilds the RLS `org_isolation` policy on both to enforce
    organization AND location scope
  * fixes the relational contradiction where a NOT NULL `location_id`
    column carried an `ON DELETE SET NULL` foreign key — those FKs are
    rebuilt `ON DELETE RESTRICT` so a location with dependent rows
    cannot be hard-deleted (locations are soft-deleted in the app).

Revision ID: f8a2lochier
Revises: f8a1snmpview
Create Date: 2026-05-19
"""
from alembic import op

revision = "f8a2lochier"
down_revision = "f8a1snmpview"
branch_labels = None
depends_on = None

_ORG = (
    "current_setting('app.is_super_admin', true) = 'on' "
    "OR organization_id = NULLIF(current_setting('app.current_org_id', true), '')::int"
)
_LOC = (
    "NULLIF(current_setting('app.current_location_id', true), '') IS NULL "
    "OR location_id = NULLIF(current_setting('app.current_location_id', true), '')::int"
)


def _recreate_policy(table: str, using: str, check: str) -> None:
    op.execute(f"DROP POLICY IF EXISTS org_isolation ON {table}")
    op.execute(
        f"CREATE POLICY org_isolation ON {table} "
        f"USING ({using}) WITH CHECK ({check})"
    )


def upgrade() -> None:
    # ── syslog_events — add + backfill location_id (hypertable: plain int) ──
    op.execute("ALTER TABLE syslog_events ADD COLUMN IF NOT EXISTS location_id INTEGER")
    op.execute("CREATE INDEX IF NOT EXISTS ix_syslog_events_location_id "
               "ON syslog_events(location_id)")
    op.execute(
        "UPDATE syslog_events s SET location_id = a.location_id "
        "FROM agents a WHERE s.agent_id = a.id AND s.location_id IS NULL"
    )

    # ── discovery_results — add + backfill location_id (plain table: FK) ───
    op.execute("ALTER TABLE discovery_results ADD COLUMN IF NOT EXISTS location_id INTEGER")
    op.execute(
        "UPDATE discovery_results d SET location_id = a.location_id "
        "FROM agents a WHERE d.agent_id = a.id AND d.location_id IS NULL"
    )
    op.execute(
        "DO $fk$ BEGIN "
        "  IF NOT EXISTS (SELECT 1 FROM pg_constraint "
        "    WHERE conname = 'discovery_results_location_id_fkey') THEN "
        "    ALTER TABLE discovery_results ADD CONSTRAINT discovery_results_location_id_fkey "
        "      FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE RESTRICT; "
        "  END IF; "
        "END $fk$;"
    )
    op.execute("CREATE INDEX IF NOT EXISTS ix_discovery_results_location_id "
               "ON discovery_results(location_id)")

    # ── RLS — org + location scope on both ─────────────────────────────────
    _recreate_policy("syslog_events", f"({_ORG}) AND ({_LOC})", _ORG)
    _recreate_policy("discovery_results", f"({_ORG}) AND ({_LOC})", _ORG)

    # ── fix NOT NULL + ON DELETE SET NULL contradictions ───────────────────
    # Every FK on a NOT NULL location_id column whose ON DELETE is SET NULL
    # (confdeltype 'n') is rebuilt ON DELETE RESTRICT — a contradiction:
    # SET NULL cannot apply to a NOT NULL column.
    op.execute("""
        DO $fix$
        DECLARE r RECORD;
        BEGIN
          FOR r IN
            SELECT con.conname, con.conrelid::regclass::text AS tbl
            FROM pg_constraint con
            JOIN pg_attribute a
              ON a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)
            WHERE con.contype = 'f'
              AND con.confrelid = 'locations'::regclass
              AND con.confdeltype = 'n'           -- ON DELETE SET NULL
              AND a.attname = 'location_id'
              AND a.attnotnull                    -- column is NOT NULL
          LOOP
            EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
            EXECUTE format(
              'ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (location_id) '
              'REFERENCES locations(id) ON DELETE RESTRICT', r.tbl, r.conname);
          END LOOP;
        END $fix$;
    """)


def downgrade() -> None:
    _recreate_policy("syslog_events", _ORG, _ORG)
    _recreate_policy("discovery_results", _ORG, _ORG)
    op.execute("ALTER TABLE discovery_results DROP CONSTRAINT IF EXISTS "
               "discovery_results_location_id_fkey")
    op.execute("DROP INDEX IF EXISTS ix_discovery_results_location_id")
    op.execute("ALTER TABLE discovery_results DROP COLUMN IF EXISTS location_id")
    op.execute("DROP INDEX IF EXISTS ix_syslog_events_location_id")
    op.execute("ALTER TABLE syslog_events DROP COLUMN IF EXISTS location_id")
    # the SET NULL ↔ RESTRICT FK swap is intentionally not reverted —
    # RESTRICT is correct regardless of this migration.
