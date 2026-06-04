"""Incident sprint Hotfix #13 — topology_links INSERT missing org/loc stamp.

RCA (2026-06-04, Device 80 LLDP discover):
  POST /api/v1/topology/discover-single/80 → 500 with traceback ending in:
    asyncpg.exceptions.InsufficientPrivilegeError:
      new row violates row-level security policy for table "topology_links"
  UI surfaces "LLDP keşfi başarısız".

  topology_service.save_links built `pg_insert(TopologyLink).values(...)`
  WITHOUT organization_id / location_id. Faz 7 RLS WITH CHECK requires
  both columns to match the active session sandbox; an INSERT lacking
  them is rejected outright. Pre-RLS code worked because the columns
  didn't exist; Faz 7 added them as NOT NULL + WITH CHECK and the
  topology service was missed in the regression sweep.

Fix: stamp organization_id + location_id from the parent device on insert.
The device is the LLDP source so its scope is the natural scope for the
link row. on_conflict_do_update path is not touched — RLS UPDATE policy
is satisfied by the existing row's values which are already in-scope.

Strategy: source assertion on the values() call + a non-regression check
that update set_ is untouched (no unintended scope rewrite on conflict).
"""
from __future__ import annotations

import inspect
from pathlib import Path


def _src() -> str:
    import app.services.topology_service as m
    return Path(inspect.getfile(m)).read_text()


def _save_links_body() -> str:
    src = _src()
    idx = src.find("async def save_links(")
    assert idx > 0, "save_links not found"
    after = src.find("\n    async def ", idx + 1)
    if after < 0:
        after = src.find("\n    def ", idx + 1)
    return src[idx: after if after > 0 else len(src)]


# ─── 1. INSERT values now carry org/loc stamp ─────────────────────────────────


def test_hf13_pg_insert_stamps_organization_id_from_device():
    body = _save_links_body()
    # values() block must reference device.organization_id
    assert "organization_id=device.organization_id" in body, (
        "pg_insert(TopologyLink).values(...) missing organization_id stamp"
    )


def test_hf13_pg_insert_stamps_location_id_from_device():
    body = _save_links_body()
    assert "location_id=device.location_id" in body, (
        "pg_insert(TopologyLink).values(...) missing location_id stamp"
    )


# ─── 2. on_conflict_do_update set_ NOT modified (no scope rewrite) ────────────


def test_hf13_conflict_update_does_not_rewrite_scope():
    """The conflict-update branch must NOT include organization_id or
    location_id — overwriting them on every LLDP refresh would silently
    re-scope a row if the device is moved. Existing values stay; INSERT
    branch handles new rows only."""
    body = _save_links_body()
    # Bound the on_conflict_do_update set_ dict
    idx = body.find("on_conflict_do_update")
    assert idx > 0
    set_idx = body.find("set_={", idx)
    assert set_idx > 0
    set_end = body.find("\n            )", set_idx)  # matching close
    set_block = body[set_idx: set_end if set_end > 0 else len(body)]
    assert "organization_id" not in set_block, (
        "on_conflict set_ rewrites organization_id — unintended scope drift"
    )
    assert "location_id" not in set_block, (
        "on_conflict set_ rewrites location_id — unintended scope drift"
    )


# ─── 3. Sanity: existing fields still present ─────────────────────────────────


def test_hf13_existing_insert_fields_intact():
    body = _save_links_body()
    expected_fields = [
        "device_id=device.id",
        "local_port=n.local_port",
        "neighbor_hostname=n.neighbor_hostname",
        "neighbor_ip=n.neighbor_ip",
        "neighbor_port=n.neighbor_port",
        "neighbor_platform=n.neighbor_platform",
        "neighbor_device_id=neighbor_device_id",
        "neighbor_type=neighbor_type",
        "protocol=n.protocol",
        "last_seen=now",
    ]
    for f in expected_fields:
        assert f in body, f"existing insert field {f!r} regressed"


# ─── 4. TopologyLink model has the columns we stamp ───────────────────────────


def test_hf13_topology_link_model_has_org_and_location_cols():
    from app.models.topology import TopologyLink
    cols = {c.name for c in TopologyLink.__table__.columns}
    assert "organization_id" in cols, (
        "TopologyLink lacks organization_id — schema/model drift"
    )
    assert "location_id" in cols, (
        "TopologyLink lacks location_id — schema/model drift"
    )
