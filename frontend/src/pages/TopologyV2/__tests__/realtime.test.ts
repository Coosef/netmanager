/**
 * T8.2 — realtime.ts pure-helper tests.
 *
 * The WebSocket-bound `useTopologyRealtime` hook delegates its
 * framework-free behaviour to three pure helpers exported from
 * `realtime.ts`. Testing these in isolation gives the same regression
 * confidence as a full hook test, without the DOM / WS mock harness
 * cost — same pattern as `hooks/__tests__/useEventStream.test.ts`.
 *
 * Coverage:
 *   - wsPathForLocation : location-switch rebind invariant (the URL
 *                         must change when the active location changes
 *                         so React's effect dep-array re-runs)
 *   - isTopologyFrame   : frame filter, narrows arbitrary WS payloads
 *                         to topology events; non-topology frames are
 *                         dropped (alarms, heartbeats, etc.)
 *   - nextBackoffDelay  : reconnect schedule — must not exceed the
 *                         capped maximum, must start short, must be
 *                         monotonic up to the cap
 */
import { describe, it, expect } from 'vitest'
import {
  wsPathForLocation,
  isTopologyFrame,
  nextBackoffDelay,
} from '../realtime'

describe('wsPathForLocation', () => {
  it('binds the stream to a specific location id', () => {
    expect(wsPathForLocation(7)).toBe('/api/v1/ws/events?location=7')
  })

  it('a different location yields a different URL → socket rebinds', () => {
    expect(wsPathForLocation(7)).not.toBe(wsPathForLocation(8))
  })

  it('omits the location param for "ALL LOCATIONS" (null)', () => {
    expect(wsPathForLocation(null)).toBe('/api/v1/ws/events')
  })

  it('null → 1 → null path sequence flips between org-wide and narrowed', () => {
    const a = wsPathForLocation(null)
    const b = wsPathForLocation(1)
    const c = wsPathForLocation(null)
    expect(a).toEqual(c)
    expect(a).not.toEqual(b)
  })
})

describe('isTopologyFrame', () => {
  it('accepts a topology_node_updated frame', () => {
    expect(isTopologyFrame({ event_type: 'topology_node_updated', graph_version: 1 })).toBe(true)
  })

  it('accepts a topology_drift frame', () => {
    expect(isTopologyFrame({ event_type: 'topology_drift', graph_version: 5 })).toBe(true)
  })

  it('rejects a non-topology frame (the same socket may deliver alarms)', () => {
    expect(isTopologyFrame({ event_type: 'alarm_raised' })).toBe(false)
  })

  it('rejects a frame with no event_type at all', () => {
    expect(isTopologyFrame({ foo: 'bar' })).toBe(false)
  })

  it('rejects null / undefined / primitives — the JSON.parse output must be an object', () => {
    expect(isTopologyFrame(null)).toBe(false)
    expect(isTopologyFrame(undefined)).toBe(false)
    expect(isTopologyFrame('topology_node_added')).toBe(false)
    expect(isTopologyFrame(42)).toBe(false)
  })

  it('rejects a frame whose event_type prefix is similar but not topology_', () => {
    expect(isTopologyFrame({ event_type: 'topo_node_added' })).toBe(false)
    expect(isTopologyFrame({ event_type: 'TOPOLOGY_NODE_ADDED' })).toBe(false)
  })
})

describe('nextBackoffDelay', () => {
  it('the first retry waits 2 s', () => {
    expect(nextBackoffDelay(0)).toBe(2000)
  })

  it('the schedule is 2 → 4 → 8 → 15 seconds, then caps at 15 s', () => {
    expect(nextBackoffDelay(0)).toBe(2000)
    expect(nextBackoffDelay(1)).toBe(4000)
    expect(nextBackoffDelay(2)).toBe(8000)
    expect(nextBackoffDelay(3)).toBe(15000)
  })

  it('caps at 15 s — does not blow up for a runaway retry counter', () => {
    expect(nextBackoffDelay(4)).toBe(15000)
    expect(nextBackoffDelay(10)).toBe(15000)
    expect(nextBackoffDelay(1000)).toBe(15000)
  })

  it('handles a non-negative integer count without throwing on negative input', () => {
    expect(nextBackoffDelay(-1)).toBe(2000)
    expect(nextBackoffDelay(-100)).toBe(2000)
  })

  it('is monotonically non-decreasing up to the cap', () => {
    const seq = [0, 1, 2, 3, 4, 5].map(nextBackoffDelay)
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1])
    }
  })
})
