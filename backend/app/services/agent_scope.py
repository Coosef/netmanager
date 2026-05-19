"""
Agent operational sandboxing — Faz 8 Phase D.

An agent is a *location-bound* operational entity, not global
infrastructure. It is bound to exactly one (organization_id,
location_id) — fixed at registration by the location it is created in.
Every agent operation — syslog / SNMP-trap / telemetry ingest,
discovery, snmp-get / snmp-walk, remote command execution, device
status updates, topology discovery — MUST target a device in the
agent's own organization AND location.

A cross-location operation is REJECTED and logged with structured
context; there is no fallback and no silent narrowing. This module is
the single enforcement point, used by every layer that touches an
agent operation:

  * the API layer        — app/api/v1/endpoints/agents.py
  * the runtime handlers — agent_manager._handle_* (ingest)
  * the command layer    — agent_manager.execute_* (dispatch)

Enforcement here is independent of PostgreSQL RLS — Phase D explicitly
does not rely on RLS alone for agent isolation.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

log = logging.getLogger("netmanager.agent_scope")


class AgentScopeError(RuntimeError):
    """An agent operation targeted a device outside the agent's
    organization/location sandbox, or the agent itself has no resolvable
    scope. Faz 8 Phase D: such operations fail closed."""


@dataclass(frozen=True)
class AgentScope:
    """The immutable (organization, location) sandbox an agent operates
    within. Carried alongside agent_id through every runtime path."""

    agent_id: str
    organization_id: int
    location_id: int


def log_scope_rejection(
    *, agent_id, device_id, organization_id, location_id, operation, reason
) -> None:
    """Structured log of a rejected agent operation — one line, every
    field a SOC needs to trace a cross-location attempt."""
    log.warning(
        "agent-scope rejected: agent=%s op=%s device=%s reason=%s",
        agent_id, operation, device_id, reason,
        extra={
            "rejected": True,
            "operation": operation,
            "agent_id": agent_id,
            "device_id": device_id,
            "organization_id": organization_id,
            "location_id": location_id,
            "reason": reason,
        },
    )


async def resolve_agent_scope(db, agent_id: str) -> AgentScope:
    """Load the agent's (organization, location) identity from the DB.

    Fail closed — an agent that does not exist, is inactive, or carries
    no organization/location cannot perform any scoped operation. The
    scope is read fresh every call, so an agent reassignment (location
    change) takes effect immediately.
    """
    from app.models.agent import Agent

    agent = await db.get(Agent, agent_id)
    if agent is None or not agent.is_active:
        raise AgentScopeError(f"Agent {agent_id} not found or inactive")
    if agent.organization_id is None or agent.location_id is None:
        raise AgentScopeError(
            f"Agent {agent_id} has no organization/location scope"
        )
    return AgentScope(agent_id, agent.organization_id, agent.location_id)


def device_in_scope(scope: AgentScope, device) -> bool:
    """True if `device` belongs to the agent's org AND location."""
    return (
        getattr(device, "organization_id", None) == scope.organization_id
        and getattr(device, "location_id", None) == scope.location_id
    )


def assert_device_in_scope(scope: AgentScope, device, operation: str) -> None:
    """Verify a target device belongs to the agent's org AND location.

    Logs a structured rejection and raises ``AgentScopeError`` on a
    cross-organization or cross-location operation.
    """
    d_org = getattr(device, "organization_id", None)
    d_loc = getattr(device, "location_id", None)
    if d_org == scope.organization_id and d_loc == scope.location_id:
        return
    log_scope_rejection(
        agent_id=scope.agent_id,
        device_id=getattr(device, "id", None),
        organization_id=scope.organization_id,
        location_id=scope.location_id,
        operation=operation,
        reason=(
            f"target device org/location ({d_org}/{d_loc}) != agent "
            f"sandbox ({scope.organization_id}/{scope.location_id})"
        ),
    )
    raise AgentScopeError(
        f"Cross-location operation rejected: {operation} — device "
        f"{getattr(device, 'id', None)} is not in the agent's location."
    )


async def filter_device_ids_in_scope(
    db, scope: AgentScope, device_ids, operation: str
) -> set:
    """Of `device_ids`, return the subset inside the agent's org+location.

    Cross-scope ids are dropped and logged individually. Used by the
    runtime ingest handlers (device status reports, SNMP traps) where a
    single batch may reference many devices.
    """
    from sqlalchemy import select

    from app.models.device import Device

    ids = [d for d in set(device_ids) if d is not None]
    if not ids:
        return set()
    rows = (await db.execute(
        select(Device.id, Device.organization_id, Device.location_id)
        .where(Device.id.in_(ids))
    )).all()

    allowed: set = set()
    for did, d_org, d_loc in rows:
        if d_org == scope.organization_id and d_loc == scope.location_id:
            allowed.add(did)
        else:
            log_scope_rejection(
                agent_id=scope.agent_id,
                device_id=did,
                organization_id=scope.organization_id,
                location_id=scope.location_id,
                operation=operation,
                reason=(
                    f"device org/location ({d_org}/{d_loc}) outside agent "
                    f"sandbox ({scope.organization_id}/{scope.location_id})"
                ),
            )
    return allowed
