/**
 * T10 C7 Dalga 1 — TerminalTab import smoke.
 * Hibrit REPL + canlı SSH; SshTerminal component + xterm bağımlılıkları
 * resolve olmalı.
 */
import { describe, it, expect } from 'vitest'

describe('TerminalTab module', () => {
  it('import edilebilir (compile clean + xterm bağımlılıkları)', async () => {
    const mod = await import('../TerminalTab')
    expect(typeof mod.default).toBe('function')
  })
})
