"""
Device ownership — Faz 8 Phase G.

A device belongs to exactly one organization + one location. That
ownership is immutable through the generic update path: it changes ONLY
through the audited move endpoint (POST /devices/{id}/move-location).

This module holds the two reusable pieces of that guarantee:

  * ``relocate_device_data`` — when a device moves location, its
    device-bound child rows (config backups, events, incidents, topology
    edges, metrics …) move with it, so the device's history follows it
    and nothing is left orphaned at the old location;

  * ``detect_ip_location_conflict`` — discovery is RLS-scoped and never
    reassigns a device across locations, but two locations may use
    overlapping private IP ranges; this surfaces such an overlap as a
    structured conflict event for admin review.
"""
from __future__ import annotations

import logging

log = logging.getLogger("netmanager.device_ownership")

# Device ownership fields — immutable through the generic update path.
# They change ONLY through the audited move endpoint.
OWNERSHIP_FIELDS = ("location_id", "organization_id")


def forbidden_ownership_fields(payload) -> list:
    """The ownership fields present in a generic device-update payload.

    A non-empty result means the update tried to change device location
    or organization ownership — which Phase G forbids on the generic
    update path (the caller rejects the request, see update_device).
    """
    if not isinstance(payload, dict):
        return []
    return [f for f in OWNERSHIP_FIELDS if f in payload]


async def relocate_device_data(db, device_id: int, new_location_id: int) -> dict:
    """Move every device-bound child row's ``location_id`` to follow a
    device that has changed location.

    The set of child tables is derived from the ORM metadata — every
    mapped table that carries both ``device_id`` and ``location_id`` —
    so it stays correct as the schema evolves. Each table is updated
    independently: a failure on one (e.g. a time-series view) is logged
    and does not abort the move. Returns a per-table map of:
        table -> rowcount   (or table -> "error: …" on failure)
    """
    from sqlalchemy import text

    from app.core.database import Base

    moved: dict = {}
    for table in Base.metadata.sorted_tables:
        cols = table.columns
        if table.name == "devices":
            continue
        if "device_id" not in cols or "location_id" not in cols:
            continue
        try:
            # Each table is updated inside its own SAVEPOINT: on PostgreSQL
            # a failing statement aborts the whole transaction, so without
            # this one un-updatable table would roll back the entire move.
            async with db.begin_nested():
                res = await db.execute(
                    # Table name is ORM-metadata-sourced, never user input.
                    text(f"UPDATE {table.name} SET location_id = :loc "  # noqa: S608
                         f"WHERE device_id = :dev"),
                    {"loc": new_location_id, "dev": device_id},
                )
            if res.rowcount and res.rowcount > 0:
                moved[table.name] = res.rowcount
        except Exception as exc:  # one table failing must not orphan the move
            log.warning(
                "device relocate: child table %s not relocated — %s",
                table.name, exc,
                extra={
                    "event": "device_relocate_partial",
                    "table": table.name,
                    "device_id": device_id,
                    "new_location_id": new_location_id,
                },
            )
            moved[table.name] = f"error: {exc}"
    return moved


async def detect_ip_location_conflict(
    ip_address: str, organization_id: int, location_id: int
) -> bool:
    """Log a structured conflict if a device with `ip_address` already
    exists in a DIFFERENT (organization, location) than the one now
    discovering it.

    Discovery is RLS-scoped — it always creates / matches a device only
    inside its own location and NEVER reassigns the other device. This
    is purely observability: overlapping private IP ranges across
    locations are legitimate, but an operator should see the overlap.
    Returns True when a conflict was found.
    """
    from sqlalchemy import select

    from app.core.database import make_worker_session
    from app.core.org_context import superadmin_context
    from app.core.rls import apply_rls_context
    from app.models.device import Device

    try:
        async with make_worker_session()() as db:
            with superadmin_context():
                await apply_rls_context(db)
                rows = (await db.execute(
                    select(Device.id, Device.organization_id, Device.location_id)
                    .where(Device.ip_address == ip_address,
                           Device.is_active == True)
                )).all()
    except Exception as exc:
        log.debug("ip/location conflict check skipped: %s", exc)
        return False

    others = [
        r for r in rows
        if (r[1], r[2]) != (organization_id, location_id)
    ]
    if not others:
        return False
    log.warning(
        "discovery: IP also present in another location — not reassigned",
        extra={
            "event": "discovery_location_conflict",
            "ip_address": ip_address,
            "discovering_organization_id": organization_id,
            "discovering_location_id": location_id,
            "existing_elsewhere": [
                {"device_id": r[0], "organization_id": r[1], "location_id": r[2]}
                for r in others
            ],
        },
    )
    return True
