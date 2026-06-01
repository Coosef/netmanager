/**
 * T10 C7 Dalga 1 — DiffViewerDrawer import smoke.
 * Lazy-load chunk; react-diff-viewer-continued bağımlılığı resolve olmalı.
 */
import { describe, it, expect } from 'vitest'

describe('DiffViewerDrawer module', () => {
  it('import edilebilir (lazy chunk + react-diff-viewer-continued resolve)', async () => {
    const mod = await import('../DiffViewerDrawer')
    expect(typeof mod.default).toBe('function')
  })
})
