export interface Tenant {
  id: number
  name: string
  slug: string
  description?: string
  is_active: boolean
  created_at: string
  device_count: number
  user_count: number
}

export type UserRole =
  | 'super_admin'
  | 'admin'
  | 'org_viewer'
  | 'location_manager'
  | 'location_operator'
  | 'location_viewer'
  | 'operator'
  | 'viewer'

export type SystemRole = 'super_admin' | 'org_admin' | 'member'

export interface UserLocationItem {
  location_id: number
  location_name: string
  loc_role: string
}

export interface ModulePermissions {
  view?: boolean
  edit?: boolean
  delete?: boolean
  create?: boolean
  ssh?: boolean
  run?: boolean
  cancel?: boolean
  invite?: boolean
}

export interface Permissions {
  modules: {
    devices?: ModulePermissions
    config_backups?: ModulePermissions
    tasks?: ModulePermissions
    playbooks?: ModulePermissions
    topology?: ModulePermissions
    monitoring?: ModulePermissions
    ipam?: ModulePermissions
    audit_logs?: ModulePermissions
    reports?: ModulePermissions
    users?: ModulePermissions
    locations?: ModulePermissions
    settings?: ModulePermissions
    agents?: ModulePermissions
    driver_templates?: ModulePermissions
    [key: string]: ModulePermissions | undefined
  }
}

export interface User {
  id: number
  username: string
  email: string
  full_name?: string
  role: UserRole           // legacy
  system_role: SystemRole  // new RBAC
  is_active: boolean
  notes?: string
  tenant_id?: number | null   // legacy
  org_id?: number | null      // new RBAC
  tenant_name?: string | null
  last_login?: string
  created_at: string
  locations?: UserLocationItem[]
}

export interface TokenResponse {
  access_token: string
  token_type: string
  user_id: number
  username: string
  role: UserRole
  system_role: SystemRole
  tenant_id?: number | null
  org_id?: number | null
  permissions?: Permissions
}

export interface Organization {
  id: number
  name: string
  slug: string
  description?: string
  is_active: boolean
  contact_email?: string
  plan_id?: number | null
  schema_name?: string
  trial_ends_at?: string | null
  subscription_ends_at?: string | null
  created_at: string
}

export interface Plan {
  id: number
  name: string
  slug: string
  description?: string
  is_active: boolean
  max_devices: number
  max_users: number
  max_locations: number
  max_agents: number
  features?: Record<string, boolean>
  price_monthly?: number | null
  price_yearly?: number | null
}

export interface PermissionSet {
  id: number
  name: string
  description?: string
  org_id?: number | null
  is_default: boolean
  cloned_from_id?: number | null
  permissions: Permissions
  created_at: string
  updated_at: string
}

export interface Device {
  id: number
  hostname: string
  ip_address: string
  device_type: string
  vendor: string
  os_type: string
  model?: string
  serial_number?: string
  firmware_version?: string
  location?: string
  description?: string
  tags?: string
  alias?: string
  layer?: string
  site?: string
  building?: string
  floor?: string
  ssh_username: string
  ssh_port: number
  agent_id?: string | null
  status: 'online' | 'offline' | 'unknown' | 'unreachable'
  last_seen?: string
  last_backup?: string
  is_active: boolean
  is_readonly: boolean
  approval_required: boolean
  snmp_enabled: boolean
  snmp_community_set?: boolean
  snmp_version: string
  snmp_port: number
  snmp_v3_username?: string | null
  snmp_v3_auth_protocol?: string | null
  snmp_v3_priv_protocol?: string | null
  group_id?: number
  created_at: string
  updated_at: string
}

export interface DeviceGroup {
  id: number
  name: string
  description?: string
  parent_id?: number
  created_at: string
}

export interface Task {
  id: number
  celery_task_id?: string
  name: string
  type: string
  status: 'pending' | 'running' | 'success' | 'partial' | 'failed' | 'cancelled'
  device_ids?: number[]
  parameters?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: string
  total_devices: number
  completed_devices: number
  failed_devices: number
  created_by: number
  created_at: string
  started_at?: string
  completed_at?: string
}

export interface AuditLog {
  id: number
  user_id?: number
  username: string
  user_role?: string
  action: string
  resource_type?: string
  resource_id?: string
  resource_name?: string
  details?: Record<string, unknown>
  client_ip?: string
  user_agent?: string
  status: string
  created_at: string
  request_id?: string
  duration_ms?: number | null
  before_state?: Record<string, unknown> | null
  after_state?: Record<string, unknown> | null
}

