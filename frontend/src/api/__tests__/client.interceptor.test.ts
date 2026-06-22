/**
 * X-LOC-INTERCEPTOR-FIX (2026-06-21) — pins the contract that the
 * Axios request interceptor in `frontend/src/api/client.ts` respects
 * any caller-supplied `X-Location-Id` header instead of clobbering it
 * with the global `localStorage[nm-active-location-id]` fallback.
 *
 * The pre-fix interceptor unconditionally assigned the localStorage
 * value to `config.headers['X-Location-Id']`, silently overriding
 * DeviceForm's per-request override (the load-bearing contract that
 * the comment at `frontend/src/api/devices.ts:65` documents). For a
 * super_admin whose header context pointed at a cross-tenant location,
 * EVERY create-device call resolved to the cross-tenant id at the
 * backend → backend's PR #102 cross-tenant guard fired → 400. The
 * operator could not escape the loop without manually clearing
 * localStorage.
 *
 * Coverage strategy: the helper predicate `getCallerLocationHeader`
 * is tested directly (pure function); the interceptor wiring is
 * pinned via source-level string assertions (mirrors the pattern in
 * `SiteContext.hydration.test.ts`). The default test environment is
 * `node`, so no DOM / localStorage globals are needed.
 */
import { describe, it, expect, vi } from 'vitest'

import { getCallerLocationHeader, ACTIVE_LOCATION_KEY } from '../client'


// Mock the auth store the interceptor reads — tests don't need a
// real Zustand store, just a predictable token getter.
vi.mock('@/store/auth', () => ({
  useAuthStore: {
    getState: () => ({ token: 'jwt-test-token', logout: vi.fn() }),
  },
}))


// ─── getCallerLocationHeader — predicate unit tests ─────────────────────


describe('getCallerLocationHeader — case-insensitive caller-supplied detection', () => {
  it('returns the caller value for the canonical `X-Location-Id` key', () => {
    expect(getCallerLocationHeader({ 'X-Location-Id': '2' })).toBe('2')
  })

  it('returns the caller value for a lowercase `x-location-id` key', () => {
    // The operator-spec'd case-insensitive contract. Axios 1.x AxiosHeaders
    // normalize to lowercase internally; a caller passing a plain object
    // with lowercase MUST also be respected.
    expect(getCallerLocationHeader({ 'x-location-id': '5' })).toBe('5')
  })

  it('returns the caller value for mixed-case `X-LOCATION-ID`', () => {
    expect(getCallerLocationHeader({ 'X-LOCATION-ID': '7' })).toBe('7')
  })

  it('returns undefined when the caller did not attach the header', () => {
    expect(getCallerLocationHeader({})).toBeUndefined()
    expect(getCallerLocationHeader({ Authorization: 'Bearer x' })).toBeUndefined()
  })

  it('returns undefined when the caller passed an empty-string header (treat as absent)', () => {
    // Empty string is a frequent mock artefact AND a clear signal of
    // "no override". The interceptor should fall through to the
    // localStorage fallback in that case, not propagate the empty.
    expect(getCallerLocationHeader({ 'X-Location-Id': '' })).toBeUndefined()
  })

  it('returns undefined when headers is null/undefined (defensive)', () => {
    expect(getCallerLocationHeader(null)).toBeUndefined()
    expect(getCallerLocationHeader(undefined)).toBeUndefined()
  })

  it('reads via `.get(name)` when headers is an AxiosHeaders-like object', () => {
    // Axios 1.x can hand the interceptor either a plain object OR an
    // AxiosHeaders instance. Feature-detect `.get` so we never miss
    // a header that the AxiosHeaders normalization has tucked into
    // its internal storage.
    const axiosHeadersLike = {
      get: (name: string) => (name.toLowerCase() === 'x-location-id' ? '9' : undefined),
    }
    expect(getCallerLocationHeader(axiosHeadersLike)).toBe('9')
  })

  it('AxiosHeaders-like with absent X-Location-Id returns undefined', () => {
    const axiosHeadersLike = {
      get: (_name: string) => undefined,
    }
    expect(getCallerLocationHeader(axiosHeadersLike)).toBeUndefined()
  })
})


// ─── ACTIVE_LOCATION_KEY contract ──────────────────────────────────────


describe('ACTIVE_LOCATION_KEY — stable localStorage key', () => {
  it('is the canonical `nm-active-location-id` value SiteContext writes to', () => {
    // A regression here would re-introduce the silent-divergence bug
    // where SiteContext writes one key and the interceptor reads
    // another — every request would carry no location header.
    expect(ACTIVE_LOCATION_KEY).toBe('nm-active-location-id')
  })
})


// ─── Interceptor behavior — integration with localStorage + caller ────


/**
 * The interceptor is a closure created at module-load time. To
 * exercise the FULL `client.interceptors.request.use` callback (not
 * just the predicate helper) we read the module and verify the
 * source-level contract through string matching. This mirrors the
 * pattern used by `SiteContext.hydration.test.ts` — keeps the test
 * harness lightweight and immune to axios-internal refactors.
 */
describe('client.ts interceptor — caller header is respected (source-level)', () => {
  it('uses getCallerLocationHeader before falling back to localStorage', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(
        new URL('../client.ts', import.meta.url),
        'utf-8',
      ),
    )
    // The fix replaces the pre-fix line
    //   if (loc) { config.headers['X-Location-Id'] = loc }
    // with a callerLoc-aware block. Pin both directions:
    //   1. The predicate IS called.
    //   2. The unconditional assignment is gone.
    expect(src).toMatch(/getCallerLocationHeader\(config\.headers\)/)
    // The fallback assignment now lives inside a `callerLoc == null`
    // branch. A regression that drops the guard would re-introduce
    // the clobber.
    expect(src).toMatch(/if \(callerLoc == null\)/)
    // The original BUG line — unconditional overwrite — MUST NOT
    // come back. Pin the negative invariant.
    expect(src).not.toMatch(/^\s*const loc = localStorage[\s\S]*?\n\s*if \(loc\) \{\n\s*config\.headers\['X-Location-Id'\] = loc\n\s*\}\n\s*return/m)
  })

  it('Authorization header injection is unaffected by the location logic', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(
        new URL('../client.ts', import.meta.url),
        'utf-8',
      ),
    )
    // The Authorization branch stays exactly as before — the fix is
    // narrowly scoped to X-Location-Id.
    expect(src).toMatch(/config\.headers\.Authorization\s*=\s*`Bearer \$\{token\}`/)
  })
})
