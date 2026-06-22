import axios from 'axios'
import { useAuthStore } from '@/store/auth'

const client = axios.create({
  baseURL: '/api/v1',
  timeout: 30000,
})

// Faz 7 — the active location id; the SiteContext keeps this in sync.
// Stored module-side so every request carries it without prop drilling.
export const ACTIVE_LOCATION_KEY = 'nm-active-location-id'

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
  if (headers == null) return undefined
  // AxiosHeaders shape — `.get(name)` is case-insensitive in axios 1.x.
  const maybeGet = (headers as { get?: (name: string) => unknown }).get
  if (typeof maybeGet === 'function') {
    const v = maybeGet.call(headers, 'X-Location-Id')
    return typeof v === 'string' && v.length > 0 ? v : undefined
  }
  // Plain-object shape — manual case-insensitive scan.
  const obj = headers as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    if (key.toLowerCase() === 'x-location-id') {
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
