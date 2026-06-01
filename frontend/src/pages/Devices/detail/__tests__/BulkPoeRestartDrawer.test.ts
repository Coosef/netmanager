/**
 * T10 C7 Wave 3 W3.3 — BulkPoeRestartDrawer import smoke.
 * AntD Drawer + Form import + default export function olduğu doğrulanır.
 */
import { describe, it, expect } from 'vitest'

describe('BulkPoeRestartDrawer module', () => {
  it('import edilebilir + default export function', async () => {
    const mod = await import('../BulkPoeRestartDrawer')
    expect(typeof mod.default).toBe('function')
  })
})
