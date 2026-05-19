import axios from 'axios'
import { useAuthStore } from '@/store/auth'

const client = axios.create({
  baseURL: '/api/v1',
  timeout: 30000,
})

// Faz 7 — the active location id; the SiteContext keeps this in sync.
// Stored module-side so every request carries it without prop drilling.
export const ACTIVE_LOCATION_KEY = 'nm-active-location-id'

client.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  // Faz 8 Phase E — active-location header. The backend validates it
  // against user_locations on every request (never trusts it as given)
  // and RLS enforces isolation regardless; a stale/forged value fails
  // closed server-side. Absent ⇒ the backend resolves a default.
  const loc = localStorage.getItem(ACTIVE_LOCATION_KEY)
  if (loc) {
    config.headers['X-Location-Id'] = loc
  }
  return config
})

client.interceptors.response.use(
  (res) => res,
  (error) => {
    if (error.response?.status === 401 && window.location.pathname !== '/login') {
      useAuthStore.getState().logout()
      window.location.href = '/login'
    }
    return Promise.reject(error)
  },
)

export default client
