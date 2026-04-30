import client from './client'
import type { Device, DeviceGroup, PaginatedResponse, ConfigBackup, NetworkInterface, Vlan } from '@/types'

interface DeviceListParams {
  skip?: number
  limit?: number
  search?: string
  vendor?: string
  status?: string
  device_type?: string
  group_id?: number
  tag?: string
  site?: string
}

export const devicesApi = {
  list: (params?: DeviceListParams) =>
    client.get<PaginatedResponse<Device>>('/devices/', { params }).then((r) => r.data),

  get: (id: number) =>
    client.get<Device>(`/devices/${id}`).then((r) => r.data),

  create: (data: Record<string, unknown>) =>
    client.post<Device>('/devices/', data).then((r) => r.data),

  update: (id: number, data: Record<string, unknown>) =>
    client.patch<Device>(`/devices/${id}`, data).then((r) => r.data),

  delete: (id: number) =>
    client.delete(`/devices/${id}`),

  testConnection: (id: number) =>
    client.post<{ device_id: number; hostname: string; success: boolean; message: string; latency_ms?: number }>(
      `/devices/${id}/test`
    ).then((r) => r.data),

  getConfig: (id: number) =>
    client.get<{ success: boolean; config: string; error?: string }>(`/devices/${id}/config`).then((r) => r.data),

  getBackups: (id: number) =>
    client.get<ConfigBackup[]>(`/devices/${id}/backups`).then((r) => r.data),

  getBackupContent: (deviceId: number, backupId: number) =>
    client.get<{ config: string; hash: string; created_at: string }>(
      `/devices/${deviceId}/backups/${backupId}/content`
    ).then((r) => r.data),

  fetchInfo: (id: number) =>
    client.post<Device>(`/devices/${id}/fetch-info`).then((r) => r.data),

  getInterfaces: (id: number) =>
    client.get<{ success: boolean; interfaces: NetworkInterface[]; error?: string; raw?: string }>(
      `/devices/${id}/interfaces`
    ).then((r) => r.data),

  toggleInterface: (id: number, ifaceName: string, action: 'shutdown' | 'no-shutdown') =>
    client.post<{ success: boolean; error?: string; output?: string }>(
      `/devices/${id}/interfaces/${encodeURIComponent(ifaceName)}/toggle`,
      { action }
    ).then((r) => r.data),

  getVlans: (id: number) =>
    client.get<{ success: boolean; vlans: Vlan[]; error?: string; raw?: string }>(
      `/devices/${id}/vlans`
    ).then((r) => r.data),

  createVlan: (id: number, vlan_id: number, name: string) =>
    client.post<{ success: boolean; error?: string }>(
      `/devices/${id}/vlans`, { vlan_id, name }
    ).then((r) => r.data),

  deleteVlan: (id: number, vlan_id: number) =>
    client.delete<{ success: boolean; error?: string }>(
      `/devices/${id}/vlans/${vlan_id}`
    ).then((r) => r.data),

  assignVlan: (id: number, ifaceName: string, vlan_id: number | number[], mode: 'access' | 'trunk', native_vlan_id?: number) =>
    client.post<{ success: boolean; error?: string }>(
      `/devices/${id}/interfaces/${encodeURIComponent(ifaceName)}/vlan`,
      { vlan_id, mode, ...(native_vlan_id ? { native_vlan_id } : {}) }
    ).then((r) => r.data),

  runCommand: (id: number, command: string, confirm = false) =>
    client.post<{
      success?: boolean; output?: string; error?: string
      needs_confirm?: boolean; warning?: string; command?: string
    }>(`/devices/${id}/run-command`, { command, confirm }).then((r) => r.data),

  setReadonly: (id: number, is_readonly: boolean) =>
    client.patch<import('@/types').Device>(`/devices/${id}`, { is_readonly }).then((r) => r.data),

  takeBackup: (id: number) =>
    client.post<ConfigBackup>(`/devices/${id}/backups/take`).then((r) => r.data),

  listGroups: () =>
    client.get<DeviceGroup[]>('/devices/groups').then((r) => r.data),

  getLocationOptions: () =>
    client.get<{
      sites: string[]
      buildings: { site: string; name: string }[]
      floors: { site: string; building: string; name: string }[]
    }>('/devices/location-options').then((r) => r.data),

  createGroup: (data: { name: string; description?: string; parent_id?: number }) =>
    client.post<DeviceGroup>('/devices/groups', data).then((r) => r.data),

  bulkUpdateCredentials: (data: {
    device_ids: number[]
    source_device_id?: number
    ssh_username?: string
    ssh_password?: string
    enable_secret?: string
  }) =>
    client.post<{ updated: number; device_ids: number[] }>('/devices/bulk-update-credentials', data).then((r) => r.data),

  bulkDelete: (device_ids: number[]) =>
    client.post<{ deleted: number }>('/devices/bulk-delete', { device_ids }).then((r) => r.data),

  bulkBackup: (device_ids: number[]) =>
    client.post<{ task_id: number; device_count: number; status: string }>(
      '/devices/bulk-backup', { device_ids }
    ).then((r) => r.data),

  bulkFetchInfo: (device_ids: number[]) =>
    client.post<{ succeeded: number; failed: number; results: { device_id: number; hostname: string; success: boolean; error?: string; updates?: Record<string, string> }[] }>(
      '/devices/bulk-fetch-info', { device_ids }
    ).then((r) => r.data),

  bulkUpdateAgent: (device_ids: number[], agent_id: string | null) =>
    client.post<{ updated: number; agent_id: string | null }>(
      '/devices/bulk-update-agent', { device_ids, agent_id }
    ).then((r) => r.data),

  downloadBackupUrl: (deviceId: number, backupId: number) =>
    `/api/v1/devices/${deviceId}/backups/${backupId}/download`,

  setGoldenBackup: (deviceId: number, backupId: number) =>
    client.post<{ success: boolean; backup_id: number; message: string }>(
      `/devices/${deviceId}/backups/${backupId}/set-golden`
    ).then((r) => r.data),

  getConfigDrift: (deviceId: number) =>
    client.get<{
      has_golden: boolean
      drift_detected: boolean
      golden_id?: number
      golden_created_at?: string
      latest_id?: number
      latest_created_at?: string
      lines_added?: number
      lines_removed?: number
      diff?: string
      message?: string
    }>(`/devices/${deviceId}/backups/drift`).then((r) => r.data),

  getConfigDiff: (deviceId: number, fromId: number, toId: number) =>
    client.get<{
      from_backup: { id: number; created_at: string; hash: string }
      to_backup: { id: number; created_at: string; hash: string }
      has_changes: boolean
      added: number
      removed: number
      diff: string
    }>(`/devices/${deviceId}/backups/diff`, { params: { from_id: fromId, to_id: toId } }).then((r) => r.data),

  checkConfigPolicy: (deviceId: number) =>
    client.post<{
      device_id: number
      hostname: string
      policy_score: number
      violations: { rule_id: string; severity: string; description: string }[]
      violation_count: number
      critical_count: number
    }>(`/devices/${deviceId}/config/check-policy`).then((r) => r.data),

  getNeighbors: (id: number) =>
    client.get<{
      items: {
        id: number
        local_port: string
        neighbor_hostname: string
        neighbor_ip?: string
        neighbor_port: string
        neighbor_platform?: string
        neighbor_device_id?: number
        neighbor_type?: string
        protocol: string
        last_seen: string
      }[]
    }>(`/devices/${id}/neighbors`).then((r) => r.data),

  getEvents: (id: number, params?: { skip?: number; limit?: number }) =>
    client.get<{
      items: {
        id: number
        event_type: string
        severity: string
        title: string
        message?: string
        acknowledged: boolean
        created_at: string
      }[]
    }>(`/devices/${id}/events`, { params }).then((r) => r.data),

  getActivity: (id: number, params?: { skip?: number; limit?: number }) =>
    client.get<{
      items: {
        id: number
        username: string
        action: string
        status: string
        details?: Record<string, unknown>
        client_ip?: string
        created_at: string
      }[]
    }>(`/devices/${id}/activity`, { params }).then((r) => r.data),

  getImportTemplate: () =>
    `/api/v1/devices/import-template`,

  importCsv: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return client.post<{
      created: number
      updated: number
      total_rows: number
      errors: { row: number; ip?: string; error: string }[]
    }>('/devices/import-csv', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then((r) => r.data)
  },

  getGroupSuggestions: () =>
    client.get<{ suggestions: GroupSuggestion[]; total: number }>('/devices/group-suggestions').then((r) => r.data),

  applyGroupSuggestions: (suggestions: { name: string; description?: string; device_ids: number[] }[]) =>
    client.post<{ created: { id: number; name: string; device_count: number }[]; total: number }>(
      '/devices/apply-group-suggestions', { suggestions }
    ).then((r) => r.data),

  assignGroupCredentialProfile: (groupId: number, credentialProfileId: number | null) =>
    client.post<{ updated: number; group_name: string; profile_name: string | null }>(
      `/devices/groups/${groupId}/assign-credential-profile`,
      { credential_profile_id: credentialProfileId }
    ).then((r) => r.data),

  configureSnmp: (deviceId: number, payload: {
    snmp_version: 'v2c' | 'v3'
    snmp_community?: string
    snmp_port?: number
    snmp_v3_username?: string
    snmp_v3_auth_protocol?: string
    snmp_v3_auth_passphrase?: string
    snmp_v3_priv_protocol?: string
    snmp_v3_priv_passphrase?: string
    skip_ssh?: boolean
  }) =>
    client.post<{ success: boolean; commands_applied: string[] }>(
      `/devices/${deviceId}/configure-snmp`, payload
    ).then((r) => r.data),
}

export interface GroupSuggestion {
  suggestion_type: 'site_based' | 'layer_based' | 'topology_cluster'
  suggested_name: string
  description: string
  device_ids: number[]
  device_count: number
  device_names: string[]
}
