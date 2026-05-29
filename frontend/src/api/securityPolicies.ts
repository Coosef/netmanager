// T10 Faz C C6 — Security Policy CRUD API (switch + port).
// Backend: /api/v1/security-policies (require_feature("security_policy") gate'li → kapalı org 403).
// NULL alan = "kontrol kapalı"; form boş bırakınca backend'e null gider (0 DEĞİL).
import client from './client'

// Eşik/severity alanlarının çoğu nullable (NULL semantic). id/name/is_default tipli;
// gerisi alan-şemasıyla (FIELD_GROUPS) yönetilir.
export interface SwitchPolicy {
  id: number
  organization_id: number
  name: string
  description: string | null
  is_default: boolean
  [field: string]: number | string | boolean | null
}
export interface PortPolicy {
  id: number
  organization_id: number
  name: string
  description: string | null
  is_default: boolean
  [field: string]: number | string | boolean | null
}

export type PolicyKind = 'switch' | 'port'

const base = (kind: PolicyKind) => `/security-policies/${kind}`

export const securityPoliciesApi = {
  list: (kind: PolicyKind) =>
    client.get<Record<string, any>[]>(base(kind)).then((r) => r.data),
  get: (kind: PolicyKind, id: number) =>
    client.get<Record<string, any>>(`${base(kind)}/${id}`).then((r) => r.data),
  create: (kind: PolicyKind, body: Record<string, any>) =>
    client.post<Record<string, any>>(base(kind), body).then((r) => r.data),
  update: (kind: PolicyKind, id: number, body: Record<string, any>) =>
    client.put<Record<string, any>>(`${base(kind)}/${id}`, body).then((r) => r.data),
  remove: (kind: PolicyKind, id: number) =>
    client.delete(`${base(kind)}/${id}`).then((r) => r.data),
  setDefault: (kind: PolicyKind, id: number) =>
    client.post(`${base(kind)}/${id}/set-default`).then((r) => r.data),
}

// ── Alan şeması (form + tablo üretimi) ───────────────────────────────────────
export type FieldType = 'int' | 'pct' | 'severity' | 'bool' | 'text' | 'config_change'

export interface FieldDef {
  key: string
  label: string
  type: FieldType
  group: string
  hint?: string
}

export const SEVERITY_OPTIONS = ['info', 'warning', 'critical']
export const CONFIG_CHANGE_OPTIONS = ['info', 'require_ack', 'auto_ack']

export const SWITCH_FIELDS: FieldDef[] = [
  // Sağlık eşikleri
  { key: 'cpu_warning', label: 'CPU uyarı %', type: 'pct', group: 'Sağlık Eşikleri' },
  { key: 'cpu_critical', label: 'CPU kritik %', type: 'pct', group: 'Sağlık Eşikleri' },
  { key: 'memory_warning', label: 'Bellek uyarı %', type: 'pct', group: 'Sağlık Eşikleri' },
  { key: 'memory_critical', label: 'Bellek kritik %', type: 'pct', group: 'Sağlık Eşikleri' },
  { key: 'temp_warning', label: 'Sıcaklık uyarı °C', type: 'int', group: 'Sağlık Eşikleri', hint: 'Veri kaynağı v2 (şimdilik ölçülmüyor)' },
  { key: 'temp_critical', label: 'Sıcaklık kritik °C', type: 'int', group: 'Sağlık Eşikleri', hint: 'Veri kaynağı v2' },
  // Davranış / Snapshot
  { key: 'offline_timeout_min', label: 'Offline timeout (dk)', type: 'int', group: 'Davranış / Snapshot' },
  { key: 'alert_suppression_window_min', label: 'Alarm bastırma penceresi (dk)', type: 'int', group: 'Davranış / Snapshot' },
  { key: 'snapshot_interval_min', label: 'Snapshot aralığı (dk)', type: 'int', group: 'Davranış / Snapshot' },
  { key: 'snapshot_retention_days', label: 'Snapshot saklama (gün)', type: 'int', group: 'Davranış / Snapshot' },
  // Login severity
  { key: 'console_login_severity', label: 'Console login', type: 'severity', group: 'Login / Erişim' },
  { key: 'ssh_login_severity', label: 'SSH login', type: 'severity', group: 'Login / Erişim' },
  { key: 'web_login_severity', label: 'Web login', type: 'severity', group: 'Login / Erişim' },
  { key: 'telnet_login_severity', label: 'Telnet login', type: 'severity', group: 'Login / Erişim' },
  { key: 'auth_failure_threshold', label: 'Auth fail eşiği', type: 'int', group: 'Login / Erişim' },
  { key: 'allowed_management_source_ips', label: 'İzinli mgmt IP (CSV/CIDR)', type: 'text', group: 'Login / Erişim' },
  { key: 'business_hours_window', label: 'İş saatleri (09-18)', type: 'text', group: 'Login / Erişim' },
  // L2 trap severity (v2'de tüketilir)
  { key: 'bpdu_guard_severity', label: 'BPDU guard', type: 'severity', group: 'L2 Trap Severity (v2)' },
  { key: 'loop_detected_severity', label: 'Loop detected', type: 'severity', group: 'L2 Trap Severity (v2)' },
  { key: 'dhcp_snooping_severity', label: 'DHCP snooping', type: 'severity', group: 'L2 Trap Severity (v2)' },
  { key: 'arp_inspection_severity', label: 'ARP inspection', type: 'severity', group: 'L2 Trap Severity (v2)' },
  { key: 'port_security_severity', label: 'Port security', type: 'severity', group: 'L2 Trap Severity (v2)' },
  { key: 'dot1x_severity', label: '802.1x', type: 'severity', group: 'L2 Trap Severity (v2)' },
  { key: 'storm_control_severity', label: 'Storm control', type: 'severity', group: 'L2 Trap Severity (v2)' },
  // PoE
  { key: 'poe_budget_warning_pct', label: 'PoE budget uyarı %', type: 'pct', group: 'PoE Budget', hint: 'Switch toplam bütçesi v2 (şimdilik payda yok)' },
  { key: 'poe_budget_critical_pct', label: 'PoE budget kritik %', type: 'pct', group: 'PoE Budget', hint: 'v2' },
  // Operasyonel
  { key: 'ntp_drift_warning_sec', label: 'NTP drift uyarı (sn)', type: 'int', group: 'Operasyonel' },
  { key: 'ntp_drift_critical_sec', label: 'NTP drift kritik (sn)', type: 'int', group: 'Operasyonel' },
  { key: 'config_backup_max_age_days', label: 'Config backup max yaş (gün)', type: 'int', group: 'Operasyonel' },
  { key: 'config_change_policy', label: 'Config değişiklik politikası', type: 'config_change', group: 'Operasyonel' },
]

