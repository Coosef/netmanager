import client from './client'

/**
 * PLATFORM/OPERATIONS-PHASE1A (2026-06-22) — Organization list contract
 * for the super-admin Organization Switcher widget.
 *
 * Backend endpoint:  GET /api/v1/context/organizations
 * Authorization:     super_admin ONLY (SuperAdminOnly dependency)
 * Behavior:          returns every non-deleted organization, ordered by name
 * RLS:               this endpoint runs OUTSIDE the org-RLS scope by design
 *                    (`organizations` is the platform-control-plane table)
 *
 * The widget is mounted in `Header.tsx` and only renders when
 * `useSite().isSuperAdmin` is true; the API contract here mirrors the
 * existing backend route which already exists from a prior Faz 8 phase.
 * No backend change is needed for Phase 1A.
 */
export interface Organization {
  id: number
  name: string
  slug: string
  is_active: boolean
}

export const organizationsApi = {
  /**
   * List every organization the super-admin may scope into. Returns an
   * empty array for non-super-admin callers (backend 403; the widget
   * gates on `isSuperAdmin` so this should not happen in practice).
   */
  list: () =>
    client.get<Organization[]>('/context/organizations').then((r) => r.data),
}
