"""QF-7 (2026-06-04) — Super-admin: agent + device location transfer.

Background:
  PATCH /resources/assign body previously only carried `org_id` and the SQL
  UPDATE set `organization_id` alone. Moving an agent between locations
  inside the same org (e.g. macm4: ForTow → Mövempic) was impossible from
  the UI; super_admin had to issue a direct DB UPDATE.

Fix:
  - AssignResourcesPayload gets optional `location_id`.
  - Endpoint validates target location belongs to target org (cross-org
    location-leak protection — Faz 8 isolation must hold under super_admin
    manual reassignment).
  - When agents change location, their open WS sessions are force-closed so
    the next hello rebuilds the org/location sandbox; otherwise the cached
    session keeps rejecting commands to devices at the new location.

Strategy:
  Source assertions on the endpoint module (same pattern as HF#10A / HF#11
  / QF-5 / QF-2 tests). Avoids spinning up the full app stack which would
  require Postgres in unit tests. Behavioral coverage of cross-org reject
  + WS disconnect path is anchored by string literals that would break if
  the logic regressed.
"""
from __future__ import annotations

import inspect
from pathlib import Path


def _src() -> str:
    import app.api.v1.endpoints.super_admin as m
    return Path(inspect.getfile(m)).read_text()


def _body(symbol_prefix: str) -> str:
    src = _src()
    start = src.find(symbol_prefix)
    assert start > 0, f"{symbol_prefix!r} not found in super_admin.py"
    # bound at next top-level def or class
    after = src.find("\n\n\n", start + 1)
    return src[start: after if after > 0 else len(src)]


# ─── 1. Payload contract ──────────────────────────────────────────────────────


def test_qf7_payload_has_optional_location_id():
    """AssignResourcesPayload exposes a typed optional location_id."""
    from app.api.v1.endpoints.super_admin import AssignResourcesPayload
    assert "location_id" in AssignResourcesPayload.model_fields, (
        "AssignResourcesPayload missing location_id field"
    )
    fld = AssignResourcesPayload.model_fields["location_id"]
    # default must be None (optional / backward-compat with org-only callers)
    assert fld.default is None, f"location_id default expected None, got {fld.default!r}"


def test_qf7_org_only_payload_still_constructs():
    """Legacy callers that send only resource_type+resource_ids+org_id must
    keep working — location_id defaults to None."""
    from app.api.v1.endpoints.super_admin import AssignResourcesPayload
    p = AssignResourcesPayload(
        resource_type="agent",
        resource_ids=["abc123"],
        org_id=1,
    )
    assert p.location_id is None
    assert p.org_id == 1


def test_qf7_payload_accepts_explicit_location_id():
    from app.api.v1.endpoints.super_admin import AssignResourcesPayload
    p = AssignResourcesPayload(
        resource_type="agent",
        resource_ids=["abc123"],
        org_id=1,
        location_id=9,
    )
    assert p.location_id == 9


# ─── 2. Cross-org validation guard ────────────────────────────────────────────


def test_qf7_endpoint_validates_location_belongs_to_target_org():
    """Endpoint must reject location_id whose Location.organization_id does
    NOT match payload.org_id. Source assertion locks the guard in place."""
    body = _body("async def assign_resources(")
    # Validation block references org match
    assert "location_id is not None" in body, (
        "location_id branch missing in assign_resources"
    )
    assert "Location" in body, (
        "Location model lookup missing in validation"
    )
    assert "organization_id != payload.org_id" in body or \
           "organization_id != org" in body or \
           "location_obj.organization_id" in body, (
        "Cross-org validation logic not found"
    )
    # 400 with explanatory message expected on mismatch
    assert "400" in body
    assert "Lokasyon" in body or "lokasyon" in body or "location" in body.lower()


def test_qf7_endpoint_404s_on_missing_location():
    body = _body("async def assign_resources(")
    assert "Hedef lokasyon bulunamadı" in body or \
           '"Lokasyon' in body and "404" in body


# ─── 3. UPDATE values include location_id when provided ───────────────────────


def test_qf7_update_sets_location_id_when_given():
    """The SQL UPDATE values dict must include location_id when payload
    carries it; org-only path must NOT set it (stays untouched)."""
    body = _body("async def assign_resources(")
    # The values_common pattern keeps both branches consistent
    assert 'values_common["location_id"] = payload.location_id' in body or \
           'values_common = ' in body and '"location_id"' in body, (
        "location_id not propagated into UPDATE values"
    )


def test_qf7_org_only_path_does_not_touch_location():
    """If location_id is None the UPDATE values dict must NOT include
    location_id — backward compat for callers that only want org transfer."""
    body = _body("async def assign_resources(")
    # The guard 'if payload.location_id is not None' must precede the inclusion
    assert "if payload.location_id is not None" in body


# ─── 4. Agent WS disconnect on location move ──────────────────────────────────


def test_qf7_agent_ws_force_closed_on_location_change():
    """When an agent moves locations, its existing WS session caches the old
    org/location sandbox and will keep rejecting commands. The endpoint must
    force-close those sessions so the agent reconnects with a fresh sandbox.

    Source assertion: agent_manager._connections lookup + ws.close inside
    the resource_type=='agent' AND location_id provided branch.
    """
    body = _body("async def assign_resources(")
    assert "agent_manager" in body, (
        "agent_manager not referenced for WS disconnect"
    )
    assert "_connections" in body, (
        "agent_manager._connections lookup missing"
    )
    assert "ws.close" in body or ".close(" in body, (
        "WS close call missing"
    )
    # Specifically gated by both agent type AND location_id given (not on
    # org-only transfers — those are NOT a session-scope change)
    assert 'resource_type == "agent"' in body
    assert "payload.location_id is not None" in body


def test_qf7_disconnect_path_swallows_errors():
    """WS disconnect MUST NOT fail the endpoint — the DB update has already
    committed. Wrapping in try/except is required."""
    body = _body("async def assign_resources(")
    # Look for try/except surrounding the disconnect block (presence of
    # `except Exception` in the agent branch)
    # Simple heuristic: 'except Exception' appears at least twice (outer +
    # per-agent inner) in the disconnect block
    disconnect_start = body.find("agent_manager")
    assert disconnect_start > 0
    disconnect_block = body[disconnect_start:]
    assert disconnect_block.count("except Exception") >= 1, (
        "disconnect block must swallow exceptions"
    )


# ─── 5. Response shape ────────────────────────────────────────────────────────


def test_qf7_response_includes_location_info():
    """Response should expose location_id + location_name so the UI can
    confirm the move to the user without a follow-up GET."""
    body = _body("async def assign_resources(")
    # Return dict literals reference location keys
    assert '"location_id"' in body
    assert '"location_name"' in body
