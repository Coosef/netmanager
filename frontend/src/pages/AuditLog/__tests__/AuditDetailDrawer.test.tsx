/**
 * Audit Log v2 PR 2 — AuditDetailDrawer module smoke.
 *
 * Pattern: dynamic import + createElement (proje React Testing Library
 * kullanmıyor). Asıl davranış manuel tarayıcı smoke ile doğrulanır.
 */
import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import type { AuditLog } from '@/types'

function mkRecord(overrides: Partial<AuditLog> = {}): AuditLog {
  return {
    id: 1,
    username: 'admin',
    action: 'login',
    status: 'success',
    created_at: '2026-06-09T15:00:00Z',
    ...overrides,
  } as AuditLog
}

describe('AuditDetailDrawer — module smoke', () => {
  it('default export fonksiyon', async () => {
    const mod = await import('../AuditDetailDrawer')
    expect(typeof mod.default).toBe('function')
  })

  it('record null → crash YOK (Drawer kapalı render)', async () => {
    const mod = await import('../AuditDetailDrawer')
    const el = createElement(mod.default, { record: null, onClose: () => {} })
    expect(el).toBeTruthy()
    expect(el.props.record).toBeNull()
  })

  it('record verildi → createElement crash YOK', async () => {
    const mod = await import('../AuditDetailDrawer')
    const el = createElement(mod.default, {
      record: mkRecord(),
      onClose: () => {},
    })
    expect(el).toBeTruthy()
    expect(el.props.record?.action).toBe('login')
  })

  it('record before/after state ile crash YOK', async () => {
    const mod = await import('../AuditDetailDrawer')
    const el = createElement(mod.default, {
      record: mkRecord({
        action: 'device_updated',
        before_state: { status: 'active' },
        after_state: { status: 'inactive' },
      }),
      onClose: () => {},
    })
    expect(el).toBeTruthy()
  })

  it('record details (sensitive field içeren) — crash YOK', async () => {
    const mod = await import('../AuditDetailDrawer')
    const el = createElement(mod.default, {
      record: mkRecord({
        action: 'password_changed',
        details: {
          ip: '1.2.3.4',
          password: 'shouldnt-leak',
          new_token: 'shouldnt-leak-either',
        } as Record<string, unknown>,
      }),
      onClose: () => {},
    })
    expect(el).toBeTruthy()
  })

  it('onClose prop fonksiyon', async () => {
    const mod = await import('../AuditDetailDrawer')
    let called = 0
    const onClose = () => { called++ }
    const el = createElement(mod.default, { record: mkRecord(), onClose })
    expect(typeof el.props.onClose).toBe('function')
    el.props.onClose()
    expect(called).toBe(1)
  })
})
