/**
 * T10 C7.B — Device Detail tab kataloğu birim testleri.
 * normalizeTab + DETAIL_TABS düzeni regresyon koruması.
 */
import { describe, it, expect } from 'vitest'
import { DETAIL_TABS, DEFAULT_TAB, normalizeTab } from '../_tabs'

describe('DETAIL_TABS catalog', () => {
  it('overview ilk sekme + default', () => {
    expect(DETAIL_TABS[0].key).toBe('overview')
    expect(DEFAULT_TAB).toBe('overview')
  })

  it('9 sekme tam küme + tekrar yok', () => {
    const keys = DETAIL_TABS.map((t) => t.key)
    expect(keys).toEqual(
      ['overview', 'ports', 'security', 'vlan', 'mac', 'poe', 'events', 'backup', 'actions']
    )
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('placeholder bayraklar — C7.C sonrası live: overview + ports + security; gerisi placeholder (C7.D)', () => {
    const live = DETAIL_TABS.filter((t) => !t.placeholder).map((t) => t.key).sort()
    expect(live).toEqual(['overview', 'ports', 'security'])
  })
})

describe('normalizeTab', () => {
  it.each([
    [null, 'overview'],
    [undefined, 'overview'],
    ['', 'overview'],
    ['overview', 'overview'],
    ['ports', 'ports'],
    ['security', 'security'],
    ['vlan', 'vlan'],
    ['BOGUS', 'overview'],       // bilinmeyen → default
    ['SECURITY', 'overview'],    // case-sensitive (URL formatı küçük)
  ])('normalizeTab(%j) === %j', (input, expected) => {
    expect(normalizeTab(input as any)).toBe(expected)
  })
})
