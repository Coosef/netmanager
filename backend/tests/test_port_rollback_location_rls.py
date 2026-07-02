"""RBAC-SPRINT-2.2C-BR — port_change_rollbacks location-scoped RLS.

Two classes of tests live here:

  1. Source-grep pins on the migration module — these ALWAYS run in CI
     (they only need to import + read the migration source). They lock
     the revision chain, the composite USING/WITH CHECK clause shape,
     the super_admin bypass, and the downgrade contract that restores
     the pre-2.2C-BR org-only policy verbatim.

  2. Real-Postgres integration tests — spin up a scratch table with
     the actual `pcr_isolation` policy applied, seed rows across
     multiple orgs and locations, and drive the six RBAC persona
     scenarios (super_admin / org_admin / location_admin — with the
     wrong-org, missing-GUC, and cross-location fail-closed shapes
     the operator brief demands). These are SKIPPED when a
     `TEST_POSTGRES_DSN` env var is absent (which is the default in
     the SQLite-backed CI backend job); operators run them locally
     against a scratch Postgres and (once CI grows a Postgres
     service) they'll flip on automatically.

The tests deliberately do NOT touch `backend/app/api/v1/endpoints/
port_control.py` — this PR is RLS-only. A separate source-scope pin
enforces that constraint.
"""
from __future__ import annotations

import importlib.util
import os
import re
import subprocess
import textwrap
import time
import uuid
from pathlib import Path
from types import SimpleNamespace
from typing import Generator, Iterator

import pytest


_MIGRATION_PATH = (
    Path(__file__).resolve().parent.parent
    / "alembic" / "versions"
    / "f9ao_port_change_rollback_location_rls.py"
)
_F9A6_PATH = (
    Path(__file__).resolve().parent.parent
    / "alembic" / "versions"
    / "f9a6_port_change_rollback.py"
)
_PORT_CONTROL_PATH = (
    Path(__file__).resolve().parent.parent
    / "app" / "api" / "v1" / "endpoints"
    / "port_control.py"
)


# ══════════════════════════════════════════════════════════════════════
#  Class 1 — source-grep pins (always run, no external deps).
# ══════════════════════════════════════════════════════════════════════


