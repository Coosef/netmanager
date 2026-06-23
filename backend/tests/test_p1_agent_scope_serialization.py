"""P1 HOTFIX (2026-06-23) — DEVICE-AGENT-SCOPE-SERIALIZATION regression.

Root cause (observed in production for device id=95 "Omurga", org=6,
loc=12, candidate agent=movempic id=rwnlq1i0o08c, org=6, loc=12):

  - GET /api/v1/agents/ used `response_model=list[dict]` and a manual
    `_agent_to_dict()` serializer that DID NOT include `organization_id`
    or `location_id` on each returned agent.
  - DeviceForm.tsx:184 filter:
        `if (a.organization_id !== activeOrgId) return false`
    evaluated `undefined !== 6` → true → every agent excluded → the
    "primary agent" dropdown only showed "None" even when a matching
    agent existed in the right org+location scope.

PR #104 widened the pydantic `AgentResponse` schema with the same two
fields for the *create* response path, but never reached the *list*
endpoint because the list endpoint bypasses pydantic via the manual
dict serializer.

This file pins the regression at the source level (mirrors the
`test_incident_hf10a_agents_public_router.py` source-assertion style)
plus a unit-level shape check on `_agent_to_dict` itself with a fake
Agent record.

NON-TOUCH (per operator authorization):
  - Tests DO NOT mutate the DB.
  - Tests DO NOT touch ForTow / Mövempic / loc=9 / Windows Agent.
  - No frontend change is covered here — the frontend filter was already
    written to the post-PR-#104 contract.
"""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace


# ─── Source-level pins ──────────────────────────────────────────────────


def _agents_src() -> str:
    from app.api.v1.endpoints import agents as ag
    return Path(ag.__file__).read_text()


def test_agent_to_dict_emits_organization_id_in_source():
    """_agent_to_dict must return `organization_id` so the frontend
    primary-agent dropdown filter can match agents to the active org."""
    src = _agents_src()
    assert '"organization_id": agent.organization_id,' in src, (
        "_agent_to_dict missing organization_id field — PR #104 widening "
        "never reached the list-endpoint serializer; frontend filter at "
        "DeviceForm.tsx:184 evaluates `undefined !== activeOrgId` → "
        "excludes every agent."
    )


def test_agent_to_dict_emits_location_id_in_source():
    """_agent_to_dict must return `location_id` so the frontend agent
    dropdown can narrow candidates down to the operator-selected
    location (backend enforces same-location constraint at write time)."""
    src = _agents_src()
    assert '"location_id": agent.location_id,' in src, (
        "_agent_to_dict missing location_id field — selectedLocationId "
        "filter at DeviceForm.tsx:186 cannot match without this field."
    )


def test_agent_to_dict_does_not_leak_secret_fields():
    """Defensive: this serializer must NOT expose agent_key_hash or any
    raw secret/auth material — the dropdown only needs scope + identity."""
    src = _agents_src()
    # Inspect just the _agent_to_dict body.
    start = src.index("def _agent_to_dict")
    end = src.index("\n\n", start)
    body = src[start:end]
    assert "agent_key_hash" not in body
    assert "secret" not in body.lower() or "enable_secret" not in body  # defensive on naming
    # No password / key fields by name.
    assert "password" not in body.lower()


# ─── Unit-level shape check on _agent_to_dict ───────────────────────────


def test_agent_to_dict_payload_contains_scope_fields():
    """Run _agent_to_dict() with a stub Agent and verify the wire payload
    includes BOTH new fields with the expected values."""
    from app.api.v1.endpoints.agents import _agent_to_dict

    stub_agent = SimpleNamespace(
        id="rwnlq1i0o08c",
        name="movempic",
        last_heartbeat=None,
        last_ip=None,
        local_ip=None,
        platform="linux",
        machine_hostname="mvm-host",
        version="2.0.0",
        is_active=True,
        created_at=None,
        command_mode="all",
        allowed_commands=None,
        allowed_ips="",
        failed_auth_count=0,
        key_last_rotated=None,
        last_connected_at=None,
        last_disconnected_at=None,
        total_connections=0,
        # Scope fields — the P1 fix exposes these.
        organization_id=6,
        location_id=12,
    )

    payload = _agent_to_dict(stub_agent, online_ids=set())

    assert "organization_id" in payload, "P1 fix: organization_id missing from list payload"
    assert "location_id" in payload, "P1 fix: location_id missing from list payload"
    assert payload["organization_id"] == 6
    assert payload["location_id"] == 12


