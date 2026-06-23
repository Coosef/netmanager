/**
 * P0.1 HOTFIX (2026-06-23) — interceptor logout-loop assertions.
 *
 * This hotfix did NOT modify the 401 interceptor's behavior, but the
 * operator addendum required test/proof that the interceptor's call to
 * `/api/v1/auth/logout` (which itself can return 401 when the session
 * token is already invalid) does NOT spin into a logout loop.
 *
 * The existing `_logoutInFlight` debounce flag in `frontend/src/api/client.ts`
 * is the load-bearing guard:
 *
 *     let _logoutInFlight = false
 *     ...
 *     if (_logoutInFlight) return Promise.reject(error)
 *     _logoutInFlight = true
 *     useAuthStore.getState().logout()
 *     window.location.href = '/login'
 *
 * The first 401 sets the flag, calls store.logout() (which fires
 * `authApi.logout()` fire-and-forget — that returned promise CAN itself
 * yield a 401), then schedules a hard navigation to `/login`. Any
 * follow-up 401 — including the logout endpoint's own 401 — is fast-
 * rejected by the flag check, so no second `useAuthStore.logout()` /
 * `window.location.href` runs.
 *
 * These tests pin that behavior at the source level (the `client.ts`
 * interceptor block) and assert the source-level invariants the
 * incident review depends on. Behavioral testing of the actual axios
 * runtime is covered in the existing `client.interceptor.test.ts`.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const SRC = readFileSync(
  resolve(__dirname, '../client.ts'),
  'utf-8',
)

describe('client.ts interceptor — logout-loop debounce contract (P0.1 pin)', () => {
  it('`_logoutInFlight` flag exists at module scope', () => {
    expect(SRC).toMatch(/let\s+_logoutInFlight\s*=\s*false/)
  })

  it('flag check appears BEFORE flag assignment (debounce order)', () => {
    const codeOnly = SRC.replace(/\/\/[^\n]*\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '')
    const checkIdx = codeOnly.indexOf('if (_logoutInFlight) return Promise.reject(error)')
    const assignIdx = codeOnly.indexOf('_logoutInFlight = true')
    expect(checkIdx).toBeGreaterThan(0)
    expect(assignIdx).toBeGreaterThan(0)
    expect(checkIdx).toBeLessThan(assignIdx)
  })

  it('flag assignment appears BEFORE useAuthStore.logout() call', () => {
    const codeOnly = SRC.replace(/\/\/[^\n]*\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '')
    const assignIdx = codeOnly.indexOf('_logoutInFlight = true')
    const logoutCallIdx = codeOnly.indexOf('useAuthStore.getState().logout()')
    expect(assignIdx).toBeGreaterThan(0)
    expect(logoutCallIdx).toBeGreaterThan(0)
    expect(assignIdx).toBeLessThan(logoutCallIdx)
  })

  it('flag assignment appears BEFORE window.location.href hard nav', () => {
    const codeOnly = SRC.replace(/\/\/[^\n]*\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '')
    const assignIdx = codeOnly.indexOf('_logoutInFlight = true')
    const hardNavIdx = codeOnly.indexOf("window.location.href = '/login'")
    expect(assignIdx).toBeGreaterThan(0)
    expect(hardNavIdx).toBeGreaterThan(0)
    expect(assignIdx).toBeLessThan(hardNavIdx)
  })

  it('flag is NEVER reset within the interceptor body (only initial `let` declaration sets false)', () => {
    // The flag stays true until the hard navigation completes; the
    // next page load re-initializes the module → flag back to false.
    // A regression that reset the flag in the catch path would
    // re-open the loop window. The initial `let _logoutInFlight = false`
    // declaration at module scope is EXPECTED; what we forbid is any
    // re-assignment to false elsewhere in the file.
    const codeOnly = SRC.replace(/\/\/[^\n]*\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '')
    // Match `_logoutInFlight = false` only when NOT preceded by `let `.
    // The negative lookbehind keeps the initial declaration whitelisted
    // and flags any later assignment (e.g. inside a catch / cleanup).
    expect(codeOnly).not.toMatch(/(?<!let\s)_logoutInFlight\s*=\s*false/)
  })

  it('401 trigger gated on pathname !== /login (no loop on the login page itself)', () => {
    expect(SRC).toMatch(
      /error\.response\?\.status === 401\s*&&\s*window\.location\.pathname !== '\/login'/,
    )
  })

  it('logout endpoint failure (its own 401) cannot trigger a second logout', () => {
    // Self-explanatory regression assertion: when authApi.logout()
    // resolves with 401 (because the session token is already revoked),
    // the response interceptor fires again — but the flag set at first
    // call now short-circuits via `if (_logoutInFlight) return`. The
    // assertion is implicit in the order tests above; this case spells
    // out the intent for the next reviewer.
    const codeOnly = SRC.replace(/\/\/[^\n]*\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '')
    // The flag check must short-circuit before any of the side-effect
    // branches: `useAuthStore.logout()` and `window.location.href`.
    const checkIdx = codeOnly.indexOf('if (_logoutInFlight) return Promise.reject(error)')
    const sideEffectIdx = Math.min(
      codeOnly.indexOf('useAuthStore.getState().logout()'),
      codeOnly.indexOf("window.location.href = '/login'"),
    )
    expect(checkIdx).toBeLessThan(sideEffectIdx)
  })
})
