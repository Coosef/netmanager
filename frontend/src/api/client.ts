import axios from 'axios'
import { useAuthStore } from '@/store/auth'
import { extractRouteOrgId } from '@/utils/panelMode'

const client = axios.create({
  baseURL: '/api/v1',
  timeout: 30000,
})

// Faz 7 — the active location id; the SiteContext keeps this in sync.
// Stored module-side so every request carries it without prop drilling.
export const ACTIVE_LOCATION_KEY = 'nm-active-location-id'

/**
 * PLATFORM/OPERATIONS-PHASE1A (2026-06-22) — the active organization id
 * for super-admins. The SiteContext keeps it in sync; the interceptor
 * below attaches it as `X-Org-Id` so the backend's
 * `request_context.resolve_location_context(x_org_id=...)` path can drop
 * the super-admin RLS bypass and scope into the requested tenant — the
 * unblocking primitive for the "add device to Mövempic" use case.
 *
 * Normal users do NOT need this key — their tenant is fixed server-side
 * by the JWT and an injected X-Org-Id is silently ignored by the backend
 * (`resolve_location_context` gates on `sup AND x_org_id is not None`).
 * The SiteContext defensively removes the key from localStorage when the
 * caller is not a super-admin, so a previously-super-admin session that
 * was demoted cannot keep a stale org id.
 */
export const ACTIVE_ORG_KEY = 'nm-active-org-id'

/**
 * X-LOC-INTERCEPTOR-FIX (2026-06-21) — return the caller-supplied
 * X-Location-Id header, honoring case-insensitivity AND both header
 * shapes axios may have already normalized the config into:
 *
 *   1. plain object: `{ 'X-Location-Id': '2' }` or `{ 'x-location-id': '2' }`
 *   2. AxiosHeaders instance (post-1.x): exposes a `.get(name)` that
 *      already handles case-insensitive lookup. We feature-detect
 *      `.get` to stay shape-agnostic — older axios test mocks pass
 *      a bare object.
 *
 * The pre-fix interceptor read `localStorage` and ALWAYS wrote
 * `config.headers['X-Location-Id']`, silently overwriting any value
 * the caller had attached for a per-request override. DeviceForm's
 * per-request override was the load-bearing contract that backend
 * cross-tenant guards relied on; with the clobber bug, every
 * DeviceForm create call resolved to the GLOBAL active location
 * (`localStorage[nm-active-location-id]`) instead of the form's
 * picked location. For a super_admin in another tenant's location
 * context this produced a backend 400 the operator could not escape.
 *
 * The helper is exported for the unit tests next to this file; the
 * interceptor itself is exercised by them at the axios-config level.
 */
export function getCallerLocationHeader(
  headers: unknown,
): string | undefined {
  return getCallerHeader(headers, 'X-Location-Id')
}

/**
 * PLATFORM/OPERATIONS-PHASE1A (2026-06-22) — caller-supplied X-Org-Id
 * detection, mirror of `getCallerLocationHeader`. The interceptor at the
 * bottom of this module uses it to skip the localStorage fallback when
 * the caller already attached a per-request org override (e.g. a
 * platform-admin background job that explicitly scopes into a single
 * tenant). Same case-insensitive + shape-agnostic contract as the
 * location helper — the test suite verifies the parity directly.
 */
export function getCallerOrgHeader(
  headers: unknown,
): string | undefined {
  return getCallerHeader(headers, 'X-Org-Id')
}

/**
 * Shared shape-agnostic header lookup. Extracted so the two public
 * helpers stay in lock-step on case-insensitivity and AxiosHeaders
 * handling. A future regression that drifts the two is caught by the
 * `parity` block in `client.interceptor.test.ts`.
 */
