/**
 * T10 C7 Wave 3 W3.3 — PortsTab PoE toolbar/aksiyon import smoke.
 * portControlApi.bulkPoe + restartPoe wrapper'ları + BulkPoeRestartDrawer
 * referansları compile/resolve olmalı.
 */
import { describe, it, expect } from 'vitest'

describe('W3.3 PoE Management modules', () => {
  it('PortsTab import edilebilir (PoE eklemeleri compile)', async () => {
    const mod = await import('../PortsTab')
    expect(typeof mod.default).toBe('function')
  })

  it('portControlApi wrapper signature — bulkPoe + restartPoe + setPoe', async () => {
    const mod = await import('@/api/portControl')
    expect(typeof mod.portControlApi.setPoe).toBe('function')
    expect(typeof mod.portControlApi.restartPoe).toBe('function')
    expect(typeof mod.portControlApi.bulkPoe).toBe('function')
  })

  it('BulkPoeRestartDrawer default export function', async () => {
    const mod = await import('../BulkPoeRestartDrawer')
    expect(typeof mod.default).toBe('function')
  })
})
