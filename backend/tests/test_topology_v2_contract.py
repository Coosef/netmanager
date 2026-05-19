"""
Topology contract v2 (T1) — shape + RLS org/location isolation tests.

PostgreSQL Row-Level Security only exists on Postgres, so these tests run
against the real database (inside the backend container DATABASE_URL is
the netmgr_app Postgres URL). They are skipped automatically on the
SQLite unit-test path.

They prove the headline T1 guarantee: `TopologyService.build_graph_v2`
does NO manual tenant filtering — a caller only ever sees their own
organization's graph, enforced purely by RLS.
"""
import pytest

from app.core.config import settings

_IS_PG = "postgresql" in (settings.DATABASE_URL or "")
pytestmark = pytest.mark.skipif(
    not _IS_PG, reason="topology v2 RLS tests require PostgreSQL (run in-container)"
)

# Imported lazily inside tests so the SQLite path never touches them.
_REQUIRED_NODE_KEYS = {
    "device_id", "label", "organization_id", "location_id", "location",
    "layer", "rack", "zone", "device_role", "vendor", "status",
    "criticality", "cluster_id", "importance_score", "label_priority",
    "render_class", "min_zoom_level", "lod_tier",
}
_REQUIRED_EDGE_KEYS = {
    "id", "source", "target", "link_type", "utilization",
    "traffic_class", "anomaly_state", "latency_ms",
}
_REQUIRED_CLUSTER_KEYS = {
    "cluster_id", "cluster_type", "parent_cluster_id", "collapsed_count",
    "health", "traffic",
}


async def _build(org_id, *, super_admin=False):
    """Build the v2 graph under a given org context (or super-admin)."""
    from app.core.database import AsyncSessionLocal
    from app.core.org_context import (
        set_org_context, clear_org_context, superadmin_context,
    )
    from app.core.rls import apply_rls_context
    from app.services.topology_service import TopologyService
    from app.services.ssh_manager import ssh_manager

    svc = TopologyService(ssh_manager)
    async with AsyncSessionLocal() as db:
        if super_admin:
            with superadmin_context():
                await apply_rls_context(db)
                return await svc.build_graph_v2(db)
        if org_id is None:
            clear_org_context()
        else:
            set_org_context(org_id, None, False)
        await apply_rls_context(db)
        try:
            return await svc.build_graph_v2(db)
        finally:
            clear_org_context()


@pytest.mark.asyncio
async def test_v2_contract_shape():
    """The v2 response carries the full contract: hierarchy + cluster tree
    + rich edges + semantic-zoom hints + realtime-patch protocol."""
    g = await _build(1)

    assert g["contract_version"] == 2
    assert isinstance(g["graph_version"], int)
    assert g["updated_at"]
    assert set(g["scope"]) == {"organization_id", "location_id"}
    for key in ("nodes", "edges", "clusters", "stats", "patch_protocol"):
        assert key in g, f"v2 contract missing '{key}'"

    # patch protocol — defines the realtime event vocabulary
    pp = g["patch_protocol"]
    assert pp["event_prefix"] == "topology_"
    assert "topology_node_added" in pp["node_events"]
    assert "topology_edge_removed" in pp["edge_events"]

    devices = [n for n in g["nodes"] if n["kind"] == "device"]
    if devices:
        data = devices[0]["data"]
        missing = _REQUIRED_NODE_KEYS - set(data)
        assert not missing, f"node data missing hierarchy/hint keys: {missing}"
        assert 0.0 <= data["importance_score"] <= 1.0
        assert data["criticality"] in ("critical", "high", "normal", "low")

    if g["edges"]:
        missing = _REQUIRED_EDGE_KEYS - set(g["edges"][0])
        assert not missing, f"edge missing keys: {missing}"

    # cluster tree — every non-location cluster points at a real parent
    cluster_ids = {c["cluster_id"] for c in g["clusters"]}
    for c in g["clusters"]:
        assert _REQUIRED_CLUSTER_KEYS <= set(c), f"cluster missing keys: {c}"
        if c["parent_cluster_id"] is not None:
            assert c["parent_cluster_id"] in cluster_ids, \
                f"dangling parent_cluster_id: {c['parent_cluster_id']}"
        assert 0.0 <= c["health"]["score"] <= 1.0


@pytest.mark.asyncio
async def test_v2_org_isolation_under_rls():
    """build_graph_v2 does no manual tenant filtering — an org only ever
    sees its own devices, and an unscoped (no-context) call sees nothing."""
    g_super = await _build(None, super_admin=True)
    g_org1 = await _build(1)
    g_org2 = await _build(2)
    g_none = await _build(None)

    n_super = g_super["stats"]["device_nodes"]
    n1 = g_org1["stats"]["device_nodes"]
    n2 = g_org2["stats"]["device_nodes"]
    n_none = g_none["stats"]["device_nodes"]

    # No-context ⇒ RLS yields zero rows (fail-closed).
    assert n_none == 0, f"no-context graph must be empty, saw {n_none}"
    # Each org is a subset of the super-admin view.
    assert n1 + n2 <= n_super, f"org sums ({n1}+{n2}) exceed super-admin ({n_super})"
    # Org 1 is seeded in the dev DB.
    assert n1 > 0, "org 1 should have devices"

    # Every device node in org-1's graph belongs to org 1 — nothing leaks.
    for node in g_org1["nodes"]:
        if node["kind"] == "device":
            assert node["data"]["organization_id"] == 1, \
                f"org-1 graph leaked a node from org {node['data']['organization_id']}"


@pytest.mark.asyncio
async def test_v1_contract_unchanged():
    """v1 build_graph stays backward-compatible for the current page."""
    from app.core.database import AsyncSessionLocal
    from app.core.org_context import set_org_context, clear_org_context
    from app.core.rls import apply_rls_context
    from app.services.topology_service import TopologyService
    from app.services.ssh_manager import ssh_manager

    svc = TopologyService(ssh_manager)
    async with AsyncSessionLocal() as db:
        set_org_context(1, None, False)
        await apply_rls_context(db)
        try:
            g = await svc.build_graph(db)
        finally:
            clear_org_context()

    # The legacy shape — no contract_version, no clusters.
    assert set(g) == {"nodes", "edges", "stats"}
    assert "contract_version" not in g
    for node in g["nodes"]:
        assert "type" in node  # v1 React Flow node shape
