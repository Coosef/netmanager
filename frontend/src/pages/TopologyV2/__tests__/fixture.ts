/** Shared v2-contract fixture for the TopologyV2 engine tests. */
import type { TopologyGraphV2 } from '../contract'

/**
 * One org, one location, two layers (core + access). The core switch
 * sits in rack R1. A ghost hangs off access switch 1.
 *
 *   loc:7 ── layer:core ── rack:R1 ── core-sw
 *         └─ layer:access ───────────┬ acc-sw1 ── ghost
 *                                    └ acc-sw2
 */
export function makeFixture(): TopologyGraphV2 {
  return {
    contract_version: 2,
    graph_version: 7,
    updated_at: '2026-05-19T08:00:00+00:00',
    scope: { organization_id: 1, location_id: 7 },
    nodes: [
      {
        id: 'd-1', kind: 'device',
        data: {
          device_id: 1, label: 'core-sw', ip: '10.0.0.1',
          organization_id: 1, location_id: 7, location: 'HQ',
          layer: 'core', rack: 'R1', zone: 'A/2', device_role: 'switch',
          vendor: 'cisco', status: 'online', criticality: 'critical',
          cluster_id: 'loc:7|layer:core|rack:R1',
          importance_score: 0.98, label_priority: 1, render_class: 'core',
          min_zoom_level: 0, lod_tier: 'primary',
        },
      },
      {
        id: 'd-2', kind: 'device',
        data: {
          device_id: 2, label: 'acc-sw1', ip: '10.0.0.2',
          organization_id: 1, location_id: 7, location: 'HQ',
          layer: 'access', rack: null, zone: null, device_role: 'switch',
          vendor: 'aruba', status: 'online', criticality: 'normal',
          cluster_id: 'loc:7|layer:access',
          importance_score: 0.45, label_priority: 2, render_class: 'access',
          min_zoom_level: 1, lod_tier: 'secondary',
        },
      },
      {
        id: 'd-3', kind: 'device',
        data: {
          device_id: 3, label: 'acc-sw2', ip: '10.0.0.3',
          organization_id: 1, location_id: 7, location: 'HQ',
          layer: 'access', rack: null, zone: null, device_role: 'switch',
          vendor: 'aruba', status: 'offline', criticality: 'normal',
          cluster_id: 'loc:7|layer:access',
          importance_score: 0.45, label_priority: 2, render_class: 'access',
          min_zoom_level: 1, lod_tier: 'secondary',
        },
      },
      {
        id: 'ghost-edge-ap', kind: 'ghost',
        data: {
          label: 'edge-ap', ghost: true, layer: 'wireless',
          device_role: 'ap', criticality: 'low', cluster_id: 'loc:7|layer:access',
          importance_score: 0.15, label_priority: 3, render_class: 'ghost',
          min_zoom_level: 2, lod_tier: 'detail', source_device_id: 2,
        },
      },
    ],
    edges: [
      {
        id: 'e-1-2', source: 'd-1', target: 'd-2',
        link_type: 'uplink', utilization: 0.34, traffic_class: 'normal',
        anomaly_state: 'none', latency_ms: null, data: {},
      },
      {
        id: 'e-1-3', source: 'd-1', target: 'd-3',
        link_type: 'uplink', utilization: 0.9, traffic_class: 'saturated',
        anomaly_state: 'asymmetric', latency_ms: null, data: {},
      },
      {
        id: 'eg-2-ap', source: 'd-2', target: 'ghost-edge-ap',
        link_type: 'ghost', utilization: null, traffic_class: 'unknown',
        anomaly_state: 'ghost', latency_ms: null, data: {},
      },
    ],
    clusters: [
      {
        cluster_id: 'loc:7', cluster_type: 'location', label: 'HQ',
        parent_cluster_id: null, collapsed_count: 3,
        health: { online: 2, offline: 1, unknown: 0, score: 0.667 },
        traffic: { avg_utilization: 0.62, max_utilization: 0.9 },
      },
      {
        cluster_id: 'loc:7|layer:core', cluster_type: 'layer', label: 'core',
        parent_cluster_id: 'loc:7', collapsed_count: 1,
        health: { online: 1, offline: 0, unknown: 0, score: 1 },
        traffic: { avg_utilization: 0.34, max_utilization: 0.34 },
      },
      {
        cluster_id: 'loc:7|layer:core|rack:R1', cluster_type: 'rack', label: 'R1',
        parent_cluster_id: 'loc:7|layer:core', collapsed_count: 1,
        health: { online: 1, offline: 0, unknown: 0, score: 1 },
        traffic: { avg_utilization: 0.34, max_utilization: 0.34 },
      },
      {
        cluster_id: 'loc:7|layer:access', cluster_type: 'layer', label: 'access',
        parent_cluster_id: 'loc:7', collapsed_count: 2,
        health: { online: 1, offline: 1, unknown: 0, score: 0.5 },
        traffic: { avg_utilization: 0.9, max_utilization: 0.9 },
      },
    ],
    stats: {
      total_nodes: 4, device_nodes: 3, ghost_nodes: 1,
      total_edges: 3, clusters: 4,
    },
    patch_protocol: {
      graph_version: 7,
      channel: 'network:events:org:{organization_id}',
      event_prefix: 'topology_',
      node_events: ['topology_node_added', 'topology_node_removed', 'topology_node_updated'],
      edge_events: ['topology_edge_added', 'topology_edge_removed', 'topology_edge_updated'],
      bulk_events: ['topology_links_updated', 'topology_drift'],
    },
  }
}
