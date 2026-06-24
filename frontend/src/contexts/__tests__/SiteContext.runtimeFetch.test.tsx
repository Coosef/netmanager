// @vitest-environment jsdom
/**
 * P0.2.2 CONTEXT QUERY TOKEN-ONLY GATE — RUNTIME FETCH PROOF (2026-06-24).
 *
 * Operator's P0.2.2 ROOT CAUSE AUDIT closed with class B: SiteProvider
 * was mounted and the queryKey carried the P0.2.1 sessionEpoch correctly,
 * BUT `enabled: !!token && hydrated` evaluated to false at runtime
 * because SiteProvider's per-instance `useHasHydrated()` snapshot stayed
 * pinned at false even after ProtectedRoute's token-first matrix had
 * already admitted the user. The gate was wrong; React Query's disabled
 * observer never called queryFn, so /api/v1/context/current never
 * reached the network — while sibling unconditional queries (monitor-
 * stats, header-recent-events, approval-pending-count) fired normally.
 *
 * Every pre-existing SiteContext test in this directory verified the
 * queryKey SHAPE via source-string-match. None of them rendered the
 * real provider tree and asserted that the queryFn actually executed.
 * That gap is the test boundary this file closes.
 *
 * ──── What this file proves at the runtime level ──────────────────────
 *
 * 1. Token absent  → queryFn NEVER called
 * 2. Token present at mount → queryFn called exactly once
 * 3. setAuth from a null-token mount → queryFn called exactly once
 * 4. logout + re-setAuth round-trip → queryFn called twice
 *    (P0.2.1 sessionEpoch queryKey identity diverges per session)
 * 5. hydrated=false + token present → queryFn STILL called (the
 *    behavioral cornerstone of P0.2.2 — token-only gate, not
 *    token-AND-hydrated)
 * 6. Security pin: queryKey contains no raw token / bearer / authToken /
 *    email / userId / password — sessionEpoch is the only auth-derived
 *    member of the key
 *
 * ──── Why this matters operationally ──────────────────────────────────
 *
 * The pre-P0.2.2 source-string-match suite would have PASSED with the
 * production-bugged enabled gate intact — the bug WAS the gate, and the
 * tests pinned the gate's literal shape. A behavioral regression of the
 * kind that took P0.2 + P0.2.1 (and the live production audit that
 * surfaced this fix) to nail down is undetectable from source-text
 * pinning alone. This file plus the new behavioral contracts inside
 * SiteContext.sessionEpoch.test.tsx form the runtime-level safety net.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// ─── localStorage stub (jsdom workaround) ──────────────────────────────
//
// vite.config.ts notes the known jsdom + Zustand persist incompatibility.
// Under this vitest jsdom env, the default `localStorage` object lacks
// a callable `removeItem` (and likely a malformed `setItem` / `getItem`
// surface — same root cause as the Zustand persist breakage). Provide
// a minimal in-memory Storage stub BEFORE any module that uses
// `localStorage` runs — SiteContext's useState initializers read
// `localStorage.getItem(ACTIVE_LOCATION_KEY)` on mount.
const _localStorageMemory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => _localStorageMemory.get(k) ?? null,
    setItem: (k: string, v: string) => {
      _localStorageMemory.set(k, String(v))
    },
    removeItem: (k: string) => {
      _localStorageMemory.delete(k)
    },
    clear: () => {
      _localStorageMemory.clear()
    },
    key: (i: number) => Array.from(_localStorageMemory.keys())[i] ?? null,
    get length() {
      return _localStorageMemory.size
    },
  },
})

// ─── Module-boundary mocks ─────────────────────────────────────────────
//
// We mock TWO modules at the import boundary:
//
//   1. `@/api/context` — so contextApi.current is a spy whose call
//      count is the canonical runtime signal of "did the queryFn run?".
//      The mock returns a resolved Promise carrying a valid CurrentContext
//      payload so SiteProvider's downstream derivations (sitesLoading,
//      ctxResolved, organization, locations) settle without errors.
//
//   2. `@/hooks/useHasHydrated` — so we can independently control the
//      `hydrated` flag's value per-test. This is the load-bearing
//      isolation for contract 5 ("hydrated=false + token = still fetch")
//      that proves token-only is now the API-fetch trigger.
//
// We DO NOT mock `@/store/auth` — every contract exercises the REAL
// Zustand store + its real setAuth/logout reducers, so the proof
// matches what the production code path runs.
//
// `vi.hoisted()` is required because `vi.mock` is hoisted above any
// top-level `const` declarations; without hoisting these spies, the
// factory closure references "Cannot access X before initialization".
const { contextCurrentMock, hasHydratedMock } = vi.hoisted(() => ({
  contextCurrentMock: vi.fn(),
  hasHydratedMock: vi.fn(() => true as boolean),
}))

vi.mock('@/api/context', () => ({
  contextApi: {
    current: contextCurrentMock,
  },
}))

vi.mock('@/hooks/useHasHydrated', () => ({
  useHasHydrated: () => hasHydratedMock(),
}))

import { SiteProvider, useSite } from '@/contexts/SiteContext'
import { useAuthStore } from '@/store/auth'
import { ACTIVE_LOCATION_KEY, ACTIVE_ORG_KEY } from '@/api/client'

// ─── Persist storage substitution (jsdom + Zustand v5 workaround) ─────
//
// vite.config.ts marks the default vitest environment as `node`
// because "jsdom env globally zustand persist localStorage uyumsuzluğu
// yaratıyor". This file needs jsdom for React Query observers + DOM
// rendering, but the Zustand persist write path under jsdom raises
// "storage.setItem is not a function" because the default JSON storage
// captured a malformed localStorage shape at module-import time.
//
// Replace the persist storage with an in-memory implementation BEFORE
// any setState fires. zustand v5's `persist.setOptions({ storage })`
// swaps the storage at runtime; the swap takes effect for the next
// persist write. We do this once at module top-level so every test in
// the file inherits the safe storage path. The store's reducer
// behavior (setAuth bump, logout) is unaffected — we are only
// short-circuiting the disk-side persist plumbing.
const _persistMemory = new Map<string, string>()
useAuthStore.persist.setOptions({
  storage: {
    getItem: (name: string) => {
      const v = _persistMemory.get(name)
      return v == null ? null : JSON.parse(v)
    },
    setItem: (name: string, value: unknown) => {
      _persistMemory.set(name, JSON.stringify(value))
    },
    removeItem: (name: string) => {
      _persistMemory.delete(name)
    },
  },
})

const CTX_PAYLOAD = {
  user_id: 1,
  username: 'admin',
  system_role: 'super_admin',
  is_super_admin: true,
  is_org_wide: true,
  organization: { id: 6, name: 'ATG Hotels', slug: 'atg-hotels' },
  features: {},
  locations: [
    { id: 42, name: 'IST-DC', color: null, city: 'Istanbul', country: 'TR', device_count: 11 },
  ],
  allowed_location_ids: [42],
  active_location_id: 42,
  has_location_access: true,
}

// Minimal shape matching AuthUser in store/auth.ts. `setAuth` accepts
// the shape via the public reducer; `setState` here uses `as never`
// at the call sites because the AuthState's `user` field is the
// private AuthUser union and the test file does not need to re-export
// the type.
const ADMIN_USER = {
  id: 1,
  username: 'admin',
  role: 'super_admin',
  system_role: 'super_admin',
  org_id: null,
}
const EMRE_USER = {
  id: 2,
  username: 'emre',
  role: 'org_admin',
  system_role: 'org_admin',
  org_id: 6,
}

function makeQueryClient() {
  // Per-test client → no cache bleed across cases. Disable retry so
  // a transient resolve doesn't get double-counted by React Query's
  // retry policy on a failed mock invocation.
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
}

function Probe() {
  // Drains useSite() so SiteContext.Provider value is consumed (forces
  // SiteContext consumers to commit). Returns a tiny DOM marker so we
  // can assert mount.
  const ctx = useSite()
  return (
    <div
      data-testid="probe"
      data-ctx-resolved={String(ctx.ctxResolved)}
      data-sites-loading={String(ctx.sitesLoading)}
    />
  )
}

function renderWithProvider(initialPath = '/app/org/6/devices') {
  const qc = makeQueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <SiteProvider>
          <Probe />
        </SiteProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function resetAuthStore() {
  // Real reducer, but we wipe the persisted state shape directly so
  // the next test starts cold. We do NOT call logout() because logout
  // dispatches a dynamic import that resolves asynchronously and would
  // race with the test's awaits.
  useAuthStore.setState({
    token: null,
    user: null,
    permissions: null,
    sessionEpoch: 0,
  } as never)
}

beforeEach(() => {
  resetAuthStore()
  localStorage.removeItem(ACTIVE_LOCATION_KEY)
  localStorage.removeItem(ACTIVE_ORG_KEY)
  contextCurrentMock.mockReset()
  contextCurrentMock.mockResolvedValue(CTX_PAYLOAD)
  hasHydratedMock.mockReset()
  hasHydratedMock.mockReturnValue(true)
})

afterEach(() => {
  cleanup()
})

// ─── Contract 1 — token=null → queryFn NEVER called ────────────────────

describe('SiteContext runtime fetch — Contract 1: no token, no fetch', () => {
  it('renders without calling contextApi.current when token is absent', async () => {
    renderWithProvider()
    // Give React Query a couple of microtask + macrotask ticks to
    // attempt a fetch. None should arrive because enabled = !!token
    // = !!null = false.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30))
    })
    expect(contextCurrentMock).toHaveBeenCalledTimes(0)
  })
})

// ─── Contract 2 — token present at mount → queryFn called once ────────

describe('SiteContext runtime fetch — Contract 2: token-at-mount fires fetch', () => {
  it('calls contextApi.current exactly once when SiteProvider mounts with a token already in the store', async () => {
    useAuthStore.setState({
      token: 'mount-token',
      user: ADMIN_USER,
      permissions: null,
      sessionEpoch: 1,
    } as never)
    renderWithProvider()
    await waitFor(() => {
      expect(contextCurrentMock).toHaveBeenCalledTimes(1)
    })
    // No spurious second call follows.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30))
    })
    expect(contextCurrentMock).toHaveBeenCalledTimes(1)
  })
})

// ─── Contract 3 — setAuth from null-mount → queryFn called once ───────

describe('SiteContext runtime fetch — Contract 3: setAuth after mount triggers fetch', () => {
  it('mounts with token=null (0 calls), then setAuth pushes one fetch through', async () => {
    renderWithProvider()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(contextCurrentMock).toHaveBeenCalledTimes(0)
    await act(async () => {
      useAuthStore.getState().setAuth('post-mount-token', ADMIN_USER as never, null)
      await new Promise((r) => setTimeout(r, 30))
    })
    await waitFor(() => {
      expect(contextCurrentMock).toHaveBeenCalledTimes(1)
    })
  })
})

// ─── Contract 4 — logout → re-setAuth round-trip refetches ────────────

describe('SiteContext runtime fetch — Contract 4: same-tab logout/login refetches', () => {
  it('emits a second fetch after logout + re-setAuth with the same route + location', async () => {
    // First session — token + sessionEpoch=1 (incremented by setAuth)
    useAuthStore.setState({
      token: null,
      user: null,
      permissions: null,
      sessionEpoch: 0,
    } as never)
    renderWithProvider('/app/org/6/devices')
    await act(async () => {
      useAuthStore.getState().setAuth('session-1-tok', ADMIN_USER as never, null)
      await new Promise((r) => setTimeout(r, 30))
    })
    await waitFor(() => {
      expect(contextCurrentMock).toHaveBeenCalledTimes(1)
    })
    const epochAfterFirstLogin = useAuthStore.getState().sessionEpoch
    expect(epochAfterFirstLogin).toBe(1)
    // Logout — clear token/user/permissions directly (logout()'s
    // dynamic import races with this synchronous test path). We
    // intentionally do NOT touch sessionEpoch (operator contract).
    await act(async () => {
      useAuthStore.setState({ token: null, user: null, permissions: null } as never)
      await new Promise((r) => setTimeout(r, 10))
    })
    // Re-login — same route URL, same activeLocationId, new token
    await act(async () => {
      useAuthStore.getState().setAuth('session-2-tok', EMRE_USER as never, null)
      await new Promise((r) => setTimeout(r, 30))
    })
    // P0.2.1 sessionEpoch contract: queryKey shape changes per
    // session, React Query allocates a fresh observer slot, queryFn
    // fires for the new session.
    await waitFor(() => {
      expect(contextCurrentMock).toHaveBeenCalledTimes(2)
    })
    const epochAfterSecondLogin = useAuthStore.getState().sessionEpoch
    expect(epochAfterSecondLogin).toBe(2)
    expect(epochAfterSecondLogin).toBeGreaterThan(epochAfterFirstLogin)
  })
})

// ─── Contract 5 — hydrated=false + token → queryFn STILL fires ────────

describe('SiteContext runtime fetch — Contract 5: P0.2.2 token-only gate', () => {
  it('fetches when token is present EVEN IF useHasHydrated returns false (P0.2.2 contract)', async () => {
    // This is the CORE P0.2.2 behavioral guarantee. The pre-fix gate
    // `!!token && hydrated` failed in production because SiteProvider's
    // local hydrated stayed pinned at false. With the post-fix gate
    // `!!token`, the fetch fires regardless of the hydrated flag —
    // which the SiteProvider also still consumes downstream for the
    // sitesLoading / hasContextFailure UI loading copy, but NO LONGER
    // for the API-fetch trigger.
    hasHydratedMock.mockReturnValue(false)
    useAuthStore.setState({
      token: 'still-hydrating-but-real-token',
      user: ADMIN_USER,
      permissions: null,
      sessionEpoch: 1,
    } as never)
    renderWithProvider()
    await waitFor(() => {
      expect(contextCurrentMock).toHaveBeenCalledTimes(1)
    })
  })

  it('does NOT fetch when hydrated=false AND token=null (defensive — pre-token window)', async () => {
    // Symmetric guard: in a true pre-hydration window where neither
    // the token nor the hydrated flag are ready, the fetch must NOT
    // fire. Token-only gate falls back to "no token → no fetch" at
    // the negative pole.
    hasHydratedMock.mockReturnValue(false)
    renderWithProvider()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30))
    })
    expect(contextCurrentMock).toHaveBeenCalledTimes(0)
  })
})

// ─── Contract 6 — security pin: queryKey carries no auth secret ───────

describe('SiteContext runtime fetch — Contract 6: queryKey security pin', () => {
  it('queryKey never carries raw token / bearer / authToken / email / userId / password — sessionEpoch is the only auth-derived member', async () => {
    useAuthStore.setState({
      token: 'a-real-bearer-token-shape',
      user: { ...ADMIN_USER, email: 'admin@example.com', id: 7 },
      permissions: null,
      sessionEpoch: 4,
    } as never)
    const qc = makeQueryClient()
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/app/org/6/devices']}>
          <SiteProvider>
            <Probe />
          </SiteProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await waitFor(() => {
      expect(contextCurrentMock).toHaveBeenCalledTimes(1)
    })
    // Walk the real query cache and assert that the only entry whose
    // first segment is 'context' has the canonical 5-tuple — and that
    // none of the auth-secret aliases appear anywhere in its key.
    const entries = qc.getQueryCache().getAll()
    const ctxEntries = entries.filter((e) => Array.isArray(e.queryKey) && e.queryKey[0] === 'context')
    expect(ctxEntries.length).toBeGreaterThanOrEqual(1)
    for (const entry of ctxEntries) {
      const key = entry.queryKey as ReadonlyArray<unknown>
      // canonical shape: ['context', 'current', sessionEpoch, routeOrgId, activeLocationId]
      expect(key[0]).toBe('context')
      expect(key[1]).toBe('current')
      expect(typeof key[2]).toBe('number')        // sessionEpoch — opaque integer
      expect(key[2]).toBe(4)                       // exact epoch
      expect(key[3]).toBe(6)                       // routeOrgId
      // activeLocationId: null OR a number — both are valid values;
      // the security contract is "not the bearer". Coerce to string
      // for the substring scan and pin neither the literal nor any
      // alias of any auth secret.
      const stringified = JSON.stringify(key)
      expect(stringified).not.toContain('a-real-bearer-token-shape')
      expect(stringified.toLowerCase()).not.toMatch(/bearer/)
      expect(stringified.toLowerCase()).not.toMatch(/authtoken/)
      expect(stringified.toLowerCase()).not.toMatch(/auth_token/)
      expect(stringified.toLowerCase()).not.toMatch(/accesstoken/)
      expect(stringified.toLowerCase()).not.toMatch(/password/)
      expect(stringified).not.toContain('admin@example.com')
      // userId 7 must not appear anywhere in the key — only the
      // routeOrgId 6 + sessionEpoch 4 are numeric members.
      const numbersInKey = key.filter((k) => typeof k === 'number') as number[]
      expect(numbersInKey).not.toContain(7)
    }
  })
})

// ─── Wrap-up: provider mount + child render contract ──────────────────

describe('SiteContext runtime fetch — provider sanity', () => {
  it('renders the child Probe even before any fetch (provider mount is unconditional)', async () => {
    const { getByTestId } = renderWithProvider()
    expect(getByTestId('probe')).toBeTruthy()
  })

  it('Probe sees ctxResolved=true after the fetch settles', async () => {
    useAuthStore.setState({
      token: 'tok',
      user: ADMIN_USER,
      permissions: null,
      sessionEpoch: 1,
    } as never)
    const { getByTestId } = renderWithProvider()
    await waitFor(() => {
      expect(getByTestId('probe').getAttribute('data-ctx-resolved')).toBe('true')
    })
  })
})
