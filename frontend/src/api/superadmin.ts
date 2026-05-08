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

export const superadminApi = {
  getSystemStats: () =>
    client.get<SystemStats>('/super-admin/system-stats').then((r) => r.data),

  updateTenantPlan: (tenantId: number, plan_tier: string, max_devices: number, max_users: number) =>
    client.patch(`/super-admin/tenants/${tenantId}/plan`, null, {
      params: { plan_tier, max_devices, max_users },
    }).then((r) => r.data),

  toggleTenantActive: (tenantId: number) =>
    client.patch(`/super-admin/tenants/${tenantId}/toggle-active`).then((r) => r.data),
}
