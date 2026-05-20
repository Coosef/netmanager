import client from './client'

/**
 * Faz 8 Phase E — the request location context.
 *
 * `/context/current` is the single source of truth the frontend uses for
 * which locations the authenticated user may access. The list is derived
 * server-side from `user_locations`, never from the organization — a
 * normal user sees only their assigned locations.
 */

export interface AccessibleLocation {
  id: number
  name: string
  color: string | null
  city: string | null
  country: string | null
  device_count: number
}

export interface CurrentContext {
  user_id: number
  username: string
  system_role: string
  is_super_admin: boolean
  /** super-admin or org-admin — operates across the whole organization. */
  is_org_wide: boolean
  organization: { id: number; name: string; slug: string } | null
  /** Locations the user may access — the user_locations source of truth. */
  locations: AccessibleLocation[]
  allowed_location_ids: number[]
  /** The backend-resolved active location (validated X-Location-Id). */
  active_location_id: number | null
  /** False when a location-scoped user has no usable location. */
  has_location_access: boolean
}

export const contextApi = {
  current: () => client.get<CurrentContext>('/context/current').then((r) => r.data),
}
