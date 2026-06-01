/**
 * T10 C7 Dalga 1 — LiveConfigTab import smoke.
 * BackupTab alt-tab "Canlı" component'i (canlı running-config + Güvenlik Tarama).
 */
import { describe, it, expect } from 'vitest'

describe('LiveConfigTab module', () => {
  it('import edilebilir (compile clean)', async () => {
    const mod = await import('../LiveConfigTab')
    expect(typeof mod.default).toBe('function')
  })
})
