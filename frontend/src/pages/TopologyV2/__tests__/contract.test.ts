import { describe, it, expect } from 'vitest'
import { validateTopologyGraphV2, TopologyContractError } from '../contract'
import { makeFixture } from './fixture'

describe('validateTopologyGraphV2', () => {
  it('accepts a valid v2 payload', () => {
    const g = validateTopologyGraphV2(makeFixture())
    expect(g.contract_version).toBe(2)
    expect(g.nodes).toHaveLength(4)
    expect(g.edges).toHaveLength(3)
    expect(g.clusters).toHaveLength(4)
  })

  it('rejects the wrong contract version', () => {
    const bad = { ...makeFixture(), contract_version: 1 }
    expect(() => validateTopologyGraphV2(bad)).toThrow(TopologyContractError)
  })

  it('rejects a non-object response', () => {
    expect(() => validateTopologyGraphV2(null)).toThrow(TopologyContractError)
    expect(() => validateTopologyGraphV2('graph')).toThrow(TopologyContractError)
  })

  it('rejects a missing nodes array', () => {
    const bad = { ...makeFixture(), nodes: undefined }
    expect(() => validateTopologyGraphV2(bad)).toThrow(/nodes/)
  })

  it('rejects an edge that references an unknown node', () => {
    const fx = makeFixture()
    fx.edges.push({
      id: 'e-x', source: 'd-1', target: 'd-999',
      link_type: 'link', utilization: null, traffic_class: 'unknown',
      anomaly_state: 'none', latency_ms: null, data: {},
    })
    expect(() => validateTopologyGraphV2(fx)).toThrow(/d-999/)
  })

  it('rejects an invalid node kind', () => {
    const fx = makeFixture()
    ;(fx.nodes[0] as { kind: string }).kind = 'widget'
    expect(() => validateTopologyGraphV2(fx)).toThrow(/kind/)
  })
})