def _load_migration_module():
    """Import the migration file without going through alembic (which
    would need op.get_bind()). Same shim the existing sprint tests
    use for f9aj / f9ak / f9al / f9am."""
    import sys
    import types
    if "alembic" not in sys.modules:
        sys.modules["alembic"] = types.ModuleType("alembic")
    calls = []
    sys.modules["alembic"].op = SimpleNamespace(
        execute=lambda sql, *a, **kw: calls.append(sql),
        get_bind=lambda: None,
    )
    spec = importlib.util.spec_from_file_location(
        "f9ao_port_change_rollback_location_rls", _MIGRATION_PATH,
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod, calls


@pytest.fixture(scope="module")
def migration():
    mod, _calls = _load_migration_module()
    return mod


def test_migration_revision_chain(migration):
    assert migration.revision == "f9aopcrlocrls"
    assert migration.down_revision == "f9amfirmwarereadauth", (
        "must chain from f9am (Firmware read authorization, Sprint 2.2C-A)"
    )


def test_upgrade_installs_location_aware_policy():
    """Run upgrade against a fake op; assert the emitted SQL contains
    the composite USING/WITH CHECK clause with all three markers
    (super_admin bypass, org filter, location filter)."""
    mod, calls = _load_migration_module()
    mod.upgrade()
    joined = "\n".join(calls)
    # Sanity: exactly one DROP + one CREATE.
    assert joined.count("DROP POLICY IF EXISTS pcr_isolation ON port_change_rollbacks") == 1
    assert joined.count("CREATE POLICY pcr_isolation ON port_change_rollbacks") == 1
    # Super-admin bypass.
    assert "current_setting('app.is_super_admin', true) = 'on'" in joined
    # Org filter.
    assert "organization_id = NULLIF(current_setting('app.current_org_id', true), '')::int" in joined
    # Location filter — both the NULL guard and the equality arm.
    assert "NULLIF(current_setting('app.current_location_id', true), '') IS NULL" in joined
    assert "location_id = NULLIF(current_setting('app.current_location_id', true), '')::int" in joined
    # USING and WITH CHECK both present.
    assert "USING (" in joined
    assert "WITH CHECK (" in joined


def test_using_and_with_check_carry_same_clause():
    """USING and WITH CHECK must share the same expression so read and
    write scope contracts cannot drift. The migration keeps them in a
    single constant `_LOCATION_AWARE_CLAUSE` — the emitted CREATE
    POLICY string should therefore have the clause interpolated twice
    verbatim."""
    mod, calls = _load_migration_module()
    mod.upgrade()
    joined = "\n".join(calls)
    create = next(c for c in calls if "CREATE POLICY" in c)
    # Extract the USING(...) body and the WITH CHECK(...) body.
    using_match = re.search(r"USING \(\s*(.*?)\s*\)\s*WITH CHECK", create, flags=re.DOTALL)
    with_check_match = re.search(r"WITH CHECK \(\s*(.*?)\s*\)\s*$", create.strip(), flags=re.DOTALL)
    assert using_match, "could not locate USING clause body"
    assert with_check_match, "could not locate WITH CHECK clause body"
    # Same body — collapse whitespace to defeat cosmetic drift.
    def _norm(s: str) -> str:
        return re.sub(r"\s+", " ", s).strip()
    assert _norm(using_match.group(1)) == _norm(with_check_match.group(1)), (
        "USING and WITH CHECK clauses drifted — they MUST share the "
        "same expression so read + write scope contracts stay aligned"
    )


def test_downgrade_restores_pre_2_2c_br_org_only_policy():
    """Downgrade must emit the exact f9a6 org-only policy body so a
    `downgrade f9amfirmwarereadauth` returns the table to its
    pre-2.2C-BR state byte-identically."""
    mod, calls = _load_migration_module()
    mod.downgrade()
    joined = "\n".join(calls)
    assert "CREATE POLICY pcr_isolation ON port_change_rollbacks" in joined
    # Super-admin bypass.
    assert "current_setting('app.is_super_admin', true) = 'on'" in joined
    # Org filter (present in both directions — that's fine).
    assert "organization_id = NULLIF(current_setting('app.current_org_id', true), '')::int" in joined
    # LOCATION filter MUST NOT appear in the downgrade — that's the
    # whole point of restoring the pre-2.2C-BR shape.
    assert "current_location_id" not in joined, (
        "downgrade must NOT restore the location filter; it should "
        "restore the pre-2.2C-BR org-only policy verbatim"
    )


def test_migration_uses_drop_if_exists_defensively():
    """The migration must DROP with IF EXISTS so a partial prior state
    (policy missing) does not fail-open at CREATE. This is the same
    defensive pattern used across the f9a* RLS migrations."""
    src = _MIGRATION_PATH.read_text(encoding="utf-8")
    assert "DROP POLICY IF EXISTS pcr_isolation" in src


def test_f9a6_policy_still_defines_the_target_of_this_migration():
    """Sanity: the f9a6 base migration must still define a `pcr_isolation`
    policy on `port_change_rollbacks`. If a future refactor renames it
    or removes it, this migration's DROP + CREATE would silently drift
    (the DROP would no-op, the CREATE would still install our new one,
    but the human review chain assumes f9a6 as the parent shape)."""
    src = _F9A6_PATH.read_text(encoding="utf-8")
    assert "CREATE POLICY pcr_isolation ON port_change_rollbacks" in src
    assert "ENABLE ROW LEVEL SECURITY" in src
    assert "FORCE ROW LEVEL SECURITY" in src


# ══════════════════════════════════════════════════════════════════════
#  Scope isolation — this PR MUST NOT touch port_control.py or the
#  gate helper. Pin the file's on-disk shape indirectly by checking
#  that specific lines and identifiers are still where they were.
# ══════════════════════════════════════════════════════════════════════


def test_port_control_endpoint_module_untouched_by_this_pr():
    """Sprint 2.2C-BR is RLS-only. `port_control.py` MUST NOT gain new
    verb wiring, gate helpers, or endpoint changes. Guard against a
    stray edit that piggybacks a scope creep."""
    src = _PORT_CONTROL_PATH.read_text(encoding="utf-8")
    # `_require_edit` helper unchanged verbatim.
    assert (
        'if not current_user.has_permission("device:edit") '
        'and not current_user.is_super_admin:'
    ) in src, "_require_edit helper body drifted"
    # No new `port_control:*` verbs wired at any has_permission site.
    assert 'has_permission("port_control:' not in src, (
        "port_control:* verbs are reserved for the deferred mutating "
        "Sprint 2.2C-B / 2.2C-C PRs — this PR is RLS-only"
    )
    # No `firmware:*` etc. accidentally added here either.
    for verb_family in ("firmware:", "sla:", "services:", "poe:"):
        assert f'has_permission("{verb_family}' not in src, (
            f"{verb_family}* verbs must not be wired inside port_control.py "
            f"in this PR — RLS-only scope"
        )


# ══════════════════════════════════════════════════════════════════════
#  Class 2 — real-Postgres integration tests. SKIPPED when
#  `TEST_POSTGRES_DSN` is unset (default in the SQLite-backed CI
#  backend job).
# ══════════════════════════════════════════════════════════════════════


_TEST_DSN = os.environ.get("TEST_POSTGRES_DSN")
_pytestmark_pg_only = pytest.mark.skipif(
    _TEST_DSN is None,
    reason=(
        "TEST_POSTGRES_DSN not set — RLS integration tests require a "
        "real PostgreSQL. Set the env var (e.g. "
        "postgresql://user:pw@localhost:5432/dbname) locally to run "
        "them, or wait for the CI backend job to gain a Postgres service."
    ),
)


@pytest.fixture(scope="module")
def _pg_conn():
    """One connection for the module. Rolls back nothing here — each
    scenario uses its OWN transaction with its own GUC context, and
    the scratch table is dropped in module teardown."""
    if _TEST_DSN is None:
        pytest.skip("no TEST_POSTGRES_DSN")
    psycopg2 = pytest.importorskip("psycopg2")
    conn = psycopg2.connect(_TEST_DSN)
    conn.autocommit = False
    # Create the RLS test user once per module. Idempotent — the CREATE
    # ROLE ... IF NOT EXISTS pattern is not supported directly, so use
    # a DO block. The role is NOSUPERUSER + NOBYPASSRLS so
    # SET LOCAL SESSION AUTHORIZATION downgrades correctly.
    with conn.cursor() as cur:
        cur.execute("""
            DO $$
            BEGIN
              IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pcr_rls_test_user') THEN
                CREATE ROLE pcr_rls_test_user NOLOGIN NOSUPERUSER NOBYPASSRLS;
              END IF;
            END $$;
        """)
    conn.commit()
    yield conn
    conn.close()


# A short suffix so parallel test runs don't collide on the scratch
# schema. Using a UUID keeps two developers running the suite
# side-by-side against the same DB from stomping each other.
_SCRATCH_SUFFIX = uuid.uuid4().hex[:8]
_SCRATCH_TABLE = f"pcr_rls_test_{_SCRATCH_SUFFIX}"


@pytest.fixture(scope="module")
def _scratch_schema(_pg_conn):
    """Create a minimal port_change_rollbacks lookalike (with the two
    scope columns), install the target policy on it, seed the rows the
    scenarios need, and drop the table at teardown.

    We do NOT run the real migration against the caller's database:
    that would require the full schema chain from base up to
    f9amfirmwarereadauth. Instead we install a MINIMAL table with the
    same three RLS-relevant columns (`organization_id`, `location_id`,
    plus an `id`) and apply the exact policy SQL the migration emits.
    That validates the policy semantics — the only concern of this PR."""
    with _pg_conn.cursor() as cur:
        cur.execute(f"""
            CREATE TABLE {_SCRATCH_TABLE} (
              id              serial      PRIMARY KEY,
              organization_id integer     NOT NULL,
              location_id     integer     NULL,
              tag             text        NOT NULL
            )
        """)
        cur.execute(f"ALTER TABLE {_SCRATCH_TABLE} ENABLE ROW LEVEL SECURITY")
        cur.execute(f"ALTER TABLE {_SCRATCH_TABLE} FORCE ROW LEVEL SECURITY")
        cur.execute(f"""
            CREATE POLICY pcr_isolation ON {_SCRATCH_TABLE}
            FOR ALL
            USING (
                current_setting('app.is_super_admin', true) = 'on'
                OR (
                    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::int
                    AND (
                        NULLIF(current_setting('app.current_location_id', true), '') IS NULL
                        OR location_id = NULLIF(current_setting('app.current_location_id', true), '')::int
                    )
                )
            )
            WITH CHECK (
                current_setting('app.is_super_admin', true) = 'on'
                OR (
                    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::int
                    AND (
                        NULLIF(current_setting('app.current_location_id', true), '') IS NULL
                        OR location_id = NULLIF(current_setting('app.current_location_id', true), '')::int
                    )
                )
            )
        """)
        # Seed as the connection's superuser (BYPASSRLS) so WITH CHECK
        # doesn't reject the inserts and no GUC/session juggling is needed.
        cur.execute(f"""
            INSERT INTO {_SCRATCH_TABLE} (organization_id, location_id, tag)
            VALUES
              (1, 1, 'org1_loc1'),
              (1, 2, 'org1_loc2'),
              (1, NULL, 'org1_locnull'),
              (2, 1, 'org2_loc1'),
              (2, 2, 'org2_loc2')
        """)
        # Grant the RLS test user access on the scratch table so the
        # SET LOCAL SESSION AUTHORIZATION in _set_context can query
        # (RLS then filters the visible rows).
        cur.execute(
            f"GRANT SELECT, INSERT, UPDATE, DELETE ON {_SCRATCH_TABLE} "
            f"TO pcr_rls_test_user"
        )
    _pg_conn.commit()
    yield
    with _pg_conn.cursor() as cur:
        cur.execute(f"DROP TABLE IF EXISTS {_SCRATCH_TABLE}")
    _pg_conn.commit()


def _set_context(cur, org_id, location_id=None, is_super_admin=False) -> None:
    """SET LOCAL the three GUCs + drop session authorization to a
    non-superuser role for the current transaction.

    Postgres superusers (and roles with BYPASSRLS) skip RLS entirely
    even under FORCE ROW LEVEL SECURITY. The scratch fixture DDL
    needs a superuser to run, but the RLS test itself must run as a
    non-superuser or the whole check becomes a no-op. `SET LOCAL
    SESSION AUTHORIZATION` downgrades to a NOBYPASSRLS role for the
    lifetime of the current transaction; ROLLBACK restores the
    original session role automatically."""
    cur.execute("SET LOCAL SESSION AUTHORIZATION pcr_rls_test_user")
    cur.execute(
        "SELECT set_config('app.current_org_id', %s, true), "
        "set_config('app.current_location_id', %s, true), "
        "set_config('app.is_super_admin', %s, true)",
        (
            str(org_id) if org_id is not None else "",
            str(location_id) if location_id is not None else "",
            "on" if is_super_admin else "off",
        ),
    )


def _visible_tags(cur, table) -> set[str]:
    cur.execute(f"SELECT tag FROM {table} ORDER BY id")
    return {row[0] for row in cur.fetchall()}


# ── A. super_admin — sees every row ───────────────────────────────────


@_pytestmark_pg_only
def test_A_super_admin_sees_all_rows(_pg_conn, _scratch_schema):
    with _pg_conn.cursor() as cur:
        _set_context(cur, org_id=None, location_id=None, is_super_admin=True)
        tags = _visible_tags(cur, _SCRATCH_TABLE)
    _pg_conn.rollback()
    assert tags == {
        "org1_loc1", "org1_loc2", "org1_locnull",
        "org2_loc1", "org2_loc2",
    }, "super_admin must see rows across every org and location"


# ── B. org_admin — sees every row in their org, none elsewhere ────────


@_pytestmark_pg_only
def test_B_org_admin_sees_own_org_across_all_locations(_pg_conn, _scratch_schema):
    with _pg_conn.cursor() as cur:
        _set_context(cur, org_id=1, location_id=None, is_super_admin=False)
        tags = _visible_tags(cur, _SCRATCH_TABLE)
    _pg_conn.rollback()
    assert tags == {"org1_loc1", "org1_loc2", "org1_locnull"}, (
        "org_admin (current_location_id=NULL) must see every row in "
        "their organization regardless of location"
    )


# ── C. location_admin — sees ONLY matching location, nothing else ────


@_pytestmark_pg_only
def test_C_location_admin_only_sees_own_location(_pg_conn, _scratch_schema):
    with _pg_conn.cursor() as cur:
        _set_context(cur, org_id=1, location_id=1, is_super_admin=False)
        tags = _visible_tags(cur, _SCRATCH_TABLE)
    _pg_conn.rollback()
    assert tags == {"org1_loc1"}, (
        "location_admin at (org=1, loc=1) MUST only see rows at that "
        "exact (org, loc); cross-location leak detected: " + str(tags)
    )


@_pytestmark_pg_only
def test_C_location_admin_does_not_see_other_org_matching_loc(_pg_conn, _scratch_schema):
    """Guard: (org=1, loc=1) and (org=2, loc=1) share a location_id,
    but the org clause fires first — the caller must never see the
    org=2 row."""
    with _pg_conn.cursor() as cur:
        _set_context(cur, org_id=1, location_id=1, is_super_admin=False)
        cur.execute(
            f"SELECT organization_id FROM {_SCRATCH_TABLE} "
            f"WHERE tag = 'org2_loc1'"
        )
        rows = cur.fetchall()
    _pg_conn.rollback()
    assert rows == [], (
        "org=2 row with matching loc=1 was visible to org=1 caller — "
        "org isolation regressed"
    )


@_pytestmark_pg_only
def test_C_location_admin_does_not_see_null_location_rows(_pg_conn, _scratch_schema):
    """`location_id IS NULL` rows are visible ONLY to super_admin and
    to callers with NULL current_location_id (i.e. org_admin).
    A location_admin never sees them — that's the intended
    fail-closed behavior when the owning device has been unlinked
    from a location."""
    with _pg_conn.cursor() as cur:
        _set_context(cur, org_id=1, location_id=1, is_super_admin=False)
        cur.execute(
            f"SELECT tag FROM {_SCRATCH_TABLE} WHERE tag = 'org1_locnull'"
        )
        rows = cur.fetchall()
    _pg_conn.rollback()
    assert rows == [], (
        "location_admin saw a NULL-location row; should have been "
        "fail-closed"
    )


# ── D. location_admin UPDATE / DELETE contracts ──────────────────────


@_pytestmark_pg_only
def test_D_location_admin_can_update_own_location_row(_pg_conn, _scratch_schema):
    with _pg_conn.cursor() as cur:
        _set_context(cur, org_id=1, location_id=1, is_super_admin=False)
        cur.execute(
            f"UPDATE {_SCRATCH_TABLE} SET tag = 'org1_loc1_touched' "
            f"WHERE tag = 'org1_loc1'"
        )
        rowcount = cur.rowcount
    _pg_conn.rollback()
    assert rowcount == 1, (
        f"UPDATE rowcount for own-location row was {rowcount}, expected 1"
    )


@_pytestmark_pg_only
def test_D_location_admin_update_on_foreign_location_is_zero_rows(_pg_conn, _scratch_schema):
    with _pg_conn.cursor() as cur:
        _set_context(cur, org_id=1, location_id=1, is_super_admin=False)
        cur.execute(
            f"UPDATE {_SCRATCH_TABLE} SET tag = 'HIJACK' "
            f"WHERE tag = 'org1_loc2'"
        )
        rowcount = cur.rowcount
    _pg_conn.rollback()
    assert rowcount == 0, (
        f"cross-location UPDATE rowcount was {rowcount}, expected 0 "
        f"(policy failed to block foreign-location write)"
    )


@_pytestmark_pg_only
def test_D_location_admin_delete_on_foreign_location_is_zero_rows(_pg_conn, _scratch_schema):
    with _pg_conn.cursor() as cur:
        _set_context(cur, org_id=1, location_id=1, is_super_admin=False)
        cur.execute(
            f"DELETE FROM {_SCRATCH_TABLE} WHERE tag = 'org1_loc2'"
        )
        rowcount = cur.rowcount
    _pg_conn.rollback()
    assert rowcount == 0, (
        f"cross-location DELETE rowcount was {rowcount}, expected 0"
    )


# ── E. Fail-closed on missing / invalid GUC context ──────────────────


@_pytestmark_pg_only
def test_E_missing_current_org_id_returns_zero_rows(_pg_conn, _scratch_schema):
    """When app.current_org_id GUC is unset (or empty), the NULLIF
    reduces to NULL and equality never matches. The caller sees zero
    rows — this is the RLS fail-closed contract."""
    with _pg_conn.cursor() as cur:
        _set_context(cur, org_id=None, location_id=None, is_super_admin=False)
        tags = _visible_tags(cur, _SCRATCH_TABLE)
    _pg_conn.rollback()
    assert tags == set(), (
        "missing app.current_org_id must fail-closed (zero rows); "
        f"saw {tags}"
    )


@_pytestmark_pg_only
def test_E_wrong_org_returns_zero_rows(_pg_conn, _scratch_schema):
    """org=99 doesn't exist — user must see zero rows regardless of
    location_id."""
    with _pg_conn.cursor() as cur:
        _set_context(cur, org_id=99, location_id=None, is_super_admin=False)
        tags = _visible_tags(cur, _SCRATCH_TABLE)
    _pg_conn.rollback()
    assert tags == set()


# ── F. Policy contract sanity (via pg_policies catalog) ───────────────


@_pytestmark_pg_only
def test_F_policy_qual_contains_org_and_loc_and_super_admin(_pg_conn, _scratch_schema):
    """Read the installed policy definition back from `pg_policies`
    and assert the three markers are all present in both `qual`
    (USING clause) and `with_check`."""
    with _pg_conn.cursor() as cur:
        cur.execute(
            "SELECT qual, with_check FROM pg_policies "
            "WHERE tablename = %s AND policyname = 'pcr_isolation'",
            (_SCRATCH_TABLE,),
        )
        row = cur.fetchone()
    _pg_conn.rollback()
    assert row is not None, "pcr_isolation policy missing from pg_policies"
    qual, with_check = row
    for expr in (qual, with_check):
        assert "app.is_super_admin" in expr
        assert "app.current_org_id" in expr
        assert "app.current_location_id" in expr


# ── G. Cross-org UPDATE still blocked (regression against the pre-fix
#      contract that only enforced org isolation) ─────────────────────


@_pytestmark_pg_only
def test_G_cross_org_update_is_zero_rows(_pg_conn, _scratch_schema):
    """This is the ONE assertion the pre-2.2C-BR policy already
    guaranteed. It MUST continue to hold — a regression here would
    mean the org-level contract got weakened by the location filter,
    which is exactly what this migration must NOT do."""
    with _pg_conn.cursor() as cur:
        _set_context(cur, org_id=1, location_id=None, is_super_admin=False)
        cur.execute(
            f"UPDATE {_SCRATCH_TABLE} SET tag = 'ORG_HIJACK' "
            f"WHERE tag = 'org2_loc1'"
        )
        rowcount = cur.rowcount
    _pg_conn.rollback()
    assert rowcount == 0
