import { memo, type CSSProperties } from 'react'
import { Handle, Position } from '@xyflow/react'
import { Tooltip } from 'antd'
import { useTheme } from '@/contexts/ThemeContext'

const LAYER_COLORS: Record<string, string> = {
  core: '#ef4444',
  distribution: '#f97316',
  access: '#3b82f6',
  edge: '#22c55e',
  wireless: '#a855f7',
}

const LAYER_LABELS: Record<string, string> = {
  core: 'CORE',
  distribution: 'DIST',
  access: 'ACCESS',
  edge: 'EDGE',
  wireless: 'WIFI',
}

const VENDOR_COLORS: Record<string, string> = {
  cisco: '#1d6fa4',
  aruba: '#ff8300',
  ruijie: '#e4002b',
  other: '#8c8c8c',
}

const STATUS_COLORS: Record<string, string> = {
  online: '#22c55e',
  offline: '#ef4444',
  unknown: '#64748b',
  unreachable: '#f59e0b',
}

const TYPE_ICON: Record<string, string> = {
  switch:   '🔀',
  router:   '🌐',
  ap:       '📶',
  phone:    '📱',
  printer:  '🖨️',
  camera:   '📷',
  firewall: '🛡️',
  server:   '🗄️',
  laptop:   '💻',
  other:    '❓',
}

const TYPE_LABEL: Record<string, string> = {
  switch:   'Switch',
  router:   'Router',
  ap:       'Access Point',
  phone:    'IP Phone',
  printer:  'Yazıcı',
  camera:   'Kamera',
  firewall: 'Firewall',
  server:   'Sunucu',
  laptop:   'Bilgisayar',
  other:    'Bilinmiyor',
}

function inferDeviceType(platform?: string, layer?: string, label?: string): string {
  const p = (platform || '').toLowerCase()
  const la = (layer || '').toLowerCase()
  const lb = (label || '').toLowerCase()
  if (la === 'wireless' || /\bap\b|wifi|access.?point|wap/.test(p)) return 'ap'
  if (/asa|firewall|ftd|firepower|paloalto|fortinet|checkpoint/.test(p)) return 'firewall'
  if (/\brouter\b|isr|csr|asr|nxr/.test(p)) return 'router'
  if (/phone|ip.?phone|voip/.test(p) || /phone/.test(lb)) return 'phone'
  if (/server/.test(lb) || /server/.test(p)) return 'server'
  if (/printer/.test(p) || /printer/.test(lb)) return 'printer'
  if (/camera|cam/.test(p)) return 'camera'
  if (/laptop/.test(p) || /laptop/.test(lb)) return 'laptop'
  return 'switch'
}

function DeviceIcon({ type, size = 14 }: { type: string; size?: number }) {
  const st: CSSProperties = { width: size, height: size, flexShrink: 0, display: 'block' }
  const c = '#ffffff'
  const sw = 1.5

  switch (type) {
    case 'firewall':
      return (
        <svg viewBox="0 0 24 24" style={st} fill="none" stroke={c} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2L4 6v6c0 5.25 3.5 9.74 8 11 4.5-1.26 8-5.75 8-11V6z" />
          <polyline points="9 12 11 14 15 10" />
        </svg>
      )
    case 'ap':
      return (
        <svg viewBox="0 0 24 24" style={st} fill="none" stroke={c} strokeWidth={sw} strokeLinecap="round">
          <path d="M2 8.82a15 15 0 0 1 20 0" />
          <path d="M5 12a11 11 0 0 1 14 0" />
          <path d="M8.5 15.5a6 6 0 0 1 7 0" />
          <circle cx="12" cy="19" r="1.5" fill={c} stroke="none" />
        </svg>
      )
    case 'router':
      return (
        <svg viewBox="0 0 24 24" style={st} fill="none" stroke={c} strokeWidth={sw} strokeLinecap="round">
          <circle cx="12" cy="12" r="3" />
          <line x1="12" y1="3" x2="12" y2="9" />
          <line x1="21" y1="12" x2="15" y2="12" />
          <line x1="12" y1="21" x2="12" y2="15" />
          <line x1="3" y1="12" x2="9" y2="12" />
        </svg>
      )
    case 'phone':
      return (
        <svg viewBox="0 0 24 24" style={st} fill="none" stroke={c} strokeWidth={sw} strokeLinecap="round">
          <rect x="7" y="2" width="10" height="20" rx="2" />
          <circle cx="12" cy="17.5" r="1" fill={c} stroke="none" />
        </svg>
      )
    case 'server':
      return (
        <svg viewBox="0 0 24 24" style={st} fill="none" stroke={c} strokeWidth={sw} strokeLinecap="round">
          <rect x="3" y="4" width="18" height="5" rx="1" />
          <rect x="3" y="11" width="18" height="5" rx="1" />
          <rect x="3" y="18" width="18" height="3" rx="1" />
          <circle cx="6.5" cy="6.5" r="1" fill={c} stroke="none" />
          <circle cx="6.5" cy="13.5" r="1" fill={c} stroke="none" />
        </svg>
      )
    default: // switch
      return (
        <svg viewBox="0 0 24 24" style={st} fill="none" stroke={c} strokeWidth={sw} strokeLinecap="round">
          <rect x="1" y="7" width="22" height="10" rx="2" />
          <line x1="6" y1="7" x2="6" y2="17" strokeOpacity={0.5} />
          <line x1="10" y1="7" x2="10" y2="17" strokeOpacity={0.5} />
          <line x1="14" y1="7" x2="14" y2="17" strokeOpacity={0.5} />
          <line x1="18" y1="7" x2="18" y2="17" strokeOpacity={0.5} />
        </svg>
      )
  }
}

