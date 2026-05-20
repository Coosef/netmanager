import { describe, it, expect } from 'vitest'
import { eventStreamPath } from '../useEventStream'

/**
 * Faz 8 Phase F — the live-events stream must bind to the active
 * location so a location switch rebinds the socket and old-location
 * frames stop. `eventStreamPath` is the pure piece of that contract.
 *
 * NOTE: the frontend test runner (vitest) is currently uninstalled —
 * `npm install` is blocked by TD-1 (@xterm/xterm@^6.0.0 unresolvable).
 * This file type-checks today and runs once TD-1 is resolved.
 */
describe('eventStreamPath', () => {
  it('binds the stream to the active location', () => {
    expect(eventStreamPath(7)).toBe('/api/v1/ws/events?location=7')
  })

  it('a different location yields a different URL → socket rebinds', () => {
    expect(eventStreamPath(7)).not.toBe(eventStreamPath(8))
  })

  it('omits the location param for org-wide "all locations" (null)', () => {
    expect(eventStreamPath(null)).toBe('/api/v1/ws/events')
  })
})
