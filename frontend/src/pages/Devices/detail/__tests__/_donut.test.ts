/**
 * T10 C7 Wave 2 #2 F4 — Donut import smoke.
 */
import { describe, it, expect } from 'vitest'

describe('Donut module', () => {
  it('import edilebilir (compile clean)', async () => {
    const mod = await import('../_donut')
    expect(typeof mod.default).toBe('function')
  })
})