export const PORT_FIELDS: FieldDef[] = [
  { key: 'mac_flood_warning', label: 'MAC flood uyarı', type: 'int', group: 'MAC Flood' },
  { key: 'mac_flood_critical', label: 'MAC flood kritik', type: 'int', group: 'MAC Flood' },
  { key: 'mac_flap_window_min', label: 'Flap penceresi (dk)', type: 'int', group: 'MAC Flap' },
  { key: 'mac_flap_min_transitions', label: 'Flap min geçiş', type: 'int', group: 'MAC Flap' },
  { key: 'mac_flap_min_quiet_min', label: 'Flap sessizlik (dk)', type: 'int', group: 'MAC Flap' },
  { key: 'auto_quarantine_on_nth_flap', label: 'N. flapta karantina (ÖNERİ — shutdown YOK)', type: 'int', group: 'MAC Flap', hint: 'v1: yalnız dry-run öneri; gerçek shutdown C5 sonrası kill-switch ile' },
  { key: 'vlan_change_alert_enabled', label: 'VLAN değişim alarmı', type: 'bool', group: 'VLAN' },
  { key: 'allowed_vlans', label: 'İzinli VLAN (CSV)', type: 'text', group: 'VLAN' },
  { key: 'new_mac_alert_enabled', label: 'Yeni MAC alarmı', type: 'bool', group: 'Link / MAC' },
  { key: 'link_up_alert_enabled', label: 'Link-up alarmı', type: 'bool', group: 'Link / MAC' },
  { key: 'bandwidth_alert_pct', label: 'Bant genişliği uyarı %', type: 'pct', group: 'Bant Genişliği' },
  { key: 'if_error_rate_ppm_warning', label: 'Error rate uyarı (PPM)', type: 'int', group: 'Counter (PPM)' },
  { key: 'if_error_rate_ppm_critical', label: 'Error rate kritik (PPM)', type: 'int', group: 'Counter (PPM)' },
  { key: 'if_discard_rate_ppm_warning', label: 'Discard rate uyarı (PPM)', type: 'int', group: 'Counter (PPM)' },
  { key: 'if_discard_rate_ppm_critical', label: 'Discard rate kritik (PPM)', type: 'int', group: 'Counter (PPM)' },
  { key: 'optic_rx_warning_dbm', label: 'Optic RX uyarı (dBm)', type: 'int', group: 'Optic DOM (v2)', hint: 'v2' },
  { key: 'optic_rx_critical_dbm', label: 'Optic RX kritik (dBm)', type: 'int', group: 'Optic DOM (v2)', hint: 'v2' },
  { key: 'optic_temp_warning_c', label: 'Optic sıcaklık uyarı °C', type: 'int', group: 'Optic DOM (v2)', hint: 'v2' },
  { key: 'optic_temp_critical_c', label: 'Optic sıcaklık kritik °C', type: 'int', group: 'Optic DOM (v2)', hint: 'v2' },
]