export interface ConfigBackup {
  id: number
  device_id: number
  config_hash: string
  size_bytes: number
  notes?: string
  created_by?: number
  created_at: string
}

export interface NetworkInterface {
  name: string
  description: string
  status: string
  vlan: string
  duplex: string
  speed: string
}

export interface Vlan {
  id: number
  name: string
  status: string
  ports: string[]
}

export interface PaginatedResponse<T> {
  total: number
  items: T[]
  skip?: number
  limit?: number
}


export const DEVICE_TYPE_OPTIONS = [
  { label: 'Switch', value: 'switch' },
  { label: 'Router', value: 'router' },
  { label: 'Firewall', value: 'firewall' },
  { label: 'Access Point (AP)', value: 'ap' },
  { label: 'UPS', value: 'ups' },
  { label: 'Server', value: 'server' },
  { label: 'Diğer', value: 'other' },
]

export const VENDOR_OPTIONS = [
  { label: 'Cisco', value: 'cisco' },
  { label: 'Aruba', value: 'aruba' },
  { label: 'Ruijie', value: 'ruijie' },
  { label: 'Fortinet', value: 'fortinet' },
  { label: 'Palo Alto', value: 'paloalto' },
  { label: 'MikroTik', value: 'mikrotik' },
  { label: 'Juniper', value: 'juniper' },
  { label: 'Ubiquiti', value: 'ubiquiti' },
  { label: 'H3C / HPE', value: 'h3c' },
  { label: 'APC', value: 'apc' },
  { label: 'Diğer', value: 'other' },
]

export const OS_TYPE_OPTIONS = [
  { label: 'Cisco IOS', value: 'cisco_ios' },
  { label: 'Cisco NX-OS', value: 'cisco_nxos' },
  { label: 'Cisco SG300', value: 'cisco_sg300' },
  { label: 'Aruba OS-Switch', value: 'aruba_osswitch' },
  { label: 'Aruba AOS-CX', value: 'aruba_aoscx' },
  { label: 'HP ProCurve', value: 'hp_procurve' },
  { label: 'Ruijie OS', value: 'ruijie_os' },
  { label: 'Fortinet FortiOS', value: 'fortios' },
  { label: 'Palo Alto PAN-OS', value: 'panos' },
  { label: 'MikroTik RouterOS', value: 'mikrotik_routeros' },
  { label: 'Juniper JunOS', value: 'junos' },
  { label: 'H3C Comware', value: 'h3c_comware' },
  { label: 'Generic SNMP', value: 'generic_snmp' },
  { label: 'Generic', value: 'generic' },
]

export const VENDOR_OS_MAP: Record<string, string[]> = {
  cisco:     ['cisco_ios', 'cisco_nxos', 'cisco_sg300', 'generic'],
  aruba:     ['aruba_osswitch', 'aruba_aoscx', 'hp_procurve', 'generic'],
  ruijie:    ['ruijie_os', 'generic'],
  fortinet:  ['fortios', 'generic'],
  paloalto:  ['panos', 'generic'],
  mikrotik:  ['mikrotik_routeros', 'generic'],
  juniper:   ['junos', 'generic'],
  ubiquiti:  ['generic'],
  h3c:       ['h3c_comware', 'generic'],
  apc:       ['generic_snmp', 'generic'],
  other:     OS_TYPE_OPTIONS.map((o) => o.value),
}

export const ROLE_OPTIONS = [
  { label: 'Super Admin', value: 'super_admin' },
  { label: 'Admin (Org Yönetici)', value: 'admin' },
  { label: 'Org Viewer (Tüm Lok. Okuma)', value: 'org_viewer' },
  { label: 'Lokasyon Yönetici', value: 'location_manager' },
  { label: 'Lokasyon Operatör', value: 'location_operator' },
  { label: 'Lokasyon Görüntüleyici', value: 'location_viewer' },
  { label: 'Operator', value: 'operator' },
  { label: 'Viewer', value: 'viewer' },
]

export const LOC_ROLE_OPTIONS = [
  { label: 'Lokasyon Yönetici', value: 'location_manager' },
  { label: 'Lokasyon Operatör', value: 'location_operator' },
  { label: 'Lokasyon Görüntüleyici', value: 'location_viewer' },
]

export const TASK_TYPE_OPTIONS = [
  { label: 'Toplu Komut', value: 'bulk_command' },
  { label: 'Config Yedekleme', value: 'backup_config' },
  { label: 'Toplu Şifre Değiştirme', value: 'bulk_password_change' },
  { label: 'Anomali Tarama', value: 'monitor_poll' },
]
