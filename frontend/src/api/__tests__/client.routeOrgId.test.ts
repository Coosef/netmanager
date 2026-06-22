// @vitest-environment jsdom
/**
 * PR-A REVISED — interceptor URL-authoritative X-Org-Id behavior.
 *
 * Runtime integration test that wires the real Axios interceptor to a
 * jsdom window with controlled `location.pathname` + `localStorage`
 * state and asserts the X-Org-Id header reflects the URL-authoritative
 * routeOrgId precedence:
 *
 *   1. Caller-supplied X-Org-Id header → wins (per-request override).
 *   2. routeOrgId from window.location.pathname → wins over localStorage.
 *   3. localStorage[ACTIVE_ORG_KEY] → fallback ONLY when routeOrgId is null.
 *
 * The most important guarantee is (2) — the operator's PR #108 review
 * call-out: stale localStorage cannot leak a previous tenant's scope
 * into a request issued from /app/org/<other>/*.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/store/auth', () => ({
  useAuthStore: {
    getState: () => ({ token: 'jwt-test-token', logout: vi.fn() }),
  },
}))

// The project's vitest config defaults to `node` env (Zustand persist +
// jsdom localStorage incompat per the test/config comment). Even with
// the file-level `// @vitest-environment jsdom` directive the
// jsdom-provided localStorage on some setups exposes a stub without
// `removeItem`. Stub it explicitly so the test is environment-immune.
const _storage = new Map<string, string>()
const fakeStorage = {
  getItem: (k: string): string | null => (_storage.has(k) ? _storage.get(k)! : null),
  setItem: (k: string, v: string): void => { _storage.set(k, v) },
  removeItem: (k: string): void => { _storage.delete(k) },
  clear: (): void => { _storage.clear() },
  key: (i: number): string | null => Array.from(_storage.keys())[i] ?? null,
  get length() { return _storage.size },
}
vi.stubGlobal('localStorage', fakeStorage)

// Import after the auth mock + localStorage stub; client.ts runs its
// module-side interceptor registration on import.
import client, { ACTIVE_ORG_KEY } from '../client'

function setUrl(pathname: string) {
  // jsdom's `window.location` is a Location instance; replace it
  // via history.replaceState so the interceptor's
  // `window.location.pathname` read returns the new value.
  window.history.replaceState({}, '', pathname)
}

function setStoredOrg(value: string | null) {
  if (value === null) {
    fakeStorage.removeItem(ACTIVE_ORG_KEY)
  } else {
    fakeStorage.setItem(ACTIVE_ORG_KEY, value)
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callInterceptor(config: any): Promise<any> {
  // Run the single registered request interceptor exposed by client.ts.
  // Axios stores them on `client.interceptors.request.handlers`; we
  // call the first (and only) handler's fulfilled callback directly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler = (client.interceptors.request as any).handlers[0]
  const fulfilled = handler.fulfilled
  return fulfilled(config)
}


describe('interceptor — X-Org-Id URL-authoritative precedence (runtime)', () => {
  beforeEach(() => {
    setUrl('/')
    setStoredOrg(null)
  })

  it('URL /app/org/6/devices → X-Org-Id = 6 (even with no localStorage)', async () => {
    setUrl('/app/org/6/devices')
    setStoredOrg(null)
    const config = { headers: {} as Record<string, unknown> }
    const out = await callInterceptor(config)
    expect(out.headers['X-Org-Id']).toBe('6')
  })

  it('URL /app/org/6/devices + localStorage=1 → X-Org-Id = 6 (URL WINS)', async () => {
    // CRITICAL CACHE-LEAK GUARD: the operator's PR #108 review call-out.
    // A stale localStorage value cannot scope a request to a tenant
    // the URL is not currently displaying.
    setUrl('/app/org/6/devices')
    setStoredOrg('1')
    const config = { headers: {} as Record<string, unknown> }
    const out = await callInterceptor(config)
    expect(out.headers['X-Org-Id']).toBe('6')
  })

  it('URL /app/org/42/agents + localStorage=99 → X-Org-Id = 42', async () => {
    setUrl('/app/org/42/agents')
    setStoredOrg('99')
    const config = { headers: {} as Record<string, unknown> }
    const out = await callInterceptor(config)
    expect(out.headers['X-Org-Id']).toBe('42')
  })

  it('legacy URL /dashboard + localStorage=6 → X-Org-Id = 6 (fallback)', async () => {
    // Outside the operations panel, the URL has no routeOrgId so the
    // localStorage preference is the correct authority — this preserves
    // the PR #106 super-admin scoped-tenant behavior for legacy routes.
    setUrl('/dashboard')
    setStoredOrg('6')
    const config = { headers: {} as Record<string, unknown> }
    const out = await callInterceptor(config)
    expect(out.headers['X-Org-Id']).toBe('6')
  })

  it('legacy URL /dashboard + no localStorage → X-Org-Id absent', async () => {
    setUrl('/dashboard')
    setStoredOrg(null)
    const config = { headers: {} as Record<string, unknown> }
    const out = await callInterceptor(config)
    expect(out.headers['X-Org-Id']).toBeUndefined()
  })

  it('caller-supplied X-Org-Id wins over both URL and localStorage', async () => {
    // Per-request override (PR #105 / #106 caller-respect contract).
    setUrl('/app/org/6/devices')
    setStoredOrg('99')
    const config = { headers: { 'X-Org-Id': '777' } as Record<string, unknown> }
    const out = await callInterceptor(config)
    expect(out.headers['X-Org-Id']).toBe('777')
  })

  it('lowercase caller header is respected (case-insensitive contract)', async () => {
    setUrl('/app/org/6/devices')
    setStoredOrg(null)
    const config = { headers: { 'x-org-id': '555' } as Record<string, unknown> }
    const out = await callInterceptor(config)
    // The caller-respect predicate finds 'x-org-id' (case-insensitive)
    // and we DO NOT overwrite — the lowercase form survives.
    expect(out.headers['x-org-id']).toBe('555')
    expect(out.headers['X-Org-Id']).toBeUndefined()
  })

  it('URL /platform/overview → X-Org-Id NOT auto-set from URL (platform shell)', async () => {
    // The platform control plane operates ABOVE tenants. routeOrgId is
    // null there, so the URL never auto-injects an X-Org-Id.
    setUrl('/platform/overview')
    setStoredOrg(null)
    const config = { headers: {} as Record<string, unknown> }
    const out = await callInterceptor(config)
    expect(out.headers['X-Org-Id']).toBeUndefined()
  })

  it('URL /platform/organizations/6 → X-Org-Id NOT auto-set (platform :organizationId is NOT operations)', async () => {
    // The Firma detail page uses :organizationId in its own URL but
    // it is NOT inside the operations panel — extractRouteOrgId returns
    // null for /platform/*. Backend stays in super-admin bypass.
    setUrl('/platform/organizations/6')
    setStoredOrg(null)
    const config = { headers: {} as Record<string, unknown> }
    const out = await callInterceptor(config)
    expect(out.headers['X-Org-Id']).toBeUndefined()
  })
})
