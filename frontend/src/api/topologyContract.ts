/**
 * Topology Contract v2 — "Final Gold Release"
 * ============================================
 * The stable backend graph contract returned by `GET /topology/graph?v=2`.
 * It feeds the Sigma.js 2D engine and the react-three-fiber 3D engine.
 *
 * Backend source of truth: `TopologyService.build_graph_v2`
 * (backend/app/services/topology_service.py).
 *
 * Org/location isolation is enforced by PostgreSQL RLS — the frontend
 * never sends an org id; the server derives scope from the auth token
 * (org = hard boundary) and the `X-Location-Id` header (location = filter).
 *
 * v1 (`?v=1`, the legacy React Flow shape) stays available until the
 * feature-flag cutover; this file describes ONLY v2.
 */

// ── Enumerations ──────────────────────────────────────────────────────────────

/** core → distribution → access → edge → wireless. */
export type TopologyLayer =
  | 'core' | 'distribution' | 'access' | 'edge' | 'wireless' | 'unknown';

/** Derived from layer; drives node prominence. */
export type Criticality = 'critical' | 'high' | 'normal' | 'low';

/** Edge utilization bucket for traffic colouring. */
export type TrafficClass =
  | 'idle' | 'low' | 'normal' | 'high' | 'saturated' | 'unknown';

/** Edge-level anomaly flag (see `/topology/anomalies`). */
export type EdgeAnomalyState = 'none' | 'stale' | 'asymmetric' | 'ghost';

/** Relationship class between two endpoints. */
export type LinkType = 'backbone' | 'uplink' | 'access' | 'link' | 'ghost';

/** Level-of-detail tier — drives label/geometry detail as the view zooms. */
export type LodTier = 'primary' | 'secondary' | 'detail';

/** Cluster granularity in the location → layer → rack hierarchy. */
export type ClusterType = 'location' | 'layer' | 'rack';

export type NodeKind = 'device' | 'ghost';

// ── Nodes ─────────────────────────────────────────────────────────────────────

/** Hierarchy + semantic-zoom metadata carried on every node. */
export interface TopologyNodeData {
  device_id?: number;            // absent for ghost nodes
  label: string;
  ip?: string | null;

  // ── enterprise hierarchy ──
  organization_id?: number | null;
  location_id?: number | null;
  location?: string | null;
  layer?: TopologyLayer | string | null;
  rack?: string | null;
  zone?: string | null;          // "Building / Floor"
  device_role?: string | null;   // switch | router | firewall | ap | ...
  vendor?: string | null;
  status?: string | null;        // online | offline | unreachable | unknown
  criticality: Criticality;

  // ── cluster reference ──
  cluster_id: string | null;

  // ── semantic-zoom / LOD render hints ──
  importance_score: number;      // 0..1 — node prominence
  label_priority: number;        // 1 = drawn first / kept longest
  render_class: string;          // style class (≈ layer)
  min_zoom_level: number;        // zoom tier the node de-clusters at (0 = always)
  lod_tier: LodTier;
  degree?: number;               // link count

  // ── misc inventory ──
  model?: string | null;
  os_type?: string | null;
  group_id?: number | null;
  site?: string | null;
  last_discovery?: string | null;

  // ghost-only
  ghost?: boolean;
  platform?: string | null;
  source_device_id?: number | null;
}

export interface TopologyNode {
  id: string;                    // "d-<deviceId>" | "ghost-<hostname>" — stable identity
  kind: NodeKind;
  data: TopologyNodeData;
}

// ── Edges ─────────────────────────────────────────────────────────────────────

export interface TopologyEdgePortData {
  source_port?: string | null;
  target_port?: string | null;
  protocol?: string | null;
  last_seen?: string | null;
  speed_mbps?: number | null;
  local_duplex?: string | null;
  local_port_mode?: string | null;
  local_vlan?: number | null;
  local_poe_enabled?: boolean | null;
  local_poe_mw?: number | null;
}

export interface TopologyEdge {
  id: string;                    // stable, deterministic — diff key
  source: string;                // node id
  target: string;                // node id
  link_type: LinkType;
  utilization: number | null;    // 0..1 (max of in/out)
  traffic_class: TrafficClass;
  anomaly_state: EdgeAnomalyState;
  latency_ms: number | null;     // null until per-link latency is collected
  label?: string;
  data: TopologyEdgePortData;
}

// ── Clusters (location → layer → rack hierarchy) ──────────────────────────────

export interface ClusterHealth {
  online: number;
  offline: number;
  unknown: number;
  score: number;                 // 0..1 — online ratio
}

export interface ClusterTraffic {
  avg_utilization: number | null;
  max_utilization: number | null;
}

export interface TopologyCluster {
  cluster_id: string;
  cluster_type: ClusterType;
  label: string;
  parent_cluster_id: string | null;
  collapsed_count: number;       // devices folded into this cluster
  health: ClusterHealth;
  traffic: ClusterTraffic;
}

// ── Realtime patch protocol ───────────────────────────────────────────────────

/**
 * Topology realtime events ride the per-org channel
 * `network:events:org:{organization_id}` (delivered over `GET /ws/events`).
 * Every event carries `graph_version`; the frontend reconciles it against
 * the `graph_version` of its current snapshot — a gap ⇒ full refetch.
 */
export interface TopologyPatchProtocol {
  graph_version: number;
  channel: string;
  event_prefix: 'topology_';
  node_events: ['topology_node_added', 'topology_node_removed', 'topology_node_updated'];
  edge_events: ['topology_edge_added', 'topology_edge_removed', 'topology_edge_updated'];
  bulk_events: ['topology_links_updated', 'topology_drift'];
}

export type TopologyEventType =
  | 'topology_node_added' | 'topology_node_removed' | 'topology_node_updated'
  | 'topology_edge_added' | 'topology_edge_removed' | 'topology_edge_updated'
  | 'topology_links_updated' | 'topology_drift';

/** A frame received on `/ws/events` whose `event_type` starts with "topology_". */
export interface TopologyPatchEvent {
  event_type: TopologyEventType;
  graph_version: number;         // monotonic — for gap detection
  organization_id: number;
  location_id?: number | null;
  ts: string;
  // event-specific payload (node/edge id, changed fields, counts …)
  [key: string]: unknown;
}

// ── Snapshot / diff (topology drift) ──────────────────────────────────────────

/**
 * A diff between two v2 graphs (or a graph vs a golden TopologySnapshot).
 * Node/edge `id`s are stable + deterministic, so a diff is well-defined.
 */
export interface TopologyGraphDiff {
  from_version: number;
  to_version: number;
  nodes_added: string[];
  nodes_removed: string[];
  nodes_updated: string[];
  edges_added: string[];
  edges_removed: string[];
  edges_updated: string[];
}

// ── Top-level response ────────────────────────────────────────────────────────

export interface TopologyScope {
  organization_id: number | null;
  location_id: number | null;
}

export interface TopologyGraphStats {
  total_nodes: number;
  device_nodes: number;
  ghost_nodes: number;
  total_edges: number;
  clusters: number;
}

/** The full `GET /topology/graph?v=2` response. */
export interface TopologyGraphV2 {
  contract_version: 2;
  graph_version: number;         // monotonic; reconcile against patch events
  updated_at: string;            // ISO — latest link discovery time
  scope: TopologyScope;
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  clusters: TopologyCluster[];
  stats: TopologyGraphStats;
  patch_protocol: TopologyPatchProtocol;
}
