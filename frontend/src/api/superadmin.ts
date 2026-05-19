import client from './client'

export interface SystemStats {
  tenants: { total: number; active: number; by_plan: Record<string, number> }
  users: { total: number }
  devices: { total: number; online: number; offline: number }
  locations: { total: number }
  events_24h: { total: number; critical: number }
  tasks: { running: number }
  top_tenants_by_devices: { id: number; name: string; plan_tier: string; device_count: number }[]
}

export interface ResourceDevice {
  id: number
  hostname: string
  ip_address: string
  site: string | null
  status: string
  tenant_id: number | null
  tenant_name: string | null
}

export interface ResourceAgent {
  id: string
  name: string
  status: string
  platform: string | null
  version: string | null
  tenant_id: number | null
  tenant_name: string | null
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

export const superadminApi = {
  getSystemStats: () =>
    client.get<SystemStats>('/super-admin/system-stats').then((r) => r.data),

  updateTenantPlan: (tenantId: number, plan_tier: string, max_devices: number, max_users: number) =>
    client.patch(`/super-admin/tenants/${tenantId}/plan`, null, {
      params: { plan_tier, max_devices, max_users },
    }).then((r) => r.data),

  toggleTenantActive: (tenantId: number) =>
    client.patch(`/super-admin/tenants/${tenantId}/toggle-active`).then((r) => r.data),

  listDevices: (params?: { tenant_id?: number; unassigned?: boolean; skip?: number; limit?: number }) =>
    client.get<{ total: number; devices: ResourceDevice[] }>('/super-admin/resources/devices', { params })
      .then((r) => r.data),

  listAgents: (params?: { unassigned?: boolean }) =>
    client.get<{ agents: ResourceAgent[] }>('/super-admin/resources/agents', { params })
      .then((r) => r.data),

  assignResources: (resource_type: 'device' | 'agent', resource_ids: (number | string)[], tenant_id: number) =>
    client.patch<{ ok: boolean; assigned: number; tenant_id: number; tenant_name: string }>(
      '/super-admin/resources/assign',
      { resource_type, resource_ids, tenant_id },
    ).then((r) => r.data),

  // ── Faz 8 Phase H — organization management (super-admin only) ─────────────
  listOrgs: (params?: { page?: number; per_page?: number }) =>
    client.get<{ total: number; orgs: Organization[] }>('/super-admin/orgs', { params })
      .then((r) => r.data),

  getOrg: (orgId: number) =>
    client.get<Organization>(`/super-admin/orgs/${orgId}`).then((r) => r.data),

  getOrgUsage: (orgId: number) =>
    client.get<OrgUsage>(`/super-admin/orgs/${orgId}/usage`).then((r) => r.data),

  updateOrg: (orgId: number, payload: OrgUpdatePayload) =>
    client.patch<Organization>(`/super-admin/orgs/${orgId}`, payload).then((r) => r.data),
}
