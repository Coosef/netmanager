/**
 * Audit Log v2 PR 4 — AuditEmptyState module smoke.
 */
import { describe, it, expect } from 'vitest'
import { createElement } from 'react'

describe('AuditEmptyState — module smoke', () => {
  it('default export fonksiyon', async () => {
    const mod = await import('../AuditEmptyState')
    expect(typeof mod.default).toBe('function')
  })

  it('mode="no_data" → crash YOK, onReset PROPS\'a girer', async () => {
    const mod = await import('../AuditEmptyState')
    const el = createElement(mod.default, { mode: 'no_data' })
    expect(el).toBeTruthy()
    expect(el.props.mode).toBe('no_data')
    expect(el.props.onReset).toBeUndefined()
  })

  it('mode="no_match" + onReset → crash YOK', async () => {
    const mod = await import('../AuditEmptyState')
    let called = 0
    const onReset = () => { called++ }
    const el = createElement(mod.default, { mode: 'no_match', onReset })
    expect(el.props.mode).toBe('no_match')
    expect(typeof el.props.onReset).toBe('function')
    el.props.onReset()
    expect(called).toBe(1)
  })

  it('mode="no_match" onReset opsiyonel — verilmezse crash YOK', async () => {
    const mod = await import('../AuditEmptyState')
    const el = createElement(mod.default, { mode: 'no_match' })
    expect(el).toBeTruthy()
    expect(el.props.onReset).toBeUndefined()
  })
})
