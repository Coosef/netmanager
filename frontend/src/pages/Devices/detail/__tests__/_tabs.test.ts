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

  it('10 sekme tam küme + tekrar yok (Dalga 1 sonrası Terminal sonda)', () => {
    const keys = DETAIL_TABS.map((t) => t.key)
    expect(keys).toEqual(
      ['overview', 'ports', 'security', 'vlan', 'mac', 'poe', 'events', 'backup', 'actions', 'terminal']
    )
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('placeholder bayraklar — TÜM 10 sekme live, placeholder=0', () => {
    const placeholders = DETAIL_TABS.filter((t) => t.placeholder).map((t) => t.key)
    expect(placeholders).toEqual([])
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
    ['terminal', 'terminal'],    // Dalga 1: yeni 10. sekme
    ['BOGUS', 'overview'],       // bilinmeyen → default
    ['SECURITY', 'overview'],    // case-sensitive (URL formatı küçük)
  ])('normalizeTab(%j) === %j', (input, expected) => {
    expect(normalizeTab(input as any)).toBe(expected)
  })
})
