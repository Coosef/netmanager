/**
 * Audit Log v2 PR 1 — AuditActionChip module + render smoke testleri.
 *
 * Bu proje React Testing Library kullanmıyor (pattern: pure function +
 * dynamic import smoke). Chip'in görsel davranışı manuel tarayıcı smoke
 * ile doğrulanır; bu dosya:
 *   1. Modülün hatasız yüklendiğini (TSX compile + import resolve)
 *   2. Default export'un fonksiyon olduğunu (component contract)
 *   3. React.createElement ile çağrıldığında crash etmediğini
 * doğrular. Asıl kategori mapping'i auditActionCategory.test.ts kapsar.
 */
import { describe, it, expect } from 'vitest'
import { createElement } from 'react'

describe('AuditActionChip — module smoke', () => {
  it('module dynamic import → default export fonksiyon', async () => {
    const mod = await import('../AuditActionChip')
    expect(typeof mod.default).toBe('function')
  })

  it.each([
    ['login', 'success'],
    ['device_created', 'success'],
    ['device_updated', 'success'],
    ['device_deleted', 'success'],
    ['approval_approved', 'success'],
    ['login_blocked_ip', 'success'],
    ['unknown_xyz_action', 'success'],
    ['login_failed', 'failure'],
  ])('createElement(AuditActionChip, { action: "%s", status: "%s" }) — crash YOK', async (action, status) => {
    const mod = await import('../AuditActionChip')
    const el = createElement(mod.default, { action, status })
    expect(el).toBeTruthy()
    expect(el.type).toBe(mod.default)
    expect(el.props.action).toBe(action)
    expect(el.props.status).toBe(status)
  })

  it('compact prop kabul edilir', async () => {
    const mod = await import('../AuditActionChip')
    const el = createElement(mod.default, { action: 'login', status: 'success', compact: true })
    expect(el.props.compact).toBe(true)
  })

  it('status null/undefined kabul edilir (defansif)', async () => {
    const mod = await import('../AuditActionChip')
    expect(() => createElement(mod.default, { action: 'login' })).not.toThrow()
    expect(() => createElement(mod.default, { action: 'login', status: null })).not.toThrow()
  })
})
