/**
 * T10 C7 Wave 2 #2 F3 — Sparkline import + SVG render smoke.
 *
 * Saf SVG path component; render dependency yok. Lazy-load risk yok.
 */
import { describe, it, expect } from 'vitest'

describe('Sparkline module', () => {
  it('import edilebilir (compile clean)', async () => {
    const mod = await import('../_sparkline')
    expect(typeof mod.default).toBe('function')
  })
})
