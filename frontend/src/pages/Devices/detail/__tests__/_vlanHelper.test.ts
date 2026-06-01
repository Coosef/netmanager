/**
 * T10 C7 Dalga 1 RED-fix — VLAN list parser birim testleri.
 */
import { describe, it, expect } from 'vitest'
import { parseVlanList, VlanListError, formatVlanList } from '../_vlanHelper'

describe('parseVlanList — geçerli girdiler', () => {
  it.each([
    ['1', [1]],
    ['100', [100]],
    ['1,10,20', [1, 10, 20]],
    ['10-12', [10, 11, 12]],
    ['1,10-12,100', [1, 10, 11, 12, 100]],
    ['  2400 , 2410-2415 ', [2400, 2410, 2411, 2412, 2413, 2414, 2415]],
    ['100,100,100', [100]], // dedupe
    ['30,10,20', [10, 20, 30]], // sıralı
    ['1-3, 5-7, 10', [1, 2, 3, 5, 6, 7, 10]],
    ['4094', [4094]],
    ['1-1', [1]], // tek elemanlı range
  ])('parseVlanList(%j) === %j', (input, expected) => {
    expect(parseVlanList(input)).toEqual(expected)
  })
})

describe('parseVlanList — geçersiz girdiler', () => {
  it.each([
    [''],
    ['   '],
    ['abc'],
    ['1,abc'],
    ['0'],            // 1-4094 dışı
    ['4095'],         // 1-4094 dışı
    ['10-9'],         // ters aralık
    ['0-5'],          // başlangıç < 1
    ['4090-4100'],    // bitiş > 4094
    ['1-3000'],       // çok geniş
    ['10--12'],       // double dash → token bozuk
    [','],            // sadece virgül
  ])('parseVlanList(%j) → VlanListError', (input) => {
    expect(() => parseVlanList(input)).toThrow(VlanListError)
  })
})

describe('formatVlanList', () => {
  it('boş liste → —', () => {
    expect(formatVlanList([])).toBe('—')
  })
  it('1-3 elemanlı', () => {
    expect(formatVlanList([1, 10, 100])).toBe('1, 10, 100')
  })
  it('12 elemandan fazla → kısalt + +N', () => {
    const ids = Array.from({ length: 20 }, (_, i) => i + 1)
    expect(formatVlanList(ids)).toBe('1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12 … (+8)')
  })
})
