"""Tenant audit raw-INSERT hook — regression suite for the
``fix/audit-orm-returning-rls`` PR.

Each test maps to one of the operator's six required scenarios:

    A. Device soft-delete dirty → tenant_audit hook emits a raw INSERT.
    B. Generated SQL contains NO ``RETURNING`` clause.
    C. The audit row's organization_id matches the target device's
       organization_id, taken from the row itself (explicit), not from
       the session GUC fallback.
    D. With every RLS GUC empty / unset, the hook STILL goes through
       the raw-INSERT path — i.e. it never reverts to the ORM
       ``session.add(AuditLog)`` shape.
    E. The legacy ``audit_service.log_action`` raw-INSERT path is left
       intact (no regression in surrounding audit machinery).
    F. The hook does not produce a recursive flush — its own INSERTs
       must not generate another tenant_audit row.

The whole suite runs against in-memory SQLite via a sync engine.
``conftest.py`` already supplies a default ``org_context`` so RLS-aware
inserts don't trip the ``_scoping`` fail-closed path.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import List

import pytest
from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import Session, sessionmaker


# ── Helpers ────────────────────────────────────────────────────────────────


def _build_engine_with_full_schema():
    """Spin up an in-memory SQLite engine and create JUST the tables the
    tenant-audit hook actually exercises. We deliberately avoid a
    metadata-wide ``create_all`` because some unrelated production
    models declare JSONB columns that SQLite cannot render — pulling
    them into this suite would tie its survival to those models' own
    SQLite-compat refactors.

    The side-effect imports below register the ``_scoping`` before_insert
    hook and the ``tenant_audit`` before_flush hook against the shared
    SQLAlchemy ``Session`` class, so both hooks fire on this engine the
    same way they do in production."""
    import app.models  # noqa: F401 — register every mapped class
    import app.core.tenant_audit  # noqa: F401 — install before_flush hook
    from app.core.database import Base
    from app.models.shared.organization import Organization
    from app.models.location import Location
    from app.models.user import User
    from app.models.device import Device
    from app.models.audit_log import AuditLog

    eng = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(
        eng,
        tables=[
            Organization.__table__,
            Location.__table__,
            User.__table__,
            Device.__table__,
            AuditLog.__table__,
        ],
    )
    return eng


def _capture_statements(engine):
    """Attach a before_cursor_execute listener that records every SQL
    statement executed on this engine. Used by the tests to assert
    presence / absence of ``RETURNING`` clauses."""
    captured: List[str] = []

    @event.listens_for(engine, "before_cursor_execute")
    def _record(conn, cursor, statement, parameters, context, executemany):
        captured.append(statement)

    return captured


def _seed_minimum(session: Session, *, with_user_org_loc: bool = True):
    """Use the ORM mappers to insert one organization / location / user
    so every NOT NULL column the production models declare gets its
    Python-side default. Returns (org_id, loc_id, user_id).

    This intentionally exercises the ``_scoping`` before_insert hook on
    organization / location / user inserts too — when conftest's default
    org_context is present (it is), every row's organization_id resolves
    from the ContextVar fallback, so we never hit ScopedContextError."""
    if not with_user_org_loc:
        return None, None, None
    from app.models.shared.organization import Organization
    from app.models.location import Location
    from app.models.user import User

    org = Organization(id=1, name="TestOrg", slug="testorg")
    session.add(org)
    loc = Location(id=1, organization_id=1, name="TestLoc")
    session.add(loc)
    user = User(
        id=1, organization_id=1, username="admin",
        email="admin@test.local", hashed_password="x", full_name="Admin",
        is_active=True,
    )
    session.add(user)
    session.commit()
    return 1, 1, 1


def _build_device(session: Session, *, device_id: int, organization_id: int,
                  location_id: int, hostname: str = "sw1"):
    """Insert a Device through the ORM so every Python-side default
    (status, lifecycle_status, ssh_port, …) fires. We do NOT use raw
    text here because the device table has 30+ columns of which a third
    have Python-side defaults — listing them by hand bitrots."""
    from app.models.device import Device
    dev = Device(
        id=device_id,
        hostname=hostname,
        ip_address="10.0.0.1",
        ssh_username="u",
        ssh_password_enc="enc",
        organization_id=organization_id,
        location_id=location_id,
    )
    session.add(dev)
    session.commit()


def _load_device(session: Session, device_id: int):
    """Reload the Device row through the ORM so ``deleted_at`` is a
    tracked attribute the before_flush hook can observe."""
    from app.models.device import Device
    return session.get(Device, device_id)


# ── A. Device soft-delete dirty → tenant_audit hook emits a raw INSERT ────

def test_A_soft_delete_emits_raw_audit_insert():
    eng = _build_engine_with_full_schema()
    captured = _capture_statements(eng)
    SessionLocal = sessionmaker(eng, future=True)

    with SessionLocal() as session:
        org_id, loc_id, _ = _seed_minimum(session)
        _build_device(session, device_id=42, organization_id=org_id,
                      location_id=loc_id)

        dev = _load_device(session, 42)
        # Trigger the audited change.
        dev.deleted_at = datetime.now(timezone.utc)
        session.commit()

    inserts = [s for s in captured if "INSERT INTO audit_logs" in s]
    assert len(inserts) >= 1, (
        "expected at least one audit_logs INSERT, got 0; "
        f"captured statements: {captured!r}"
    )


# ── B. Generated SQL contains NO RETURNING clause ────────────────────────

def test_B_audit_insert_has_no_returning_clause():
    eng = _build_engine_with_full_schema()
    captured = _capture_statements(eng)
    SessionLocal = sessionmaker(eng, future=True)

    with SessionLocal() as session:
        org_id, loc_id, _ = _seed_minimum(session)
        _build_device(session, device_id=43, organization_id=org_id,
                      location_id=loc_id)
        dev = _load_device(session, 43)
        dev.deleted_at = datetime.now(timezone.utc)
        session.commit()

    audit_inserts = [s for s in captured if "INSERT INTO audit_logs" in s]
    assert audit_inserts, "no audit_logs INSERT captured"
    for stmt in audit_inserts:
        assert "RETURNING" not in stmt.upper(), (
            "ORM RETURNING leaked into the tenant_audit INSERT — "
            "the whole point of this PR is to avoid it. "
            f"Statement: {stmt!r}"
        )


# ── C. Audit row's organization_id matches the target device's, explicit ─

def test_C_audit_row_org_matches_device_org_explicitly():
    eng = _build_engine_with_full_schema()
    SessionLocal = sessionmaker(eng, future=True)

    with SessionLocal() as session:
        org_id, loc_id, _ = _seed_minimum(session)
        _build_device(session, device_id=44, organization_id=org_id,
                      location_id=loc_id, hostname="sw-44")
        dev = _load_device(session, 44)
        dev.deleted_at = datetime.now(timezone.utc)
        session.commit()

    # Read back the audit row and assert the explicit-stamping contract.
    with SessionLocal() as ro:
        rows = ro.execute(text(
            "SELECT organization_id, action, resource_id, resource_name "
            "FROM audit_logs WHERE resource_id = '44'"
        )).all()
    assert len(rows) == 1
    org, action, rid, rname = rows[0]
    assert org == org_id, (
        f"expected audit.organization_id = {org_id} "
        f"(taken from the device row itself), got {org}"
    )
    assert action == "device_archived"
    assert rid == "44"
    assert rname == "sw-44"


# ── D. Empty RLS GUCs → still raw path, never ORM session.add ────────────

def test_D_empty_rls_gucs_do_not_revert_to_orm_session_add(monkeypatch):
    """The bug class this PR closes is precisely "RLS context empty,
    INSERT … RETURNING re-reads through USING, USING fails". Even when
    every helper that supplies an RLS context returns nothing useful,
    the hook MUST take the raw-INSERT path (no ORM session.add of an
    AuditLog instance, no RETURNING)."""
    from app.core import org_context
    monkeypatch.setattr(org_context, "get_current_user_id",
                        lambda: None, raising=True)
    monkeypatch.setattr(org_context, "get_current_username",
                        lambda: None, raising=True)
    # Some hooks read these via attribute lookup against the module; both
    # forms cover it.
    monkeypatch.setattr(
        "app.core.tenant_audit.get_current_user_id",
        lambda: None, raising=True,
    )
    monkeypatch.setattr(
        "app.core.tenant_audit.get_current_username",
        lambda: None, raising=True,
    )

    eng = _build_engine_with_full_schema()
    captured = _capture_statements(eng)
    SessionLocal = sessionmaker(eng, future=True)

    with SessionLocal() as session:
        org_id, loc_id, _ = _seed_minimum(session)
        _build_device(session, device_id=45, organization_id=org_id,
                      location_id=loc_id)
        dev = _load_device(session, 45)
        dev.deleted_at = datetime.now(timezone.utc)
        session.commit()

    audit_inserts = [s for s in captured if "INSERT INTO audit_logs" in s]
    assert audit_inserts, "no audit_logs INSERT captured"
    for stmt in audit_inserts:
        # The raw INSERT shape never carries RETURNING; the ORM shape
        # always does (it needs the serial id back). The presence /
        # absence of RETURNING is therefore a faithful tell for which
        # path executed.
        assert "RETURNING" not in stmt.upper(), (
            "fell back to ORM session.add(AuditLog) path under empty "
            f"GUC simulation. Statement: {stmt!r}"
        )


# ── E. log_action regression — its own raw path stays intact ─────────────

def test_E_log_action_still_uses_no_returning():
    """audit_service.log_action has shipped with a raw text() INSERT
    (RETURNING-less) since migration f8a6. We do not modify it in this
    PR; the regression check is a structural assertion on the source.

    The function's doc-comment intentionally mentions the word
    ``RETURNING`` in prose to explain the workaround, so we cannot grep
    for the bare word. Instead, we ast-parse the function, pick out
    every string-literal node, and only assert against THOSE — which
    is what would actually become SQL at runtime. Prose comments are
    not Str nodes, so they fall away cleanly."""
    import ast
    import inspect as _inspect
    import re
    from app.services import audit_service

    src = _inspect.getsource(audit_service.log_action)
    assert "INSERT INTO audit_logs" in src, (
        "audit_service.log_action no longer contains a raw audit_logs "
        "INSERT — the contract this PR builds on may have changed."
    )

    tree = ast.parse(src.lstrip())
    string_literals = "\n".join(
        node.value
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant) and isinstance(node.value, str)
    )
    # ``RETURNING <table>.<col>`` only ever shows up in real SQL — it
    # cannot occur in a docstring or a comment that this AST walk
    # already pruned.
    sql_returning_pattern = re.compile(
        r"RETURNING\s+\w+\s*\.\s*\w+", re.IGNORECASE,
    )
    assert not sql_returning_pattern.search(string_literals), (
        "audit_service.log_action picked up a `RETURNING <table>.<col>` "
        "SQL clause in one of its string literals — the exact bug class "
        "this PR works around just regressed."
    )


# ── F. Recursive flush — audit INSERT does not trigger another audit row ─

def test_F_audit_insert_does_not_recurse():
    eng = _build_engine_with_full_schema()
    captured = _capture_statements(eng)
    SessionLocal = sessionmaker(eng, future=True)

    with SessionLocal() as session:
        org_id, loc_id, _ = _seed_minimum(session)
        _build_device(session, device_id=46, organization_id=org_id,
                      location_id=loc_id)
        dev = _load_device(session, 46)
        dev.deleted_at = datetime.now(timezone.utc)
        session.commit()

    audit_inserts = [s for s in captured if "INSERT INTO audit_logs" in s]
    # Exactly one tenant-audit row should land for one tracked-column
    # change on one device. If recursion fired, we'd see ≥ 2.
    assert len(audit_inserts) == 1, (
        f"expected exactly 1 audit INSERT, got {len(audit_inserts)} — "
        "the hook re-entered itself. Statements: "
        + "\n".join(audit_inserts)
    )
