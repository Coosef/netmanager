import client from './client'

export interface Service {
  id: number
  name: string
  description?: string | null
  priority: 'critical' | 'high' | 'medium' | 'low'
  business_owner?: string | null
  device_ids: number[]
  vlan_ids: number[]
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface ServiceImpact {
  service_id: number
  service_name: string
  priority: string
  device_ids: number[]
  affected_devices: { id: number; hostname: string; ip_address: string; status: string }[]
  healthy_devices: { id: number; hostname: string; ip_address: string; status: string }[]
  affected_count: number
  healthy_count: number
  impact_level: 'none' | 'low' | 'medium' | 'high' | 'critical'
  impact_pct: number
  vlan_ids: number[]
}

export interface AffectedService {
  service_id: number
  service_name: string
  priority: string
  impact_level: 'low' | 'medium' | 'high' | 'critical'
  impact_pct: number
  offline_device_count: number
  total_device_count: number
}

export interface FleetImpactSummary {
  affected_services: AffectedService[]
  total_services: number
  critical_count: number
}

export const servicesApi = {
  list: () =>
    client.get<{ total: number; items: Service[] }>('/services').then(r => r.data),

  get: (id: number) =>
    client.get<Service>(`/services/${id}`).then(r => r.data),

  create: (data: {
    name: string
    description?: string
    priority?: string
    business_owner?: string
    device_ids?: number[]
    vlan_ids?: number[]
  }) => client.post<Service>('/services', data).then(r => r.data),

  update: (id: number, data: Partial<{
    name: string
    description: string
    priority: string
    business_owner: string
    device_ids: number[]
    vlan_ids: number[]
    is_active: boolean
  }>) => client.patch<Service>(`/services/${id}`, data).then(r => r.data),

  delete: (id: number) => client.delete(`/services/${id}`),

  getImpact: (id: number) =>
    client.get<ServiceImpact>(`/services/${id}/impact`).then(r => r.data),

  getFleetImpact: () =>
    client.get<FleetImpactSummary>('/services/fleet/impact-summary').then(r => r.data),
}
