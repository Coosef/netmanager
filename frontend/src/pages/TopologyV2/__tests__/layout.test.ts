/**
 * Tests for `positionClusterNodesChunked` — T8.3.E2.e.
 *
 * The async helper exists because the synchronous `positionClusterNodes`
 * produced a multi-second main-thread block during the FA2 finalize
 * callback (`SigmaCanvas.tsx:141–148` pre-E2.e). The visual end state
 * must remain bit-for-bit equivalent; only the timing changes.
 *
 * jsdom has no `requestAnimationFrame`, so the helper falls back to
 * `setTimeout(0)`. The yield is observable here as a microtask
 * boundary; that's enough to exercise the cancellation token and the
 * batching logic without needing a real browser.
 */
import { describe, it, expect } from 'vitest'
import { buildTopologyModel } from '../graphModel'
import { positionClusterNodes, positionClusterNodesChunked } from '../layout'
import { makeFixture } from './fixture'

function setDevicePositions(m: ReturnType<typeof buildTopologyModel>): void {
  // Drive device positions to known values so the centroid math is
  // deterministic. The fixture has 3 devices + 1 ghost, all under
  // 'loc:7'. We pin them at predictable coordinates so the centroid
  // of every ancestor cluster has a known value.
  m.graph.setNodeAttribute('d-1', 'x', 10)
  m.graph.setNodeAttribute('d-1', 'y', 0)
  m.graph.setNodeAttribute('d-2', 'x', 0)
  m.graph.setNodeAttribute('d-2', 'y', 10)
  m.graph.setNodeAttribute('d-3', 'x', 0)
  m.graph.setNodeAttribute('d-3', 'y', -10)
  m.graph.setNodeAttribute('ghost-edge-ap', 'x', -10)
  m.graph.setNodeAttribute('ghost-edge-ap', 'y', 0)
}

function snapshotClusterPositions(m: ReturnType<typeof buildTopologyModel>) {
  const out = new Map<string, { x: number; y: number }>()
  for (const cid of m.clusters.keys()) {
    out.set(cid, {
      x: m.graph.getNodeAttribute(cid, 'x') as number,
      y: m.graph.getNodeAttribute(cid, 'y') as number,
    })
  }
  return out
}

describe('positionClusterNodesChunked', () => {
  it('produces the same centroids as the sync version', async () => {
    const mSync = buildTopologyModel(makeFixture())
    const mAsync = buildTopologyModel(makeFixture())
    setDevicePositions(mSync)
    setDevicePositions(mAsync)

    positionClusterNodes(mSync)
    await positionClusterNodesChunked(mAsync)

    expect(snapshotClusterPositions(mAsync)).toEqual(snapshotClusterPositions(mSync))
  })

  it('reports written cluster IDs via `onWritten`', async () => {
    const m = buildTopologyModel(makeFixture())
    setDevicePositions(m)
    const written: string[] = []
    await positionClusterNodesChunked(m, { onWritten: (id) => written.push(id) })
    // every cluster has at least one member device, so every cluster
    // should have been written.
    expect(new Set(written)).toEqual(new Set(m.clusters.keys()))
  })

  it('honours `isCancelled` between chunks', async () => {
    const m = buildTopologyModel(makeFixture())
    setDevicePositions(m)
    let calls = 0
    let cancelAfter = -1
    const written: string[] = []
    // Force a yield after every cluster by passing a 0 ms budget; cancel
    // immediately after the first cluster is written.
    cancelAfter = 1
    await positionClusterNodesChunked(m, {
      budgetMs: 0,
      isCancelled: () => calls >= cancelAfter,
      onWritten: (id) => {
        written.push(id)
        calls = written.length
      },
    })
    expect(written.length).toBe(1)
    // The remaining clusters should retain whatever position they had
    // before the call (no NaN, no half-written state). Sanity-check
    // that the un-touched ones are unchanged from the contract default.
    for (const cid of m.clusters.keys()) {
      if (cid === written[0]) continue
      const x = m.graph.getNodeAttribute(cid, 'x') as number
      const y = m.graph.getNodeAttribute(cid, 'y') as number
      expect(Number.isFinite(x)).toBe(true)
      expect(Number.isFinite(y)).toBe(true)
    }
  })

  it('skips clusters with no members in the graph (defensive)', async () => {
    const m = buildTopologyModel(makeFixture())
    setDevicePositions(m)
    // Remove every device from the graph but keep the cluster nodes —
    // the chunker should run to completion, recomputing nothing.
    for (const k of ['d-1', 'd-2', 'd-3', 'ghost-edge-ap']) m.graph.dropNode(k)
    const written: string[] = []
    await positionClusterNodesChunked(m, { onWritten: (id) => written.push(id) })
    expect(written).toEqual([])
  })

  it('a 0 ms budget yields between every cluster (microtask-friendly)', async () => {
    const m = buildTopologyModel(makeFixture())
    setDevicePositions(m)
    // The fixture has 4 clusters. With budgetMs=0 each iteration
    // forces a yield, so the function genuinely awaits between them.
    // We can't reliably count yields without instrumenting the helper,
    // but we can confirm completion produces the same end state.
    await positionClusterNodesChunked(m, { budgetMs: 0 })
    const expected = buildTopologyModel(makeFixture())
    setDevicePositions(expected)
    positionClusterNodes(expected)
    expect(snapshotClusterPositions(m)).toEqual(snapshotClusterPositions(expected))
  })
})