const STALE_MS = 48 * 3600 * 1000

interface DeviceNodeData {
  label: string
  ip?: string
  vendor?: string
  os_type?: string
  status?: string
  model?: string
  device_id?: number
  layer?: string
  platform?: string
  site?: string
  building?: string
  floor?: string
  last_discovery?: string
}

export const DeviceNode = memo(({ data, selected }: { data: DeviceNodeData; selected: boolean }) => {
  const { isDark } = useTheme()
  const vendor = data.vendor || 'other'
  const status = data.status || 'unknown'
  const vendorColor = VENDOR_COLORS[vendor] || '#8c8c8c'
  const statusColor = STATUS_COLORS[status] || '#64748b'
  const layerColor = data.layer ? (LAYER_COLORS[data.layer] || '#64748b') : vendorColor
  const deviceType = inferDeviceType(data.platform, data.layer, data.label)
  const isStale = data.last_discovery
    ? (Date.now() - new Date(data.last_discovery).getTime()) > STALE_MS
    : false

  const isOnline = status === 'online'
  const isOffline = status === 'offline'

  const nodeBg = isDark
    ? isOffline
      ? `linear-gradient(135deg, #ef444410 0%, #1a2030 100%)`
      : `linear-gradient(135deg, ${vendorColor}12 0%, #1a2030 100%)`
    : '#ffffff'
  const nodeText     = isDark ? '#f1f5f9' : '#1e293b'
  const nodeSubText  = isDark ? '#94a3b8' : '#64748b'
  const borderColor  = selected ? '#60a5fa'
    : isStale ? '#f59e0b44'
    : isDark ? `${vendorColor}30` : '#e2e8f0'

  const nodeShadow = selected
    ? `0 0 0 2px ${vendorColor}70, 0 4px 20px ${vendorColor}30`
    : isOnline && isDark
      ? `0 2px 12px rgba(0,0,0,0.5), 0 0 10px ${vendorColor}15`
      : isDark
        ? '0 2px 10px rgba(0,0,0,0.45)'
        : '0 2px 8px rgba(0,0,0,0.1)'

  return (
    <Tooltip
      title={
        <div>
          <div><strong>{data.label}</strong></div>
          <div>IP: {data.ip}</div>
          {data.model && <div>Model: {data.model}</div>}
          <div>OS: {data.os_type}</div>
          {data.layer && <div>Katman: {data.layer}</div>}
          {data.site && <div>Site: {data.site}{data.building ? ` / ${data.building}` : ''}{data.floor ? ` / ${data.floor}` : ''}</div>}
          {isStale && <div style={{ color: '#f59e0b', marginTop: 4 }}>⚠ Keşif verisi 48s+ eski</div>}
        </div>
      }
      placement="top"
    >
      <div style={{
        background: nodeBg,
        border: `1px solid ${borderColor}`,
        borderLeft: `3px solid ${layerColor}`,
        borderRadius: 8,
        minWidth: 145,
        boxShadow: nodeShadow,
        cursor: 'pointer',
        position: 'relative',
        overflow: 'hidden',
        transition: 'box-shadow 0.2s',
      }}>
        {/* Ambient glow layer */}
        {isDark && (
          <div style={{
            position: 'absolute', top: -30, right: -30,
            width: 90, height: 90, borderRadius: '50%',
            background: `radial-gradient(circle, ${vendorColor}18, transparent 70%)`,
            pointerEvents: 'none',
          }} />
        )}

        <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
        <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
        <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
        <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />

        {/* Vendor header */}
        <div style={{
          background: isDark
            ? `linear-gradient(90deg, ${vendorColor}cc, ${vendorColor}99)`
            : vendorColor,
          padding: '4px 7px 4px 8px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 4,
          borderRadius: '6px 6px 0 0',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <DeviceIcon type={deviceType} size={12} />
            <span style={{ color: '#fff', fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              {vendor}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            {data.layer && (
              <span style={{
                background: 'rgba(0,0,0,0.3)', color: '#fff',
                fontSize: 8, fontWeight: 700, padding: '0 4px', borderRadius: 3,
                textTransform: 'uppercase', letterSpacing: 0.3,
              }}>
                {LAYER_LABELS[data.layer] || data.layer}
              </span>
            )}
            {isStale && <span style={{ fontSize: 8, color: '#fde68a' }}>⚠</span>}
            {/* Animated status LED */}
            <div style={{
              width: 7, height: 7, borderRadius: '50%',
              background: statusColor, flexShrink: 0,
              animation: isOnline ? 'topoNodeLed 2.5s ease-in-out infinite' : isOffline ? 'topoNodeOffline 1.8s ease-in-out infinite' : undefined,
            }} />
          </div>
        </div>

        {/* Hostname + IP */}
        <div style={{ padding: '6px 8px 7px 9px', position: 'relative' }}>
          <div style={{
            fontSize: 12, fontWeight: 700, color: nodeText,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 128,
          }}>
            {data.label}
          </div>
          <div style={{ fontSize: 10, color: nodeSubText, marginTop: 1, fontFamily: 'monospace' }}>{data.ip}</div>
        </div>
      </div>
    </Tooltip>
  )
})

interface GhostNodeData {
  label: string
  ip?: string
  platform?: string
  device_type?: string
  source_device_id?: number
  ghost?: boolean
}

export const GhostNode = memo(({ data, selected }: { data: GhostNodeData; selected: boolean }) => {
  const { isDark } = useTheme()
  const dtype = data.device_type || 'other'
  const icon = TYPE_ICON[dtype] || '❓'
  const typeLabel = TYPE_LABEL[dtype] || 'Bilinmiyor'
  const isSwitch = dtype === 'switch' || dtype === 'router'

  const ghostBg = isDark
    ? isSwitch ? '#1c1a0f' : '#0f172a'
    : isSwitch ? '#fff7e6' : '#f8fafc'
  const ghostText = isDark ? '#f1f5f9' : '#1e293b'
  const ghostSub = isDark ? '#94a3b8' : '#64748b'

  return (
    <Tooltip
      title={
        <div>
          <div><strong>{data.label}</strong></div>
          <div>Tür: {typeLabel}</div>
          {data.ip && <div>IP: {data.ip}</div>}
          {data.platform && <div style={{ fontSize: 11, color: '#ccc', maxWidth: 240 }}>{data.platform?.substring(0, 80)}</div>}
          {isSwitch && <div style={{ color: '#22c55e', marginTop: 4 }}>▶ Atlama keşfine eklenebilir</div>}
        </div>
      }
      placement="top"
    >
      <div style={{
        background: ghostBg,
        border: `2px dashed ${selected ? '#3b82f6' : isSwitch ? '#f59e0b' : isDark ? '#475569' : '#cbd5e1'}`,
        borderRadius: 8,
        padding: '8px 12px',
        minWidth: 120,
        opacity: 0.9,
        cursor: isSwitch ? 'pointer' : 'default',
        position: 'relative',
      }}>
        <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
        <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
        <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
        <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />

        <div style={{ fontSize: 16, marginBottom: 2, lineHeight: 1 }}>{icon}</div>
        <div style={{ fontSize: 9, color: isSwitch ? '#f59e0b' : ghostSub, textTransform: 'uppercase', marginBottom: 2, fontWeight: 600 }}>
          {typeLabel}
        </div>
        <div style={{ fontSize: 11, fontWeight: 600, color: ghostText, maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {data.label}
        </div>
        {data.ip && <div style={{ fontSize: 10, color: ghostSub }}>{data.ip}</div>}
      </div>
    </Tooltip>
  )
})