function getCallerHeader(
  headers: unknown,
  name: string,
): string | undefined {
  if (headers == null) return undefined
  const lowered = name.toLowerCase()
  // AxiosHeaders shape — `.get(name)` is case-insensitive in axios 1.x.
  const maybeGet = (headers as { get?: (name: string) => unknown }).get
  if (typeof maybeGet === 'function') {
    const v = maybeGet.call(headers, name)
    return typeof v === 'string' && v.length > 0 ? v : undefined
  }
  // Plain-object shape — manual case-insensitive scan.
  const obj = headers as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    if (key.toLowerCase() === lowered) {
      const v = obj[key]
      if (typeof v === 'string' && v.length > 0) return v
    }
  }
  return undefined
}

client.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  // Faz 8 Phase E — active-location header. The backend validates it
  // against user_locations on every request (never trusts it as given)
  // and RLS enforces isolation regardless; a stale/forged value fails
  // closed server-side. Absent ⇒ the backend resolves a default.
  //
  // X-LOC-INTERCEPTOR-FIX (2026-06-21) — the localStorage value is now
  // a FALLBACK, not an override. If the caller already attached an
  // X-Location-Id header for a per-request scope (DeviceForm's create
  // path is the canonical example — it sets the header to the
  // operator-picked location), respect it. The pre-fix interceptor
  // clobbered the caller's value, defeating the entire per-request
  // override contract `frontend/src/api/devices.ts:65` documents.
  const callerLoc = getCallerLocationHeader(config.headers)
  if (callerLoc == null) {
    const loc = localStorage.getItem(ACTIVE_LOCATION_KEY)
    if (loc) {
      config.headers['X-Location-Id'] = loc
    }
  }
  // PR-A REVISED (2026-06-22) — URL-AUTHORITATIVE X-Org-Id.
  //
  // Source-of-truth precedence (high → low):
  //   1. Caller-supplied X-Org-Id header (per-request override; the
  //      same caller-respect contract PR #105 / #106 established for
  //      X-Location-Id, extended to X-Org-Id in PHASE-1A).
  //   2. URL routeOrgId — extracted synchronously from
  //      `window.location.pathname`. Inside `/app/org/:organizationId/*`
  //      this is the SOLE authority: a previously-cached or stale
  //      `localStorage[ACTIVE_ORG_KEY]` MUST NOT scope a request to a
  //      tenant the URL is not currently displaying. This closes the
  //      cache-leak window operator flagged in the PR #108 review.
  //   3. localStorage preference hint — a non-URL-bound fallback used
  //      only when the user is OUTSIDE the operations panel (legacy
  //      routes, super-admin who has picked a tenant via the legacy
  //      OrganizationSelector but has not yet entered /app/org/*).
  //
  // The synchronous URL read is safe because every request originates
  // from a React tree mounted inside BrowserRouter — by the time the
  // interceptor fires, `window.location.pathname` reflects the route
  // the user is operating on. SSR is not a concern here (frontend is
  // SPA-only).
  const callerOrg = getCallerOrgHeader(config.headers)
  if (callerOrg == null) {
    const routeOrgId = typeof window !== 'undefined'
      ? extractRouteOrgId(window.location.pathname)
      : null
    if (routeOrgId != null) {
      config.headers['X-Org-Id'] = String(routeOrgId)
    } else {
      const org = localStorage.getItem(ACTIVE_ORG_KEY)
      if (org) {
        config.headers['X-Org-Id'] = org
      }
    }
  }
  return config
})

// DASHBOARD-REFRESH-LOGOUT-HOTFIX — 401 debounce. Dashboard mount'unda 10
// paralel auth-required istek atılır; bir tanesi 401 dönerse interceptor
// logout+redirect zincirleme tetiklenmesin (paralel 10 redirect = race).
// Network/abort/cancel hataları (error.response undefined) zaten logout
// tetiklemez — controlled 401 davranışı korunur.
let _logoutInFlight = false
client.interceptors.response.use(
  (res) => res,
  (error) => {
    if (error.response?.status === 401 && window.location.pathname !== '/login') {
      if (_logoutInFlight) return Promise.reject(error)
      _logoutInFlight = true
      useAuthStore.getState().logout()
      window.location.href = '/login'
    }
    return Promise.reject(error)
  },
)

export default client
