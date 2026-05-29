/**
 * T10 C7.A backend endpoint client (minimal — C7.B'de yalnız list/count gerekli;
 * bulk/PATCH/DELETE C7.C'de Ports sekmesinden kullanılacak).
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

export const portPolicyAssignmentsApi = {
  /** Cihazın aktif (deleted_at IS NULL) port → policy override haritası. */
  list: (deviceId: number) =>
    client.get<PortPolicyAssignment[]>(`/devices/${deviceId}/port-policy-assignments`)
      .then((r) => r.data),
}
