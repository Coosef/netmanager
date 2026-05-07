import client from './client'

export interface DriverTemplate {
  id: number
  os_type: string
  os_version_pattern: string | null
  command_type: string
  command_string: string
  parser_type: 'regex' | 'textfsm' | 'raw'
  parser_template: string | null
  sample_output: string | null
  is_verified: boolean
  is_active: boolean
  priority: number
  success_count: number
  failure_count: number
  last_success_at: string | null
  last_failure_at: string | null
  success_rate: number | null
  health_status: 'healthy' | 'warning' | 'broken' | 'unknown'
  notes: string | null
  created_by: number | null
  created_at: string
  updated_at: string
}

export interface DriverTemplatePayload {
  os_type: string
  os_version_pattern?: string | null
  command_type: string
  command_string: string
  parser_type: 'regex' | 'textfsm' | 'raw'
  parser_template?: string | null
  sample_output?: string | null
  is_verified?: boolean
  is_active?: boolean
  priority?: number
  notes?: string | null
}

export interface TemplateHealthSummary {
  template_id: number
  os_type: string
  command_type: string
  health_status: 'healthy' | 'warning' | 'broken' | 'unknown'
  success_rate: number | null
  success_count: number
  failure_count: number
  last_failure_at: string | null
  notes: string | null
}

export interface CommandExecution {
  id: number
  device_id: number
  template_id: number | null
  os_type: string
  command_type: string
  command_string: string
  parse_success: boolean
  validation_success: boolean
  error_message: string | null
  execution_time_ms: number | null
  firmware_version: string | null
  raw_output: string | null
  created_at: string
}

export interface AISuggestRequest {
  os_type: string
  command_type: string
  raw_output: string
  firmware_version?: string
}

export interface AISuggestResponse {
  command_string: string
  parser_type: string
  parser_template: string | null
  parsed_result: unknown
  explanation: string
}

export interface TestParseResponse {
  success: boolean
  parsed_result: unknown
  error?: string
}

export const driverTemplatesApi = {
  list: (params?: { os_type?: string; command_type?: string }) =>
    client.get<DriverTemplate[]>('/driver-templates/', { params }).then((r) => r.data),

  create: (data: DriverTemplatePayload) =>
    client.post<DriverTemplate>('/driver-templates/', data).then((r) => r.data),

  update: (id: number, data: Partial<DriverTemplatePayload>) =>
    client.put<DriverTemplate>(`/driver-templates/${id}`, data).then((r) => r.data),

  delete: (id: number) =>
    client.delete(`/driver-templates/${id}`),

  aiSuggest: (data: AISuggestRequest) =>
    client.post<AISuggestResponse>('/driver-templates/ai-suggest', data).then((r) => r.data),

  testParse: (data: { parser_type: string; parser_template: string | null; raw_output: string }) =>
    client.post<TestParseResponse>('/driver-templates/test-parse', data).then((r) => r.data),

  probeDevice: (deviceId: number) =>
    client.post<{ task_id: number; status: string }>(`/driver-templates/probe-device/${deviceId}`).then((r) => r.data),

  getHealth: () =>
    client.get<TemplateHealthSummary[]>('/driver-templates/health').then((r) => r.data),

  getExecutions: (params?: { device_id?: number; command_type?: string; parse_success?: boolean; limit?: number }) =>
    client.get<CommandExecution[]>('/driver-templates/executions', { params }).then((r) => r.data),
}

export interface ProbeDeviceResponse {
  device_id: number
  detected_vendor: string | null
  detected_model: string | null
  detected_firmware: string | null
  detected_os_type: string | null
  templates_created: number
  templates_skipped: number
  firmware_changed: boolean
  details: Array<{
    command_type: string
    status: 'created' | 'skipped' | 'error'
    reason?: string
    command_string?: string
    parser_type?: string
  }>
}

export const OS_TYPE_OPTIONS = [
  { value: 'cisco_ios',      label: 'Cisco IOS / IOS-XE' },
  { value: 'cisco_nxos',     label: 'Cisco NX-OS' },
  { value: 'cisco_sg300',    label: 'Cisco SG300' },
  { value: 'ruijie_os',      label: 'Ruijie RGOS' },
  { value: 'aruba_osswitch', label: 'Aruba OS-Switch / ProCurve' },
  { value: 'aruba_aoscx',    label: 'Aruba AOS-CX' },
  { value: 'hp_procurve',    label: 'HP ProCurve' },
  { value: 'h3c_comware',    label: 'H3C Comware' },
  { value: 'fortios',        label: 'Fortinet FortiOS' },
  { value: 'junos',          label: 'Juniper JunOS' },
  { value: 'mikrotik_routeros', label: 'MikroTik RouterOS' },
]

export const COMMAND_TYPE_OPTIONS = [
  { value: 'show_version',       label: 'show version' },
  { value: 'show_interfaces',    label: 'show interfaces' },
  { value: 'show_vlan',          label: 'show vlan' },
  { value: 'show_lldp',          label: 'show lldp' },
  { value: 'show_cdp',           label: 'show cdp' },
  { value: 'show_mac_table',     label: 'show mac address-table' },
  { value: 'show_arp',           label: 'show arp' },
  { value: 'show_running_config','label': 'show running-config' },
  { value: 'show_power_inline',  label: 'show power inline' },
  { value: 'show_switchport',    label: 'show interfaces switchport' },
]
