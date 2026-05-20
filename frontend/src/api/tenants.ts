// M6 final-drop shim. The legacy `/tenants` endpoints are gone (backend
// f8a5_drop_legacy_tenant migration); the SuperAdmin dashboard still
// renders the org overview table through this `Tenant` shape during the
// transition release. Internally it forwards to `/super-admin/orgs?with_counts=true`.
//
// New code SHOULD use `superadminApi.listOrgs()` / `getOrg()` /
// `getOrgUsage()` / `updateOrg()` directly. This file goes away once
// the SuperAdmin page is reworked to the org shape natively.
import client from './client'

export interface Tenant {
  id: number
  name: string
  slug: string
  description?: string
  is_active: boolean
  plan_tier: string
  max_devices: number
  max_users: number
  contact_email?: string | null
  created_at: string
  device_count: number
  user_count: number
  location_count: number
}

interface _OrgRow {
  id: number
  name: string
  slug: string
  description: string | null
  is_active: boolean
  contact_email: string | null
  created_at: string
  status: string
  quota: {
    max_devices: number | null
    max_users: number | null
  }
  device_count: number
  user_count: number
  location_count: number
  plan_tier: string
}

function _orgToTenant(o: _OrgRow): Tenant {
  return {
    id: o.id,
    name: o.name,
    slug: o.slug,
    description: o.description ?? undefined,
    // `is_active` on the legacy Tenant maps to "lifecycle status === active"
    // (Phase H). Older orgs still rely on the boolean column.
    is_active: o.status === 'active' && o.is_active !== false,
    plan_tier: o.plan_tier ?? 'free',
    max_devices: o.quota?.max_devices ?? 0,
    max_users: o.quota?.max_users ?? 0,
    contact_email: o.contact_email,
    created_at: o.created_at,
    device_count: o.device_count ?? 0,
    user_count: o.user_count ?? 0,
    location_count: o.location_count ?? 0,
  }
}

export const tenantsApi = {
  list: async (): Promise<Tenant[]> => {
    const res = await client.get<{ total: number; orgs: _OrgRow[] }>(
      '/super-admin/orgs',
      { params: { with_counts: true, per_page: 500 } },
    )
    return (res.data.orgs ?? []).map(_orgToTenant)
  },
}
