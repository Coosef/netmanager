/**
 * Audit Log v2 PR 2 — AuditDiffViewer + computeDiff testleri.
 *
 * Pattern: dynamic import smoke + computeDiff pure helper testleri (proje
 * React Testing Library kullanmıyor).
 */
import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { computeDiff } from '../AuditDiffViewer'

describe('computeDiff — field-level diff hesaplama', () => {
  it('eşit objeler → tüm rows "same", sayaçlar 0', () => {
    const d = computeDiff({ a: 1, b: 'x' }, { a: 1, b: 'x' })
    expect(d.added).toBe(0)
    expect(d.changed).toBe(0)
    expect(d.removed).toBe(0)
    expect(d.rows).toHaveLength(2)
    expect(d.rows.every((r) => r.kind === 'same')).toBe(true)
  })

  it('after\'a yeni alan → added sayaç', () => {
    const d = computeDiff({ a: 1 }, { a: 1, b: 2 })
    expect(d.added).toBe(1)
    expect(d.changed).toBe(0)
    expect(d.removed).toBe(0)
    expect(d.rows.find((r) => r.key === 'b')?.kind).toBe('added')
  })

  it('before\'da olup after\'da olmayan → removed sayaç', () => {
    const d = computeDiff({ a: 1, b: 2 }, { a: 1 })
    expect(d.removed).toBe(1)
    expect(d.rows.find((r) => r.key === 'b')?.kind).toBe('removed')
  })

  it('değer farklı → changed sayaç', () => {
    const d = computeDiff({ a: 'old' }, { a: 'new' })
    expect(d.changed).toBe(1)
    expect(d.rows[0].kind).toBe('changed')
    expect(d.rows[0].before).toBe('old')
    expect(d.rows[0].after).toBe('new')
  })

  it('karma: added + changed + removed kombinasyonu', () => {
    const d = computeDiff(
      { keep: 1, change_me: 'a', remove_me: 'x' },
      { keep: 1, change_me: 'b', add_me: 'new' },
    )
    expect(d.added).toBe(1)
    expect(d.changed).toBe(1)
    expect(d.removed).toBe(1)
    expect(d.rows.find((r) => r.key === 'keep')?.kind).toBe('same')
  })

  it('nested object — JSON.stringify üzerinden karşılaştırma', () => {
    const d = computeDiff(
      { meta: { x: 1 } },
      { meta: { x: 2 } },
    )
    expect(d.changed).toBe(1)
  })

  it('array değer karşılaştırma', () => {
    const d = computeDiff(
      { tags: ['a', 'b'] },
      { tags: ['a', 'b', 'c'] },
    )
    expect(d.changed).toBe(1)
  })

  it('eşit array → same', () => {
    const d = computeDiff(
      { tags: ['a', 'b'] },
      { tags: ['a', 'b'] },
    )
    expect(d.changed).toBe(0)
    expect(d.rows[0].kind).toBe('same')
  })

  it('before/after null → boş diff', () => {
    const d = computeDiff(null, null)
    expect(d.added).toBe(0)
    expect(d.changed).toBe(0)
    expect(d.removed).toBe(0)
    expect(d.rows).toHaveLength(0)
  })

  it('sadece after → tüm alanlar added', () => {
    const d = computeDiff(null, { a: 1, b: 2 })
    expect(d.added).toBe(2)
    expect(d.rows.every((r) => r.kind === 'added')).toBe(true)
  })

  it('sadece before → tüm alanlar removed', () => {
    const d = computeDiff({ a: 1, b: 2 }, null)
    expect(d.removed).toBe(2)
    expect(d.rows.every((r) => r.kind === 'removed')).toBe(true)
  })

  it('sensitive field bayrağı row üzerinde işaretlenir', () => {
    const d = computeDiff(
      { password: 'old_secret', vlan: 100 },
      { password: 'new_secret', vlan: 200 },
    )
    const pwRow = d.rows.find((r) => r.key === 'password')
    const vlanRow = d.rows.find((r) => r.key === 'vlan')
    expect(pwRow?.sensitive).toBe(true)
    expect(vlanRow?.sensitive).toBe(false)
  })

  it('row\'lar key bazında alfabetik sıralı', () => {
    const d = computeDiff(
      { zeta: 1, alpha: 2 },
      { beta: 3 },
    )
    expect(d.rows.map((r) => r.key)).toEqual(['alpha', 'beta', 'zeta'])
  })
})

describe('AuditDiffViewer — module smoke', () => {
  it('default export fonksiyon', async () => {
    const mod = await import('../AuditDiffViewer')
    expect(typeof mod.default).toBe('function')
    expect(typeof mod.computeDiff).toBe('function')
  })

  it('createElement crash YOK — before/after boş', async () => {
    const mod = await import('../AuditDiffViewer')
    const el = createElement(mod.default, { before: null, after: null })
    expect(el).toBeTruthy()
    expect(el.type).toBe(mod.default)
  })

  it('createElement crash YOK — gerçek payload', async () => {
    const mod = await import('../AuditDiffViewer')
    const el = createElement(mod.default, {
      before: { a: 1 },
      after: { a: 2, b: 3 },
    })
    expect(el).toBeTruthy()
    expect(el.props.before).toEqual({ a: 1 })
  })
})
