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
}
