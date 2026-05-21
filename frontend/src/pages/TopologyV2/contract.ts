/**
 * TopologyV2 engine-internal contract boundary.
 *
 * Two responsibilities, one module:
 *   1. **Runtime validation** of the `GET /topology/graph?v=2` payload
 *      — `validateTopologyGraphV2()` + `TopologyContractError` — so
 *      the engine surfaces a clear error instead of rendering garbage
 *      on a malformed / wrong-version response.
 *   2. **Engine-internal type re-export** — every TopologyV2 module
 *      (`graphModel`, `clustering`, `rendering`, `patch`, `realtime`,
 *      `overlays/*`, `three/*`, the test fixtures, …) imports
 *      contract types from HERE, never from `@/api/topologyContract`
 *      directly. The deliberate single chokepoint means we can:
 *        - keep one definition of "what `@/api/topologyContract`
 *          types the engine depends on" without grepping 38 files;
 *        - swap the upstream package without touching engine modules
 *          (e.g. if the contract package is renamed or split);
 *        - add engine-only augmentations next to the imports if ever
 *          needed, without polluting the shared package.
 *
 * **Not a public surface.** TopologyV2 exposes exactly one external
 * symbol — the default `TopologyV2Page` from `index.tsx` (T8.1 §4.1).
 * Nothing outside `frontend/src/pages/TopologyV2/` imports this file.
 *
 * **Re-exports policy.** `export *` is deliberate, not an oversight.
 * The 14 re-exported types form the engine's stable working set against
 * the upstream contract; trimming to the currently-consumed subset
 * would force a churning, low-value maintenance burden on every new
 * patch / overlay / scene-data evolution. ts-prune flags the
 * not-yet-consumed entries as "unused"; that is expected and benign
 * (they are part of the boundary's stable surface, not dead code).
 */
import type {
  TopologyGraphV2,
  TopologyNode,
  TopologyEdge,
  TopologyCluster,
} from '@/api/topologyContract'

export * from '@/api/topologyContract'

export class TopologyContractError extends Error {
  constructor(message: string) {
    super(`Topology v2 contract: ${message}`)
    this.name = 'TopologyContractError'
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function validateNode(n: unknown, i: number): TopologyNode {
  if (!isObj(n)) throw new TopologyContractError(`node[${i}] is not an object`)
  if (typeof n.id !== 'string') throw new TopologyContractError(`node[${i}].id missing`)
  if (n.kind !== 'device' && n.kind !== 'ghost')
    throw new TopologyContractError(`node[${i}].kind invalid: ${String(n.kind)}`)
  if (!isObj(n.data)) throw new TopologyContractError(`node[${i}].data missing`)
  return n as unknown as TopologyNode
}

function validateEdge(e: unknown, i: number): TopologyEdge {
  if (!isObj(e)) throw new TopologyContractError(`edge[${i}] is not an object`)
  for (const k of ['id', 'source', 'target', 'link_type'] as const) {
    if (typeof e[k] !== 'string')
      throw new TopologyContractError(`edge[${i}].${k} missing`)
  }
  return e as unknown as TopologyEdge
}

function validateCluster(c: unknown, i: number): TopologyCluster {
  if (!isObj(c)) throw new TopologyContractError(`cluster[${i}] is not an object`)
  if (typeof c.cluster_id !== 'string')
    throw new TopologyContractError(`cluster[${i}].cluster_id missing`)
  if (!['location', 'layer', 'rack'].includes(c.cluster_type as string))
    throw new TopologyContractError(`cluster[${i}].cluster_type invalid`)
  return c as unknown as TopologyCluster
}

/**
 * Validate + narrow an untyped `/topology/graph?v=2` payload. Throws
 * `TopologyContractError` on any structural violation so the engine can
 * surface a clear error instead of rendering garbage.
 */
export function validateTopologyGraphV2(raw: unknown): TopologyGraphV2 {
  if (!isObj(raw)) throw new TopologyContractError('response is not an object')
  if (raw.contract_version !== 2)
    throw new TopologyContractError(
      `expected contract_version 2, got ${String(raw.contract_version)}`,
    )
  if (!Array.isArray(raw.nodes)) throw new TopologyContractError('nodes is not an array')
  if (!Array.isArray(raw.edges)) throw new TopologyContractError('edges is not an array')
  if (!Array.isArray(raw.clusters)) throw new TopologyContractError('clusters is not an array')
  if (!isObj(raw.patch_protocol))
    throw new TopologyContractError('patch_protocol missing')
  if (typeof raw.graph_version !== 'number')
    throw new TopologyContractError('graph_version missing')

  raw.nodes.forEach(validateNode)
  raw.edges.forEach(validateEdge)
  raw.clusters.forEach(validateCluster)

  // Edge endpoints must reference declared nodes (a dangling edge would
  // crash graphology on import).
  const nodeIds = new Set((raw.nodes as TopologyNode[]).map((n) => n.id))
  ;(raw.edges as TopologyEdge[]).forEach((e, i) => {
    if (!nodeIds.has(e.source))
      throw new TopologyContractError(`edge[${i}] source '${e.source}' has no node`)
    if (!nodeIds.has(e.target))
      throw new TopologyContractError(`edge[${i}] target '${e.target}' has no node`)
  })

  return raw as unknown as TopologyGraphV2
}
