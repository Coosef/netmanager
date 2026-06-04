import client from './client'

export interface SystemStats {
  organizations: { total: number; active: number; by_plan: Record<string, number> }
  users: { total: number }
  devices: { total: number; online: number; offline: number }
  locations: { total: number }
  events_24h: { total: number; critical: number }
  tasks: { running: number }
  top_organizations_by_devices: {
    id: number
    name: string
    plan_tier: string
    device_count: number
  }[]
}

export interface ResourceDevice {
  id: number
  hostname: string
  ip_address: string
  site: string | null
  status: string
  org_id: number | null
  org_name: string | null
}

export interface ResourceAgent {
  id: string
  name: string
  status: string
  platform: string | null
  version: string | null
  org_id: number | null
  org_name: string | null
}

// ── Faz 8 Phase H — organization management ──────────────────────────────────

export type OrgStatus = 'active' | 'suspended' | 'archived'

export interface OrgQuota {
  max_locations: number
  max_devices: number
  max_agents: number
  max_users: number
  max_retention_days: number
}

export interface Organization {
  id: number
  name: string
  slug: string
  description: string | null
  is_active: boolean
  contact_email: string | null
  plan_id: number | null
  status: OrgStatus
  license_started_at: string | null
  license_expires_at: string | null
  quota: OrgQuota
  created_at: string
}

/**
 * Organization row enriched with inline counts + plan slug. Returned by
 * `/super-admin/orgs?with_counts=true` (added by `list_orgs` in M6 for the
 * platform-admin dashboard so a single round-trip surfaces device / user /
 * location usage per org).
 */
export interface OrganizationWithCounts extends Organization {
  device_count: number
  user_count: number
  location_count: number
  plan_tier: string
}

export interface OrgUsageResource {
  used: number
  limit: number
  percent: number
  over_limit: boolean
}

export interface OrgUsage {
  organization_id: number
  status: OrgStatus
  resources: Record<'locations' | 'devices' | 'agents' | 'users', OrgUsageResource>
  events_24h: number
  max_retention_days: number | null
  license_expires_at: string | null
  over_quota: boolean
}

/** Payload for a super-admin organization update — status / licence / quota. */
export interface OrgUpdatePayload {
  status?: OrgStatus
  license_started_at?: string | null
  license_expires_at?: string | null
  max_locations?: number
  max_devices?: number
  max_agents?: number
  max_users?: number
  max_retention_days?: number
  plan_id?: number | null
}

/** RBAC F5 — payload for /super-admin/orgs POST. The first admin user
 *  is provisioned in the same transaction as the org itself; both the
 *  org + that user appear atomically (no half-created orgs). */
export interface OrgCreatePayload {
  name: string
  slug: string
  description?: string
  contact_email?: string
  plan_id?: number
  trial_days?: number          // default 14 on the backend
  // First admin user — required
  admin_username: string
  admin_email: string
  admin_password: string
  admin_full_name?: string
}

export const superadminApi = {
  getSystemStats: () =>
    client.get<SystemStats>('/super-admin/system-stats').then((r) => r.data),

  listDevices: (params?: { org_id?: number; unassigned?: boolean; skip?: number; limit?: number }) =>
    client.get<{ total: number; devices: ResourceDevice[] }>('/super-admin/resources/devices', { params })
      .then((r) => r.data),

  listAgents: (params?: { unassigned?: boolean }) =>
    client.get<{ agents: ResourceAgent[] }>('/super-admin/resources/agents', { params })
      .then((r) => r.data),

  /**
   * QF-7 — assign resources to an organization, optionally moving them to a
   * specific location within that organization. `location_id` must belong to
   * the target org or the backend returns 400.
   */
  assignResources: (
    resource_type: 'device' | 'agent',
    resource_ids: (number | string)[],
    org_id: number,
    location_id?: number | null,
  ) =>
    client.patch<{
      ok: boolean;
      assigned: number;
      org_id: number;
      org_name: string;
      location_id: number | null;
      location_name: string | null;
    }>(
      '/super-admin/resources/assign',
      location_id != null
        ? { resource_type, resource_ids, org_id, location_id }
        : { resource_type, resource_ids, org_id },
    ).then((r) => r.data),

  // ── Faz 8 Phase H — organization management (super-admin only) ─────────────
  /**
   * List organizations. Pass `with_counts: true` to get the enriched
   * `OrganizationWithCounts` shape used by the platform-admin dashboard.
   * Without it, plain `Organization` rows are returned (counts omitted).
   */
  listOrgs: (params?: { page?: number; per_page?: number; with_counts?: boolean }) =>
    client.get<{ total: number; orgs: Organization[] }>('/super-admin/orgs', { params })
      .then((r) => r.data),

  listOrgsWithCounts: (params?: { page?: number; per_page?: number }) =>
    client.get<{ total: number; orgs: OrganizationWithCounts[] }>(
      '/super-admin/orgs',
      { params: { ...params, with_counts: true } },
    ).then((r) => r.data),

  getOrg: (orgId: number) =>
    client.get<Organization>(`/super-admin/orgs/${orgId}`).then((r) => r.data),

  getOrgUsage: (orgId: number) =>
    client.get<OrgUsage>(`/super-admin/orgs/${orgId}/usage`).then((r) => r.data),

  updateOrg: (orgId: number, payload: OrgUpdatePayload) =>
    client.patch<Organization>(`/super-admin/orgs/${orgId}`, payload).then((r) => r.data),

  /** Create a new organization and its first admin user atomically.
   *  Super-admin only. Backend validates slug uniqueness + format
   *  (`^[a-z0-9-]+$`) and provisions default permission sets. */
  createOrg: (payload: OrgCreatePayload) =>
    client.post<Organization>('/super-admin/orgs', payload).then((r) => r.data),

  // T8.4 — Canlı Oturumlar (Live Sessions)
  listSessions: (params?: { include_revoked?: boolean; limit?: number }) =>
    client.get<{ items: SessionItem[]; total: number }>(
      '/super-admin/sessions',
      { params: params ?? {} },
    ).then((r) => r.data),

  revokeSession: (sessionId: number) =>
    client.delete(`/super-admin/sessions/${sessionId}`),
}

// T8.4 — UserSession row shape (backend list_sessions response)
export interface SessionItem {
  id: number
  jti: string
  user_id: number
  username: string
  full_name: string | null
  role: string
  organization_id: number | null
  ip: string | null
  user_agent: string | null
  created_at: string
  last_activity: string
  expires_at: string
  expired: boolean
  revoked_at: string | null
  revoked_reason: string | null
}