def test_agent_to_dict_payload_org_loc_for_org_one_agent():
    """Cross-check: a different org's agent serializes with its own scope
    (not stamped with the test fixture's default 6/12). Defends against a
    regression that would hard-code values or drop the agent attribute
    read."""
    from app.api.v1.endpoints.agents import _agent_to_dict

    stub_agent = SimpleNamespace(
        id="ahpwh2qojwp5",
        name="zsistem1",
        last_heartbeat=None,
        last_ip=None,
        local_ip=None,
        platform=None,
        machine_hostname=None,
        version=None,
        is_active=False,
        created_at=None,
        command_mode="all",
        allowed_commands=None,
        allowed_ips="",
        failed_auth_count=0,
        key_last_rotated=None,
        last_connected_at=None,
        last_disconnected_at=None,
        total_connections=0,
        organization_id=1,
        location_id=5,
    )

    payload = _agent_to_dict(stub_agent, online_ids=set())
    assert payload["organization_id"] == 1
    assert payload["location_id"] == 5


def test_agent_to_dict_payload_allows_null_scope():
    """Some legacy agent rows may have NULL organization_id / location_id
    (pre-Faz 7 backfill). The serializer must surface those as None and
    NOT crash — the frontend filter at DeviceForm.tsx:184 already excludes
    such rows defensively per the comment chain."""
    from app.api.v1.endpoints.agents import _agent_to_dict

    stub_agent = SimpleNamespace(
        id="legacy0000000",
        name="legacy-agent",
        last_heartbeat=None,
        last_ip=None,
        local_ip=None,
        platform=None,
        machine_hostname=None,
        version=None,
        is_active=True,
        created_at=None,
        command_mode="all",
        allowed_commands=None,
        allowed_ips="",
        failed_auth_count=0,
        key_last_rotated=None,
        last_connected_at=None,
        last_disconnected_at=None,
        total_connections=0,
        organization_id=None,
        location_id=None,
    )

    payload = _agent_to_dict(stub_agent, online_ids=set())
    assert payload["organization_id"] is None
    assert payload["location_id"] is None


# ─── Backwards-compat: existing fields are intact ───────────────────────


def test_agent_to_dict_payload_existing_fields_preserved():
    """P1 fix is ADDITIVE. The pre-fix field set must be intact so no
    downstream consumer (header bell badge, agent list page, NocAgents
    grid) breaks."""
    from app.api.v1.endpoints.agents import _agent_to_dict

    stub_agent = SimpleNamespace(
        id="rwnlq1i0o08c",
        name="movempic",
        last_heartbeat=None,
        last_ip="10.0.0.5",
        local_ip="172.20.0.1",
        platform="linux",
        machine_hostname="mvm",
        version="2.0.0",
        is_active=True,
        created_at=None,
        command_mode="all",
        allowed_commands='["ls"]',
        allowed_ips="10.0.0.0/8",
        failed_auth_count=0,
        key_last_rotated=None,
        last_connected_at=None,
        last_disconnected_at=None,
        total_connections=42,
        organization_id=6,
        location_id=12,
    )
    payload = _agent_to_dict(stub_agent, online_ids=set())

    # Pre-fix fields (PR #97 / Faz 7 / etc.)
    for expected_key in (
        "id", "name", "status", "last_heartbeat", "last_ip", "local_ip",
        "platform", "machine_hostname", "version", "is_active", "created_at",
        "command_mode", "allowed_commands", "allowed_ips", "failed_auth_count",
        "key_last_rotated", "last_connected_at", "last_disconnected_at",
        "total_connections",
    ):
        assert expected_key in payload, f"BACKWARDS-COMPAT BROKEN: '{expected_key}' missing"

    # allowed_commands is JSON-decoded
    assert payload["allowed_commands"] == ["ls"]
    assert payload["total_connections"] == 42
    assert payload["allowed_ips"] == "10.0.0.0/8"


# ─── Schema contract — pydantic AgentResponse aligned with _agent_to_dict ──


def test_agent_response_schema_contains_scope_fields():
    """Belt-and-braces: pydantic AgentResponse (created by PR #104 for
    the create endpoint's response_model) already exposes the two fields.
    This pin keeps the two sources of truth in sync — if a future
    schema-only refactor removes them from AgentResponse, list endpoint
    consumers reading via the manual dict won't notice, so we pin the
    schema too."""
    from app.schemas.agent import AgentResponse
    fields = AgentResponse.model_fields
    assert "organization_id" in fields
    assert "location_id" in fields
