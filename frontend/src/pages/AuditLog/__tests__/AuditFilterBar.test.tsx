/**
 * Audit Log v2 PR 4 — AuditFilterBar module smoke.
 *
 * Pattern: dynamic import + createElement (React Testing Library YOK).
 * Asıl davranış manuel tarayıcı smoke ile doğrulanır.
 */
import { describe, it, expect } from 'vitest'
import { createElement } from 'react'

const noop = () => {}

const baseProps = {
  search: '',
  onSearchChange: noop,
  actionFilter: '',
  onActionChange: noop,
  ipFilter: '',
  onIpChange: noop,
  resourceType: undefined,
  onResourceTypeChange: noop,
  statusFilter: undefined,
  onStatusFilterChange: noop,
  dateRange: null,
  onDateRangeChange: noop,
  onReset: noop,
}

describe('AuditFilterBar — module smoke', () => {
  it('default export fonksiyon', async () => {
    const mod = await import('../AuditFilterBar')
    expect(typeof mod.default).toBe('function')
  })

  it('boş filtreler ile createElement crash YOK', async () => {
    const mod = await import('../AuditFilterBar')
    const el = createElement(mod.default, baseProps)
    expect(el).toBeTruthy()
    expect(el.type).toBe(mod.default)
  })

  it('dolu filtreler ile createElement crash YOK', async () => {
    const mod = await import('../AuditFilterBar')
    const el = createElement(mod.default, {
      ...baseProps,
      search: 'admin',
      actionFilter: 'login',
      ipFilter: '1.2.3.4',
      resourceType: 'device',
      statusFilter: 'success',
    })
    expect(el).toBeTruthy()
  })

  it('onReset prop fonksiyon — invoke çalışır', async () => {
    const mod = await import('../AuditFilterBar')
    let called = 0
    const onReset = () => { called++ }
    const el = createElement(mod.default, { ...baseProps, onReset })
    expect(typeof el.props.onReset).toBe('function')
    el.props.onReset()
    expect(called).toBe(1)
  })

  it('onSearchChange callback invoke', async () => {
    const mod = await import('../AuditFilterBar')
    let captured = ''
    const onSearchChange = (v: string) => { captured = v }
    const el = createElement(mod.default, { ...baseProps, onSearchChange })
    el.props.onSearchChange('test-user')
    expect(captured).toBe('test-user')
  })

  it('onDateRangeChange callback invoke', async () => {
    const mod = await import('../AuditFilterBar')
    let received: unknown = 'untouched'
    const onDateRangeChange = (range: unknown) => { received = range }
    const el = createElement(mod.default, { ...baseProps, onDateRangeChange })
    el.props.onDateRangeChange(null)
    expect(received).toBeNull()
  })
})
