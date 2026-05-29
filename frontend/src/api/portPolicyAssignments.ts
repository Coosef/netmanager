/**
 * T10 C7.A backend endpoint client.
 *
 * v1 not: hard delete (deleted_at altyapı için ileride). port_name exact-match
 * (vendor format'ı aynen; alias normalization v2.1).
 */
import client from './client'

export interface PortPolicyAssignment {
  id: number
  device_id: number
  port_name: string
  port_security_policy_id: number
  organization_id: number
  assigned_by?: number | null
  created_at?: string | null
  updated_at?: string | null
}

export interface BulkAssignItem {
  port_name: string
  port_security_policy_id: number
}

export const portPolicyAssignmentsApi = {
  /** Cihazın aktif (deleted_at IS NULL) port → policy override haritası. */
  list: (deviceId: number) =>
    client.get<PortPolicyAssignment[]>(`/devices/${deviceId}/port-policy-assignments`)
      .then((r) => r.data),

  /** Toplu upsert. Backend atomik validate-then-write (tek bir hata → hiçbiri yazılmaz). */
  bulkSet: (deviceId: number, items: BulkAssignItem[]) =>
    client.post<PortPolicyAssignment[]>(`/devices/${deviceId}/port-policy-assignments`, items)
      .then((r) => r.data),

  /** Tek port'un override'ını kaldır (hard delete). Yoksa 404 → caller yutar. */
  remove: (deviceId: number, portName: string) =>
    client.delete(
      `/devices/${deviceId}/port-policy-assignments/${encodeURIComponent(portName)}`
    ).then((r) => r.data),
}
