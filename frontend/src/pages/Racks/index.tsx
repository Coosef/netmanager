import React, { useState, useRef, useEffect, useMemo } from 'react'
import {
  App, Button, Drawer, Empty, Form, Input, InputNumber, Modal,
  Select, Space, Spin, Tooltip, Typography, Popconfirm, Tag,
} from 'antd'
import {
  PlusOutlined, DeleteOutlined, EditOutlined,
  ThunderboltOutlined, AppstoreAddOutlined, DragOutlined,
  HddOutlined, EyeOutlined, ReloadOutlined,
  AppstoreOutlined, UnorderedListOutlined, SearchOutlined,
  SaveOutlined, FolderOpenOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { racksApi, type RackDetail, type RackDeviceSummary, type RackItem } from '@/api/racks'
import { devicesApi } from '@/api/devices'
import { snmpApi } from '@/api/snmp'
import { useTheme } from '@/contexts/ThemeContext'
import { useSite } from '@/contexts/SiteContext'
import SwitchPortPanel from '@/components/SwitchPortPanel'
import type { NetworkInterface, Device } from '@/types'
import { MapContainer, TileLayer, Marker, Polyline, useMapEvents, Tooltip as LeafletTooltip, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

const { Text } = Typography

const UNIT_H = 36
const RACK_W = 500

const VENDOR_COLORS: Record<string, string> = {
  cisco: '#1d6fa4',
  aruba: '#ff8300',
  ruijie: '#e4002b',
  fortinet: '#ee3124',
  other: '#64748b',
}

const ITEM_TYPE_COLORS: Record<string, string> = {
  pdu: '#7c3aed',
  ups: '#0284c7',
  patch_panel: '#0891b2',
  cable_tray: '#78716c',
  blank: '#1e293b',
  fan: '#059669',
  shelf: '#92400e',
  kvm: '#b45309',
  other: '#475569',
}

const ITEM_TYPE_LABELS: Record<string, string> = {
  pdu: 'PDU',
  ups: 'UPS',
  patch_panel: 'Patch Panel',
  cable_tray: 'Kablo Kanalı',
  blank: 'Boşluk Plakası',
  fan: 'Fan Ünitesi',
  shelf: 'Raf',
  kvm: 'KVM Switch',
  other: 'Diğer',
}

interface SlotOccupant {
  type: 'device' | 'item' | 'empty' | 'continuation'
  device?: RackDeviceSummary
  item?: RackItem
  unit: number
}

function buildSlotMap(totalU: number, devices: RackDeviceSummary[], items: RackItem[]): SlotOccupant[] {
  const slots: SlotOccupant[] = Array.from({ length: totalU }, (_, i) => ({ type: 'empty', unit: i + 1 }))
  for (const device of devices) {
    if (device.rack_unit < 1 || device.rack_unit > totalU) continue
    const idx = device.rack_unit - 1
    slots[idx] = { type: 'device', device, unit: device.rack_unit }
    for (let h = 1; h < (device.rack_height || 1); h++) {
      if (idx + h < totalU) slots[idx + h] = { type: 'continuation', unit: device.rack_unit + h }
    }
  }
  for (const item of items) {
    if (item.unit_start < 1 || item.unit_start > totalU) continue
    const idx = item.unit_start - 1
    slots[idx] = { type: 'item', item, unit: item.unit_start }
    for (let h = 1; h < item.unit_height; h++) {
      if (idx + h < totalU) slots[idx + h] = { type: 'continuation', unit: item.unit_start + h }
    }
  }
  return slots
}

// Deterministic LED pattern based on device id
function getLedPattern(deviceId: number): boolean[] {
  return Array.from({ length: 8 }, (_, i) => ((deviceId * 7 + i * 13) % 17) > 7)
}

const RACK_ANIM = `
@keyframes led-pulse {
  0%,100% { opacity:1; box-shadow:0 0 4px currentColor; }
  50% { opacity:0.4; box-shadow:none; }
}
@keyframes led-blink {
  0%,90%,100% { opacity:0.15; }
  5%,20% { opacity:1; }
}
@keyframes status-glow {
  0%,100% { box-shadow:0 0 6px 2px var(--glow-color,#22c55e88); }
  50% { box-shadow:0 0 12px 4px var(--glow-color,#22c55e44); }
}
@keyframes fan-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
@keyframes scan-line {
  0% { top: 0; opacity:0.06; }
  100% { top: 100%; opacity:0; }
}
`

interface UtilizationInfo { maxPct: number; inPct: number; outPct: number }

interface RackViewProps {
  rack: RackDetail
  onDropDevice: (deviceId: number, unit: number) => void
  onRemoveDevice: (deviceId: number) => void
  onAddItem: (unit: number) => void
  onEditItem: (item: RackItem) => void
  onDeleteItem: (item: RackItem) => void
  onClickDevice: (device: RackDeviceSummary) => void
  isDark: boolean
  utilizationMap?: Map<number, UtilizationInfo>
}

function DevicePanel({
  device, height, onRemove, onViewPorts, isDark, utilization,
}: { device: RackDeviceSummary; height: number; onRemove: () => void; onViewPorts: () => void; isDark: boolean; utilization?: UtilizationInfo }) {
  const vc = VENDOR_COLORS[device.vendor] || VENDOR_COLORS.other
  const isOnline = device.status === 'online'
  const isOffline = device.status === 'offline'
  const ledColor = isOnline ? '#22c55e' : isOffline ? '#ef4444' : '#f59e0b'
  const leds = getLedPattern(device.id)
  const multiU = height >= UNIT_H * 2
  const panelBg = isDark
    ? `linear-gradient(180deg, #1a2332 0%, #111827 60%, #0d1520 100%)`
    : `linear-gradient(180deg, #e2e8f0 0%, #cbd5e1 60%, #b8c5d6 100%)`
  const textColor = isDark ? '#e2e8f0' : '#1e293b'
  const subTextColor = isDark ? '#475569' : '#64748b'
  const rowBorder = isDark ? '#0a0f1a' : '#c8d5e3'

  const heatColor = utilization
    ? utilization.maxPct >= 90 ? '#ef4444'
    : utilization.maxPct >= 70 ? '#f97316'
    : utilization.maxPct >= 40 ? '#f59e0b'
    : '#22c55e'
    : null
  const heatOpacity = utilization
    ? utilization.maxPct >= 90 ? 0.12
    : utilization.maxPct >= 70 ? 0.09
    : utilization.maxPct >= 40 ? 0.07
    : 0.04
    : 0

  return (
    <div style={{
      height,
      position: 'relative',
      display: 'flex',
      alignItems: 'stretch',
      background: panelBg,
      borderBottom: `1px solid ${rowBorder}`,
      overflow: 'hidden',
      cursor: 'grab',
    }}>
      {/* Vendor accent stripe */}
      <div style={{
        width: 4,
        flexShrink: 0,
        background: `linear-gradient(180deg, ${vc}, ${vc}88)`,
        boxShadow: isOnline ? `0 0 8px ${vc}88` : 'none',
      }} />

      {/* Status LED column */}
      <div style={{
        width: 20,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
        padding: '4px 0',
      }}>
        {/* Main status LED */}
        <div style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: ledColor,
          color: ledColor,
          flexShrink: 0,
          animation: isOnline ? 'status-glow 2s ease-in-out infinite' : 'none',
          boxShadow: isOnline ? `0 0 6px ${ledColor}` : 'none',
        } as React.CSSProperties} />
        {/* Activity LEDs */}
        {multiU && leds.slice(0, 4).map((on, i) => (
          <div key={i} style={{
            width: 4,
            height: 4,
            borderRadius: '50%',
            background: on && isOnline ? '#22c55e' : isDark ? '#1e3a2e' : '#94a3b8',
            animation: on && isOnline ? `led-blink ${1.2 + i * 0.4}s ease-in-out infinite` : 'none',
          }} />
        ))}
      </div>

      {/* Main content */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '4px 8px' }}>
        <div style={{
          fontFamily: "'JetBrains Mono','Fira Code','Courier New',monospace",
          fontSize: multiU ? 13 : 11,
          fontWeight: 700,
          color: textColor,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          letterSpacing: '0.02em',
        }}>
          {device.hostname}
        </div>
        <div style={{
          fontFamily: 'monospace',
          fontSize: 9,
          color: subTextColor,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          marginTop: 2,
        }}>
          {device.ip_address}{device.model ? ` · ${device.model}` : ''}
        </div>
        {multiU && (
          <div style={{ marginTop: 6, display: 'flex', gap: 3 }}>
            {leds.map((on, i) => (
              <div key={i} style={{
                width: 6,
                height: 4,
                borderRadius: 1,
                background: on && isOnline ? '#3b82f6' : isDark ? '#1e2d3d' : '#cbd5e1',
                animation: on && isOnline ? `led-blink ${0.8 + i * 0.3}s ease-in-out infinite` : 'none',
              }} />
            ))}
          </div>
        )}
      </div>

      {/* Right side info */}
      <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', justifyContent: 'center', padding: '4px 8px', gap: 4 }}>
        <div style={{
          fontSize: 8,
          fontWeight: 700,
          color: vc,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          background: `${vc}22`,
          border: `1px solid ${vc}44`,
          borderRadius: 3,
          padding: '1px 5px',
          whiteSpace: 'nowrap',
        }}>
          {device.vendor.toUpperCase()}
        </div>
        {utilization && heatColor && (
          <Tooltip title={`Bant: ↓${utilization.inPct}% ↑${utilization.outPct}%`}>
            <div style={{ width: 34, display: 'flex', flexDirection: 'column', gap: 1, alignItems: 'flex-end' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
                <span style={{ fontSize: 7, color: heatColor, fontFamily: 'monospace' }}>{utilization.maxPct}%</span>
              </div>
              <div style={{ width: 34, height: 3, background: isDark ? '#0a0f1a' : '#c8d5e3', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{
                  width: `${utilization.maxPct}%`, height: '100%', borderRadius: 2,
                  background: `linear-gradient(90deg, ${heatColor}80, ${heatColor})`,
                  boxShadow: utilization.maxPct >= 70 ? `0 0 4px ${heatColor}` : undefined,
                  transition: 'width 1s ease-out',
                }} />
              </div>
            </div>
          </Tooltip>
        )}
        <Tooltip title="Port Görünümü">
          <div
            onClick={(e) => { e.stopPropagation(); onViewPorts() }}
            style={{
              color: '#334155',
              cursor: 'pointer',
              fontSize: 11,
              padding: 2,
              borderRadius: 3,
              transition: 'color 0.15s',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = '#3b82f6')}
            onMouseLeave={(e) => (e.currentTarget.style.color = '#334155')}
          >
            <EyeOutlined />
          </div>
        </Tooltip>
        <Tooltip title="Kabinden çıkar">
          <div
            onClick={(e) => { e.stopPropagation(); onRemove() }}
            style={{
              color: '#334155',
              cursor: 'pointer',
              fontSize: 11,
              padding: 2,
              borderRadius: 3,
              transition: 'color 0.15s',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = '#ef4444')}
            onMouseLeave={(e) => (e.currentTarget.style.color = '#334155')}
          >
            <DeleteOutlined />
          </div>
        </Tooltip>
      </div>

      {/* Right screw */}
      <div style={{ width: 10, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#1e293b', border: '1px solid #334155' }} />
      </div>

      {/* Heat overlay */}
      {heatColor && (
        <div style={{
          position: 'absolute', inset: 0, pointerEvents: 'none',
          background: `radial-gradient(ellipse at 70% 50%, ${heatColor} 0%, transparent 75%)`,
          opacity: heatOpacity,
        }} />
      )}

      {/* Scan line effect */}
      {isOnline && (
        <div style={{
          position: 'absolute',
          left: 0,
          right: 0,
          height: 1,
          background: `linear-gradient(90deg, transparent, ${vc}33, transparent)`,
          animation: 'scan-line 4s linear infinite',
          pointerEvents: 'none',
        }} />
      )}
    </div>
  )
}

function ItemPanel({
  item, height, onEdit, onDelete, isDark,
}: { item: RackItem; height: number; onEdit: () => void; onDelete: () => void; isDark: boolean }) {
  const ic = ITEM_TYPE_COLORS[item.item_type] || ITEM_TYPE_COLORS.other
  const multiU = height >= UNIT_H * 2
  const itemTextColor = isDark ? '#cbd5e1' : '#1e293b'

  const renderItemDecoration = () => {
    if (item.item_type === 'patch_panel') {
      return (
        <div style={{ display: 'flex', gap: 3, marginTop: 4, flexWrap: 'wrap', maxWidth: 200 }}>
          {Array.from({ length: 24 }, (_, i) => (
            <div key={i} style={{
              width: 6, height: 8, borderRadius: 1,
              background: (item.id * 3 + i) % 5 !== 0 ? '#0e7490' : '#1e293b',
              border: '1px solid #164e63',
            }} />
          ))}
        </div>
      )
    }
    if (item.item_type === 'ups') {
      const bars = 5
      const filled = 4
      return (
        <div style={{ display: 'flex', gap: 2, marginTop: 4 }}>
          {Array.from({ length: bars }, (_, i) => (
            <div key={i} style={{
              width: 10, height: 12, borderRadius: 1,
              background: i < filled ? '#22c55e' : '#1e293b',
              border: `1px solid ${i < filled ? '#16a34a' : '#374151'}`,
            }} />
          ))}
          <div style={{ fontSize: 8, color: '#22c55e', marginLeft: 4, alignSelf: 'center' }}>
            {Math.round(filled / bars * 100)}%
          </div>
        </div>
      )
    }
    if (item.item_type === 'pdu') {
      return (
        <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} style={{
              width: 12, height: 12, borderRadius: '50%',
              background: '#1e293b',
              border: '2px solid #7c3aed',
              boxShadow: '0 0 4px #7c3aed44',
            }} />
          ))}
        </div>
      )
    }
    if (item.item_type === 'fan') {
      return (
        <div style={{
          marginTop: 4,
          width: 20, height: 20,
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
          <div style={{
            width: 16, height: 16,
            borderRadius: '50%',
            border: '2px solid #059669',
            borderTopColor: 'transparent',
            animation: 'fan-spin 1.5s linear infinite',
          }} />
        </div>
      )
    }
    return null
  }

  return (
    <div style={{
      height,
      display: 'flex',
      alignItems: 'stretch',
      background: isDark
        ? `linear-gradient(180deg, ${ic}18, ${ic}08)`
        : `linear-gradient(180deg, ${ic}22, ${ic}10)`,
      borderLeft: `4px solid ${ic}`,
      borderBottom: `1px solid ${isDark ? '#0a0f1a' : '#c8d5e3'}`,
      overflow: 'hidden',
      position: 'relative',
    }}>
      {/* Diagonal stripe pattern */}
      <div style={{
        position: 'absolute', inset: 0,
        backgroundImage: `repeating-linear-gradient(45deg, ${ic}${isDark ? '08' : '0a'}, ${ic}${isDark ? '08' : '0a'} 3px, transparent 3px, transparent 12px)`,
        pointerEvents: 'none',
      }} />

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '4px 10px', position: 'relative' }}>
        <div style={{
          fontSize: multiU ? 13 : 11,
          fontWeight: 700,
          color: itemTextColor,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {item.label}
        </div>
        <div style={{ fontSize: 9, color: ic, marginTop: 1, fontWeight: 600, letterSpacing: '0.06em' }}>
          {ITEM_TYPE_LABELS[item.item_type] || item.item_type}
        </div>
        {multiU && renderItemDecoration()}
      </div>

      <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '4px 8px', gap: 6 }}>
        <Tooltip title="Düzenle">
          <EditOutlined
            onClick={(e) => { e.stopPropagation(); onEdit() }}
            style={{ color: '#475569', cursor: 'pointer', fontSize: 11 }}
            onMouseEnter={(e: any) => (e.currentTarget.style.color = '#94a3b8')}
            onMouseLeave={(e: any) => (e.currentTarget.style.color = '#475569')}
          />
        </Tooltip>
        <Tooltip title="Sil">
          <DeleteOutlined
            onClick={(e) => { e.stopPropagation(); onDelete() }}
            style={{ color: '#374151', cursor: 'pointer', fontSize: 11 }}
            onMouseEnter={(e: any) => (e.currentTarget.style.color = '#ef4444')}
            onMouseLeave={(e: any) => (e.currentTarget.style.color = '#374151')}
          />
        </Tooltip>
      </div>

      <div style={{ width: 10, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#1e293b', border: '1px solid #334155' }} />
      </div>
    </div>
  )
}

function RackDiagram({ rack, onDropDevice, onRemoveDevice, onAddItem, onEditItem, onDeleteItem, onClickDevice, isDark, utilizationMap }: RackViewProps) {
  const [dragOverUnit, setDragOverUnit] = useState<number | null>(null)
  const [hoveredUnit, setHoveredUnit] = useState<number | null>(null)
  const dragDeviceId = useRef<number | null>(null)
  const slots = buildSlotMap(rack.total_u, rack.devices, rack.items)

  const usedU = rack.devices.reduce((s, d) => s + (d.rack_height || 1), 0)
    + rack.items.reduce((s, i) => s + i.unit_height, 0)
  const fillPct = Math.min(100, Math.round((usedU / rack.total_u) * 100))
  const fillColor = fillPct > 80 ? '#ef4444' : fillPct > 60 ? '#f59e0b' : '#22c55e'

  const chassisBg = isDark
    ? 'linear-gradient(180deg, #1a1f2e 0%, #0d111a 100%)'
    : 'linear-gradient(180deg, #d1d9e6 0%, #b8c5d6 100%)'
  const chassisBorder = isDark ? '#1e2a3a' : '#94a3b8'
  const chassisShadow = isDark
    ? '0 20px 60px rgba(0,0,0,0.8), inset 0 1px 0 #2a3a4a, 4px 4px 0 #06090f, 8px 8px 0 #04060c'
    : '0 8px 32px rgba(0,0,0,0.2), inset 0 1px 0 #e2e8f0, 4px 4px 0 #94a3b8'
  const headerBg = isDark ? 'linear-gradient(180deg, #1e2a3a, #151c28)' : 'linear-gradient(180deg, #94a3b8, #7c8fa3)'
  const headerBorder = isDark ? '#0a0f1a' : '#64748b'
  const railBg = isDark ? 'linear-gradient(90deg, #111827, #0d1117)' : 'linear-gradient(90deg, #94a3b8, #8898aa)'
  const railBorder = isDark ? '#0a0f1a' : '#64748b'
  const boltBg = isDark ? '#0a0f1a' : '#64748b'
  const boltBorder = isDark ? '#1e293b' : '#475569'
  const unitNumColor = isDark ? '#334155' : '#e2e8f0'
  const emptySlotBg = isDark ? '#0b0f18' : '#e8edf5'
  const emptySlotHoverBg = isDark ? '#0f172a' : '#dde4ef'
  const emptySlotBorder = isDark ? '#0a0f1a' : '#c8d5e3'
  const footerBg = isDark ? 'linear-gradient(0deg, #1e2a3a, #151c28)' : 'linear-gradient(0deg, #94a3b8, #7c8fa3)'
  const footerTextColor = isDark ? '#1e3a5f' : '#e2e8f0'
  const headerTextColor = isDark ? '#94a3b8' : '#f1f5f9'
  const capacityBg = isDark ? '#0a0f1a' : '#475569'

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif' }}>
      <style>{RACK_ANIM}</style>

      {/* Outer rack chassis */}
      <div style={{
        display: 'inline-block',
        background: chassisBg,
        borderRadius: 6,
        border: `2px solid ${chassisBorder}`,
        boxShadow: chassisShadow,
        overflow: 'hidden',
        minWidth: RACK_W + 80,
        position: 'relative',
      }}>

        {/* Top structural bar */}
        <div style={{
          height: 36,
          background: headerBg,
          borderBottom: `2px solid ${headerBorder}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 16px',
          gap: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* Power indicator */}
            <div style={{
              width: 10, height: 10, borderRadius: '50%',
              background: '#22c55e',
              boxShadow: '0 0 8px #22c55e',
              animation: 'status-glow 2.5s ease-in-out infinite',
              flexShrink: 0,
            }} />
            <span style={{
              fontFamily: "'JetBrains Mono','Fira Code',monospace",
              fontSize: 13,
              fontWeight: 700,
              color: headerTextColor,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
            }}>
              {rack.rack_name}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {/* Capacity bar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ width: 80, height: 6, background: capacityBg, borderRadius: 3, overflow: 'hidden' }}>
                <div style={{
                  width: `${fillPct}%`, height: '100%',
                  background: `linear-gradient(90deg, ${fillColor}88, ${fillColor})`,
                  borderRadius: 3,
                  transition: 'width 0.3s',
                }} />
              </div>
              <span style={{ fontSize: 9, color: isDark ? '#475569' : '#e2e8f0', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                {usedU}/{rack.total_u}U
              </span>
            </div>
            {/* Decorative indicator lights */}
            {[0, 1, 2].map((i) => (
              <div key={i} style={{
                width: 6, height: 6, borderRadius: '50%',
                background: i === 0 ? '#22c55e' : i === 1 ? '#3b82f6' : '#1e293b',
                boxShadow: i === 0 ? '0 0 4px #22c55e' : i === 1 ? '0 0 4px #3b82f6' : 'none',
              }} />
            ))}
          </div>
        </div>

        {/* Slot rows */}
        <div style={{ display: 'flex' }}>
          {/* Left rail */}
          <div style={{
            width: 34,
            flexShrink: 0,
            background: railBg,
            borderRight: `2px solid ${railBorder}`,
          }}>
            {slots.map((slot, i) => (
              <div key={i} style={{
                height: UNIT_H,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderBottom: '1px solid #0d1117',
                position: 'relative',
                gap: 4,
              }}>
                {/* Bolt holes */}
                <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#0a0f1a', border: '1px solid #1e293b', flexShrink: 0 }} />
                {slot.type !== 'continuation' && (
                  <span style={{
                    fontSize: 8,
                    color: unitNumColor,
                    fontFamily: 'monospace',
                    lineHeight: 1,
                    position: 'absolute',
                    right: 4,
                    bottom: 3,
                  }}>
                    {slot.unit}
                  </span>
                )}
              </div>
            ))}
          </div>

          {/* Main slot column */}
          <div style={{ flex: 1, minWidth: 0 }}>
            {slots.map((slot, i) => {
              if (slot.type === 'continuation') return null

              const height = slot.type === 'device'
                ? (slot.device!.rack_height || 1) * UNIT_H
                : slot.type === 'item'
                ? slot.item!.unit_height * UNIT_H
                : UNIT_H

              if (slot.type === 'device') {
                return (
                  <div
                    key={i}
                    draggable
                    onDragStart={(e) => { dragDeviceId.current = slot.device!.id; e.dataTransfer.setData('deviceId', String(slot.device!.id)) }}
                  >
                    <DevicePanel
                      device={slot.device!}
                      height={height}
                      onRemove={() => onRemoveDevice(slot.device!.id)}
                      onViewPorts={() => onClickDevice(slot.device!)}
                      isDark={isDark}
                      utilization={utilizationMap?.get(slot.device!.id)}
                    />
                  </div>
                )
              }

              if (slot.type === 'item') {
                return (
                  <ItemPanel
                    key={i}
                    item={slot.item!}
                    height={height}
                    onEdit={() => onEditItem(slot.item!)}
                    onDelete={() => onDeleteItem(slot.item!)}
                    isDark={isDark}
                  />
                )
              }

              // Empty slot
              const isDragOver = dragOverUnit === slot.unit
              const isHovered = hoveredUnit === slot.unit
              return (
                <div
                  key={i}
                  style={{
                    height,
                    display: 'flex',
                    alignItems: 'center',
                    padding: '0 10px',
                    gap: 6,
                    borderBottom: `1px solid ${emptySlotBorder}`,
                    cursor: isDragOver ? 'copy' : 'pointer',
                    transition: 'background 0.12s',
                    background: isDragOver
                      ? '#1d4ed833'
                      : isHovered
                      ? emptySlotHoverBg
                      : emptySlotBg,
                    position: 'relative',
                  }}
                  onMouseEnter={() => setHoveredUnit(slot.unit)}
                  onMouseLeave={() => setHoveredUnit(null)}
                  onDragOver={(e) => { e.preventDefault(); setDragOverUnit(slot.unit) }}
                  onDragLeave={() => setDragOverUnit(null)}
                  onDrop={(e) => {
                    e.preventDefault()
                    setDragOverUnit(null)
                    const fromTransfer = e.dataTransfer.getData('deviceId')
                    const deviceId = dragDeviceId.current ?? (fromTransfer ? parseInt(fromTransfer) : null)
                    if (deviceId) { onDropDevice(deviceId, slot.unit); dragDeviceId.current = null }
                  }}
                  onClick={() => onAddItem(slot.unit)}
                >
                  {isDragOver ? (
                    <div style={{
                      position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      border: '1px dashed #3b82f6', background: '#1d4ed822',
                    }}>
                      <span style={{ color: '#60a5fa', fontSize: 10, fontFamily: 'monospace' }}>— BURAYA BIRAK —</span>
                    </div>
                  ) : isHovered ? (
                    <span style={{ color: isDark ? '#334155' : '#94a3b8', fontSize: 9, fontFamily: 'monospace', width: '100%', textAlign: 'center' }}>
                      <PlusOutlined style={{ fontSize: 8, marginRight: 4 }} />EKLE
                    </span>
                  ) : null}
                </div>
              )
            })}
          </div>

          {/* Right rail */}
          <div style={{
            width: 30,
            flexShrink: 0,
            background: isDark ? 'linear-gradient(270deg, #111827, #0d1117)' : 'linear-gradient(270deg, #94a3b8, #8898aa)',
            borderLeft: `2px solid ${railBorder}`,
          }}>
            {slots.map((_, i) => (
              <div key={i} style={{
                height: UNIT_H,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderBottom: `1px solid ${isDark ? '#0d1117' : '#7c8fa3'}`,
              }}>
                <div style={{ width: 5, height: 5, borderRadius: '50%', background: boltBg, border: `1px solid ${boltBorder}` }} />
              </div>
            ))}
          </div>
        </div>

        {/* Bottom structural bar */}
        <div style={{
          height: 28,
          background: footerBg,
          borderTop: `2px solid ${headerBorder}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 16px',
        }}>
          <span style={{ fontSize: 9, color: footerTextColor, fontFamily: 'monospace', letterSpacing: '0.05em' }}>
            19" EIA-310 · {rack.total_u}U
          </span>
          <span style={{ fontSize: 9, color: footerTextColor, fontFamily: 'monospace' }}>
            {rack.devices.length} DEVICES · {rack.items.length} ITEMS
          </span>
        </div>
      </div>
    </div>
  )
}

// ── Physical Topology Map ─────────────────────────────────────────────────────

interface TopoNode {
  id: string; deviceId: number; hostname: string; ip: string
  vendor: string; status: string; device_type: string; x: number; y: number
}
interface TopoEdge { id: string; from: string; to: string }
interface TopoState { nodes: TopoNode[]; edges: TopoEdge[]; bgImage?: string }

const CANVAS_W = 2400
const CANVAS_H = 1400
const NODE_W = 158
const NODE_H = 62
const TOPO_KEY = 'nm-phys-topo-v1'

function loadTopo(): TopoState {
  try { const s = localStorage.getItem(TOPO_KEY); return s ? JSON.parse(s) : { nodes: [], edges: [] } }
  catch { return { nodes: [], edges: [] } }
}
function saveTopo(st: TopoState) {
  try { localStorage.setItem(TOPO_KEY, JSON.stringify(st)) } catch {}
}
function deviceEmoji(dt: string, vendor: string): string {
  const d = (dt || '').toLowerCase(), v = (vendor || '').toLowerCase()
  if (d.includes('ap') || d.includes('wireless') || d.includes('access_point')) return '📡'
  if (d.includes('router') || d.includes('core')) return '⬡'
  if (v.includes('fortinet') || d.includes('firewall')) return '🛡'
  if (d.includes('server')) return '▣'
  return '⊞'
}

function PhysicalTopoMap({ isDark, devices }: { isDark: boolean; devices: Device[] }) {
  const [nodes, setNodes] = useState<TopoNode[]>(() => loadTopo().nodes)
  const [edges, setEdges] = useState<TopoEdge[]>(() => loadTopo().edges)
  const [bgImage, setBgImage] = useState<string | undefined>(() => loadTopo().bgImage)
  const [mode, setMode] = useState<'select' | 'connect' | 'erase'>('select')
  const [connecting, setConnecting] = useState<string | null>(null)
  const [ghostPos, setGhostPos] = useState<{ x: number; y: number } | null>(null)
  const [pan, setPan] = useState({ x: 24, y: 24 })
  const [panStart, setPanStart] = useState<{ mx: number; my: number; px: number; py: number } | null>(null)
  const [draggingNode, setDraggingNode] = useState<{ id: string; ox: number; oy: number } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const panRef = useRef(pan)
  useEffect(() => { panRef.current = pan }, [pan])

  useEffect(() => { saveTopo({ nodes, edges, bgImage }) }, [nodes, edges, bgImage])

  const canvasXY = (clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return { x: clientX - rect.left - panRef.current.x, y: clientY - rect.top - panRef.current.y }
  }

  const handleContainerMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('[data-topo-node]')) return
    if (mode === 'select') setPanStart({ mx: e.clientX, my: e.clientY, px: pan.x, py: pan.y })
  }

  const handleContainerMouseMove = (e: React.MouseEvent) => {
    if (panStart && !draggingNode) {
      setPan({ x: panStart.px + e.clientX - panStart.mx, y: panStart.py + e.clientY - panStart.my })
      return
    }
    if (draggingNode) {
      const pos = canvasXY(e.clientX, e.clientY)
      const nx = Math.max(4, Math.min(CANVAS_W - NODE_W - 4, pos.x - draggingNode.ox))
      const ny = Math.max(4, Math.min(CANVAS_H - NODE_H - 4, pos.y - draggingNode.oy))
      setNodes(ns => ns.map(n => n.id === draggingNode.id ? { ...n, x: nx, y: ny } : n))
    }
    if (connecting) {
      setGhostPos(canvasXY(e.clientX, e.clientY))
    }
  }

  const handleContainerMouseUp = () => { setPanStart(null); setDraggingNode(null) }

  const handleNodeMouseDown = (e: React.MouseEvent, nodeId: string) => {
    e.stopPropagation()
    if (mode !== 'select') return
    const node = nodes.find(n => n.id === nodeId)
    if (!node) return
    const pos = canvasXY(e.clientX, e.clientY)
    setDraggingNode({ id: nodeId, ox: pos.x - node.x, oy: pos.y - node.y })
  }

  const handleNodeClick = (e: React.MouseEvent, nodeId: string) => {
    e.stopPropagation()
    if (mode === 'connect') {
      if (!connecting) {
        setConnecting(nodeId)
        const n = nodes.find(nd => nd.id === nodeId)
        if (n) setGhostPos({ x: n.x + NODE_W / 2, y: n.y + NODE_H / 2 })
      } else if (connecting !== nodeId) {
        const dup = edges.some(ed =>
          (ed.from === connecting && ed.to === nodeId) ||
          (ed.from === nodeId && ed.to === connecting)
        )
        if (!dup) setEdges(es => [...es, { id: `e${Date.now()}`, from: connecting, to: nodeId }])
        setConnecting(null); setGhostPos(null)
      }
    } else if (mode === 'erase') {
      setNodes(ns => ns.filter(n => n.id !== nodeId))
      setEdges(es => es.filter(ed => ed.from !== nodeId && ed.to !== nodeId))
    }
  }

  const handleCanvasClick = (e: React.MouseEvent) => {
    if (mode === 'connect' && connecting && !(e.target as HTMLElement).closest('[data-topo-node]')) {
      setConnecting(null); setGhostPos(null)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const raw = e.dataTransfer.getData('topo-device-id')
    if (!raw) return
    const deviceId = parseInt(raw)
    const device = devices.find(d => d.id === deviceId)
    if (!device || nodes.some(n => n.deviceId === deviceId)) return
    const pos = canvasXY(e.clientX, e.clientY)
    setNodes(ns => [...ns, {
      id: `n${Date.now()}`,
      deviceId: device.id, hostname: device.hostname, ip: device.ip_address,
      vendor: device.vendor, status: device.status, device_type: device.device_type,
      x: Math.max(4, Math.min(CANVAS_W - NODE_W - 4, pos.x - NODE_W / 2)),
      y: Math.max(4, Math.min(CANVAS_H - NODE_H - 4, pos.y - NODE_H / 2)),
    }])
  }

  const handleBgUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => setBgImage(ev.target?.result as string)
    reader.readAsDataURL(file)
  }

  const placedIds = useMemo(() => new Set(nodes.map(n => n.deviceId)), [nodes])

  const nodeCx = (n: TopoNode) => n.x + NODE_W / 2
  const nodeCy = (n: TopoNode) => n.y + NODE_H / 2

  const edgePath = (a: TopoNode, b: TopoNode) => {
    const dx = Math.abs(nodeCx(b) - nodeCx(a))
    const cp = Math.max(50, dx * 0.45)
    return `M${nodeCx(a)},${nodeCy(a)} C${nodeCx(a) + cp},${nodeCy(a)} ${nodeCx(b) - cp},${nodeCy(b)} ${nodeCx(b)},${nodeCy(b)}`
  }

  const gridDot = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.05)'
  const cBg = isDark ? '#060b14' : '#f0f5fb'
  const nBg = isDark ? '#0e1e38' : '#ffffff'
  const nText = isDark ? '#e2e8f0' : '#1e293b'
  const nSub = isDark ? '#475569' : '#94a3b8'
  const nBorder = isDark ? '#1a3458' : '#e2e8f0'
  const eColor = isDark ? '#3b82f660' : '#64748b55'
  const sidebarBg = isDark ? '#0a0f18' : '#ffffff'
  const toolbarBg = isDark ? '#0a0f18' : '#ffffff'
  const sideBorder = isDark ? '#1e2a3a' : '#e2e8f0'
  const modeHints: Record<string, string> = {
    select: '🖐  Boş alanda sürükle → kaydır  ·  Cihazı sürükle → taşı',
    connect: '🔗  Kaynak cihaza tıkla → Hedef cihaza tıkla  ·  Boşluğa tıkla → iptal',
    erase: '🗑  Silmek için cihaz veya bağlantı çizgisine tıkla',
  }

  return (
    <div style={{
      display: 'flex', height: 'calc(100vh - 196px)', minHeight: 520,
      border: `1px solid ${sideBorder}`, borderRadius: 12,
      overflow: 'hidden', background: isDark ? '#070b14' : '#f8fafc',
    }}>

      {/* ── Sidebar ── */}
      <div style={{ width: 192, borderRight: `1px solid ${sideBorder}`, display: 'flex', flexDirection: 'column', background: sidebarBg, flexShrink: 0 }}>
        <div style={{ padding: '10px 12px', borderBottom: `1px solid ${sideBorder}`, background: isDark ? '#0d1420' : '#f8fafc' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: isDark ? '#475569' : '#94a3b8', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            Cihazlar ({devices.length})
          </div>
          <div style={{ fontSize: 9, color: isDark ? '#334155' : '#cbd5e1', marginTop: 1 }}>Sürükle → haritaya bırak</div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {devices.length === 0 ? (
            <div style={{ padding: 16, textAlign: 'center', color: isDark ? '#334155' : '#94a3b8', fontSize: 11 }}>Yükleniyor…</div>
          ) : devices.map(d => {
            const vc = VENDOR_COLORS[d.vendor] || VENDOR_COLORS.other
            const placed = placedIds.has(d.id)
            return (
              <div key={d.id}
                draggable={!placed}
                onDragStart={e => e.dataTransfer.setData('topo-device-id', String(d.id))}
                style={{
                  padding: '7px 10px', cursor: placed ? 'default' : 'grab',
                  opacity: placed ? 0.4 : 1, display: 'flex', alignItems: 'center', gap: 6,
                  borderBottom: `1px solid ${isDark ? '#0e1420' : '#f1f5f9'}`,
                  transition: 'background 0.1s',
                }}
                onMouseEnter={e => { if (!placed) (e.currentTarget as HTMLElement).style.background = isDark ? '#111827' : '#f8fafc' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
              >
                <div style={{ width: 3, height: 26, borderRadius: 2, background: vc, flexShrink: 0 }} />
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: d.status === 'online' ? '#22c55e' : d.status === 'offline' ? '#ef4444' : '#f59e0b', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: nText, fontSize: 10, fontWeight: 600, fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.hostname}</div>
                  <div style={{ color: nSub, fontSize: 9 }}>{d.ip_address}</div>
                </div>
                {placed && <div style={{ fontSize: 8, color: '#22c55e', background: '#22c55e18', borderRadius: 3, padding: '1px 4px', flexShrink: 0, border: '1px solid #22c55e33' }}>✓</div>}
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Canvas Column ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Toolbar */}
        <div style={{ padding: '8px 12px', borderBottom: `1px solid ${sideBorder}`, display: 'flex', alignItems: 'center', gap: 8, background: toolbarBg, flexShrink: 0, flexWrap: 'wrap' }}>
          <Button.Group size="small">
            <Button type={mode === 'select' ? 'primary' : 'default'} onClick={() => { setMode('select'); setConnecting(null); setGhostPos(null) }}>Seç</Button>
            <Button
              size="small"
              type={mode === 'connect' ? 'primary' : 'default'}
              style={mode === 'connect' ? { background: '#22c55e', borderColor: '#22c55e' } : {}}
              onClick={() => { setMode('connect'); setConnecting(null); setGhostPos(null) }}
            >Bağla</Button>
            <Button size="small" type={mode === 'erase' ? 'primary' : 'default'} danger={mode === 'erase'} onClick={() => { setMode('erase'); setConnecting(null); setGhostPos(null) }}>Sil</Button>
          </Button.Group>
          <div style={{ width: 1, height: 18, background: sideBorder, flexShrink: 0 }} />
          <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleBgUpload} />
          <Tooltip title="Kat planı / bina görseli yükle (jpg, png, svg…)">
            <Button size="small" onClick={() => fileInputRef.current?.click()}>🗺 Plan Yükle</Button>
          </Tooltip>
          {bgImage && (
            <Button size="small" onClick={() => setBgImage(undefined)}>Planı Kaldır</Button>
          )}
          <div style={{ width: 1, height: 18, background: sideBorder, flexShrink: 0 }} />
          <span style={{ fontSize: 10, color: isDark ? '#475569' : '#94a3b8', fontFamily: 'monospace' }}>
            {nodes.length} cihaz · {edges.length} bağlantı
          </span>
          <div style={{ flex: 1 }} />
          <Tooltip title="Görünümü başa al"><Button size="small" onClick={() => setPan({ x: 24, y: 24 })}>⟳</Button></Tooltip>
          <Popconfirm title="Tüm harita temizlensin mi?" onConfirm={() => { setNodes([]); setEdges([]); setConnecting(null) }} okText="Evet" cancelText="İptal" okButtonProps={{ danger: true }}>
            <Button size="small" danger>Temizle</Button>
          </Popconfirm>
        </div>

        {/* Map */}
        <div
          ref={containerRef}
          style={{
            flex: 1, overflow: 'hidden', position: 'relative',
            cursor: panStart ? 'grabbing' : mode === 'connect' ? 'crosshair' : mode === 'erase' ? 'cell' : 'grab',
            userSelect: 'none',
          }}
          onMouseDown={handleContainerMouseDown}
          onMouseMove={handleContainerMouseMove}
          onMouseUp={handleContainerMouseUp}
          onMouseLeave={handleContainerMouseUp}
          onClick={handleCanvasClick}
          onDragOver={e => e.preventDefault()}
          onDrop={handleDrop}
        >
          {/* Inner canvas (panned) */}
          <div style={{ width: CANVAS_W, height: CANVAS_H, position: 'absolute', transform: `translate(${pan.x}px, ${pan.y}px)` }}>

            {/* Background */}
            {bgImage
              ? <img src={bgImage} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: 0.72 }} alt="" draggable={false} />
              : <div style={{ position: 'absolute', inset: 0, background: cBg, backgroundImage: `radial-gradient(circle, ${gridDot} 1.5px, transparent 0)`, backgroundSize: '32px 32px' }} />
            }

            {/* SVG edges */}
            <svg style={{ position: 'absolute', inset: 0, overflow: 'visible' }} width={CANVAS_W} height={CANVAS_H}>
              <defs>
                <style>{`@keyframes dashFlow { to { stroke-dashoffset: -20; } }`}</style>
              </defs>
              {edges.map(edge => {
                const fn = nodes.find(n => n.id === edge.from)
                const tn = nodes.find(n => n.id === edge.to)
                if (!fn || !tn) return null
                const dp = edgePath(fn, tn)
                return (
                  <g key={edge.id}
                    style={{ pointerEvents: mode === 'erase' ? 'all' : 'none', cursor: mode === 'erase' ? 'pointer' : 'default' }}
                    onClick={() => mode === 'erase' && setEdges(es => es.filter(e => e.id !== edge.id))}>
                    <path d={dp} stroke="transparent" strokeWidth={14} fill="none" />
                    <path d={dp}
                      stroke={mode === 'erase' ? '#ef444488' : eColor}
                      strokeWidth={mode === 'erase' ? 2.5 : 1.5}
                      fill="none" strokeDasharray="6 4"
                      style={{ animation: 'dashFlow 2s linear infinite' }} />
                  </g>
                )
              })}
              {/* Ghost line while connecting */}
              {connecting && ghostPos && (() => {
                const fn = nodes.find(n => n.id === connecting)
                if (!fn) return null
                return <line x1={nodeCx(fn)} y1={nodeCy(fn)} x2={ghostPos.x} y2={ghostPos.y} stroke="#22c55e88" strokeWidth={2} strokeDasharray="8 4" />
              })()}
            </svg>

            {/* Device nodes */}
            {nodes.map(node => {
              const vc = VENDOR_COLORS[node.vendor] || VENDOR_COLORS.other
              const sc = node.status === 'online' ? '#22c55e' : node.status === 'offline' ? '#ef4444' : '#f59e0b'
              const isFrom = connecting === node.id
              return (
                <div key={node.id} data-topo-node="1"
                  style={{
                    position: 'absolute', left: node.x, top: node.y,
                    width: NODE_W, height: NODE_H,
                    background: nBg,
                    border: `1.5px solid ${isFrom ? '#22c55e' : mode === 'connect' ? '#22c55e33' : nBorder}`,
                    borderRadius: 9, overflow: 'hidden', display: 'flex', alignItems: 'stretch',
                    boxShadow: isFrom
                      ? '0 0 0 3px #22c55e44, 0 4px 20px rgba(0,0,0,0.4)'
                      : isDark ? '0 4px 20px rgba(0,0,0,0.5)' : '0 2px 12px rgba(0,0,0,0.1)',
                    cursor: mode === 'select' ? (draggingNode?.id === node.id ? 'grabbing' : 'grab') : 'pointer',
                    transition: 'border-color 0.15s, box-shadow 0.15s',
                  }}
                  onMouseDown={e => handleNodeMouseDown(e, node.id)}
                  onClick={e => handleNodeClick(e, node.id)}
                >
                  {/* Vendor stripe */}
                  <div style={{ width: 5, flexShrink: 0, background: `linear-gradient(180deg, ${vc}, ${vc}aa)`, boxShadow: node.status === 'online' ? `0 0 6px ${vc}88` : 'none' }} />
                  {/* Content */}
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', padding: '8px 8px 8px 10px', gap: 7, minWidth: 0 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: sc, boxShadow: node.status === 'online' ? `0 0 5px ${sc}` : 'none' }} />
                      <div style={{ fontSize: 15, lineHeight: 1 }}>{deviceEmoji(node.device_type, node.vendor)}</div>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: nText, fontWeight: 700, fontSize: 11, fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.hostname}</div>
                      <div style={{ color: nSub, fontSize: 9, fontFamily: 'monospace', marginTop: 1 }}>{node.ip}</div>
                      <div style={{ fontSize: 8, color: vc, marginTop: 2, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{node.vendor}</div>
                    </div>
                  </div>
                  {/* Erase overlay */}
                  {mode === 'erase' && (
                    <div style={{ position: 'absolute', inset: 0, background: '#ef444420', border: '2px solid #ef444466', borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <span style={{ color: '#ef4444', fontSize: 22, fontWeight: 900, lineHeight: 1 }}>×</span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Empty state */}
          {nodes.length === 0 && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
              <div style={{ fontSize: 52, opacity: 0.1, marginBottom: 14 }}>🗺</div>
              <div style={{ fontSize: 13, color: isDark ? '#334155' : '#94a3b8', textAlign: 'center', lineHeight: 1.8 }}>
                Soldan cihazları sürükleyip haritaya bırakın<br />
                <span style={{ fontSize: 11 }}>İsteğe bağlı kat planı veya bina görseli yükleyebilirsiniz</span>
              </div>
            </div>
          )}
        </div>

        {/* Legend bar */}
        <div style={{ padding: '6px 14px', borderTop: `1px solid ${isDark ? '#0e1420' : '#e2e8f0'}`, background: isDark ? '#070b14' : '#f8fafc', display: 'flex', gap: 14, alignItems: 'center', flexShrink: 0, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 12 }}>
            {([['#22c55e', 'Online'], ['#ef4444', 'Offline'], ['#f59e0b', 'Bilinmiyor']] as [string, string][]).map(([c, l]) => (
              <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <div style={{ width: 7, height: 7, borderRadius: '50%', background: c }} />
                <span style={{ fontSize: 10, color: isDark ? '#475569' : '#94a3b8' }}>{l}</span>
              </div>
            ))}
          </div>
          <div style={{ width: 1, height: 14, background: sideBorder }} />
          <span style={{ fontSize: 10, color: isDark ? '#334155' : '#94a3b8' }}>{modeHints[mode]}</span>
        </div>
      </div>
    </div>
  )
}

// ── OpenStreetMap Topology View ───────────────────────────────────────────────

interface MapNode {
  id: string; deviceId: number; hostname: string; ip: string
  vendor: string; status: string; device_type: string
  lat: number; lng: number
}
interface MapEdge {
  id: string; from: string; to: string
  fromPort?: string; toPort?: string
  fromDevice?: string; toDevice?: string
}
interface MapRackNode { id: string; rackName: string; lat: number; lng: number }
interface MapTopoState { nodes: MapNode[]; edges: MapEdge[]; rackNodes?: MapRackNode[] }

const MAP_KEY = 'nm-osm-topo-v2'
function loadMapTopo(): MapTopoState {
  try { const s = localStorage.getItem(MAP_KEY); return s ? JSON.parse(s) : { nodes: [], edges: [], rackNodes: [] } }
  catch { return { nodes: [], edges: [], rackNodes: [] } }
}
function saveMapTopo(st: MapTopoState) {
  try { localStorage.setItem(MAP_KEY, JSON.stringify(st)) } catch {}
}

type MapLayouts = { [name: string]: MapTopoState }
const LAYOUTS_KEY = 'nm-osm-layouts-v1'
function loadLayouts(): MapLayouts {
  try { const s = localStorage.getItem(LAYOUTS_KEY); return s ? JSON.parse(s) : {} }
  catch { return {} }
}
function saveLayouts(ls: MapLayouts) {
  try { localStorage.setItem(LAYOUTS_KEY, JSON.stringify(ls)) } catch {}
}

function makeDeviceIcon(vendor: string, status: string, highlighted: boolean, erasing: boolean): L.DivIcon {
  const vc = VENDOR_COLORS[vendor] || VENDOR_COLORS.other
  const sc = status === 'online' ? '#22c55e' : status === 'offline' ? '#ef4444' : '#f59e0b'
  const border = highlighted ? '#22c55e' : erasing ? '#ef4444' : vc
  const ring = highlighted ? `box-shadow:0 0 0 4px #22c55e44,0 3px 12px rgba(0,0,0,0.35)` : `box-shadow:0 2px 10px rgba(0,0,0,0.3)`
  return L.divIcon({
    className: '',
    html: `<div style="width:34px;height:34px;background:white;border:2.5px solid ${border};border-radius:50%;display:flex;align-items:center;justify-content:center;${ring};position:relative">
      <div style="width:10px;height:10px;border-radius:50%;background:${sc};${status === 'online' ? `box-shadow:0 0 5px ${sc}` : ''}"></div>
      <div style="position:absolute;bottom:-1px;right:-1px;width:11px;height:11px;border-radius:50%;background:${vc};border:2px solid white"></div>
    </div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    popupAnchor: [0, -20],
  })
}

function MapClickHandler({ onMapClick }: { onMapClick: (lat: number, lng: number) => void }) {
  useMapEvents({ click: e => onMapClick(e.latlng.lat, e.latlng.lng) })
  return null
}

function makeRackIcon(erasing: boolean): L.DivIcon {
  const border = erasing ? '#ef4444' : '#7c3aed'
  const bg = erasing ? '#ef444420' : '#7c3aed18'
  return L.divIcon({
    className: '',
    html: `<div style="width:36px;height:40px;background:white;border:2.5px solid ${border};border-radius:6px;display:flex;flex-direction:column;align-items:center;justify-content:center;box-shadow:0 2px 10px rgba(0,0,0,0.3);background:${bg};gap:3px;padding:4px 5px">
      ${[0,1,2,3].map(i => `<div style="width:24px;height:5px;background:${border};border-radius:2px;opacity:${0.9 - i*0.15}"></div>`).join('')}
    </div>`,
    iconSize: [36, 40],
    iconAnchor: [18, 20],
    popupAnchor: [0, -22],
  })
}

function MapController({ mapRef }: { mapRef: React.MutableRefObject<L.Map | null> }) {
  const map = useMap()
  useEffect(() => { mapRef.current = map }, [map, mapRef])
  return null
}

type SelectedDeviceInfo = { deviceId: number; hostname: string; ip: string; vendor: string; status: string; model?: string }

function PhysicalMapView({ isDark, devices, racks }: {
  isDark: boolean
  devices: Device[]
  racks: Array<{ rack_name: string; total_u: number; used_u: number; device_count: number }>
}) {
  const { message } = App.useApp()
  const [nodes, setNodes] = useState<MapNode[]>(() => loadMapTopo().nodes)
  const [edges, setEdges] = useState<MapEdge[]>(() => loadMapTopo().edges)
  const [rackNodes, setRackNodes] = useState<MapRackNode[]>(() => loadMapTopo().rackNodes ?? [])
  const [mode, setMode] = useState<'place' | 'connect' | 'erase'>('place')
  const [tileMode, setTileMode] = useState<'standard' | 'satellite' | 'dark'>('standard')
  const [pending, setPending] = useState<Device | null>(null)
  const [pendingRack, setPendingRack] = useState<string | null>(null)
  const [sidebarTab, setSidebarTab] = useState<'devices' | 'racks'>('devices')
  const [selectedDevice, setSelectedDevice] = useState<SelectedDeviceInfo | null>(null)
  const [selectedRackName, setSelectedRackName] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchLoading, setSearchLoading] = useState(false)
  const [portVlanModal, setPortVlanModal] = useState<{ iface: NetworkInterface } | null>(null)
  const [portVlanForm] = Form.useForm()
  const mapRef = useRef<L.Map | null>(null)

  // Layout save/load
  const [savedLayouts, setSavedLayouts] = useState<MapLayouts>(() => loadLayouts())
  const [layoutDrawerOpen, setLayoutDrawerOpen] = useState(false)
  const [saveNameInput, setSaveNameInput] = useState('')

  // Port-pick wizard for connect mode
  interface PortPickModal {
    phase: 'from' | 'to'
    nodeId: string
    nodeType: 'device' | 'rack'
    deviceId?: number
    hostname?: string
  }
  interface ConnectingFrom {
    nodeId: string
    nodeType: 'device' | 'rack'
    deviceId?: number
    hostname?: string
    port?: string
  }
  const [portPickModal, setPortPickModal] = useState<PortPickModal | null>(null)
  const [connectingFrom, setConnectingFrom] = useState<ConnectingFrom | null>(null)
  const [ppDeviceId, setPpDeviceId] = useState<number | null>(null)
  const [ppPort, setPpPort] = useState<string>('')
  const [ppHostname, setPpHostname] = useState<string>('')

  useEffect(() => { saveMapTopo({ nodes, edges, rackNodes }) }, [nodes, edges, rackNodes])

  const placedIds = useMemo(() => new Set(nodes.map(n => n.deviceId)), [nodes])
  const placedRackNames = useMemo(() => new Set(rackNodes.map(r => r.rackName)), [rackNodes])

  const { data: deviceIfaceData, isLoading: deviceIfaceLoading, refetch: refetchDeviceIfaces } = useQuery({
    queryKey: ['mapview-device-interfaces', selectedDevice?.deviceId],
    queryFn: () => devicesApi.getInterfaces(selectedDevice!.deviceId),
    enabled: !!selectedDevice,
  })

  const { data: rackDetailData, isLoading: rackDetailLoading } = useQuery({
    queryKey: ['mapview-rack-detail', selectedRackName],
    queryFn: () => racksApi.get(selectedRackName!),
    enabled: !!selectedRackName,
  })

  // Port-pick wizard queries
  const ppRackName = useMemo(() => {
    if (!portPickModal || portPickModal.nodeType !== 'rack') return null
    return rackNodes.find(r => r.id === portPickModal.nodeId)?.rackName ?? null
  }, [portPickModal, rackNodes])

  const { data: ppRackData, isLoading: ppRackLoading } = useQuery({
    queryKey: ['pp-rack', ppRackName],
    queryFn: () => racksApi.get(ppRackName!),
    enabled: !!ppRackName,
  })

  const { data: ppIfaceData, isLoading: ppIfaceLoading } = useQuery({
    queryKey: ['pp-ifaces', ppDeviceId],
    queryFn: () => devicesApi.getInterfaces(ppDeviceId!),
    enabled: !!ppDeviceId,
  })

  const togglePortMutation = useMutation({
    mutationFn: ({ name, action }: { name: string; action: 'shutdown' | 'no-shutdown' }) =>
      devicesApi.toggleInterface(selectedDevice!.deviceId, name, action),
    onSuccess: (res) => {
      if (res.success) { message.success('Port durumu değiştirildi'); refetchDeviceIfaces() }
      else message.error(res.error || 'İşlem başarısız')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata'),
  })

  const assignPortVlanMutation = useMutation({
    mutationFn: (vals: { vlan_id: number; mode: 'access' | 'trunk' }) =>
      devicesApi.assignVlan(selectedDevice!.deviceId, portVlanModal!.iface.name, vals.vlan_id, vals.mode),
    onSuccess: (res) => {
      if (res.success) { message.success('VLAN atandı'); setPortVlanModal(null); portVlanForm.resetFields(); refetchDeviceIfaces() }
      else message.error(res.error || 'VLAN atanamadı')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata'),
  })

  const handleSearch = async () => {
    if (!searchQuery.trim()) return
    setSearchLoading(true)
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchQuery)}&limit=1`)
      const data = await res.json()
      if (data[0]) mapRef.current?.flyTo([parseFloat(data[0].lat), parseFloat(data[0].lon)], 14, { duration: 1.5 })
      else message.warning('Konum bulunamadı')
    } catch {
      message.error('Arama başarısız')
    } finally {
      setSearchLoading(false)
    }
  }

  const handleSaveLayout = () => {
    const name = saveNameInput.trim()
    if (!name) return
    const updated = { ...savedLayouts, [name]: { nodes, edges, rackNodes } }
    setSavedLayouts(updated)
    saveLayouts(updated)
    setSaveNameInput('')
    message.success(`"${name}" kaydedildi`)
  }

  const handleLoadLayout = (name: string) => {
    const layout = savedLayouts[name]
    if (!layout) return
    setNodes(layout.nodes)
    setEdges(layout.edges)
    setRackNodes(layout.rackNodes ?? [])
    setLayoutDrawerOpen(false)
    message.success(`"${name}" yüklendi`)
    const allPoints = [
      ...layout.nodes.map(n => [n.lat, n.lng] as L.LatLngTuple),
      ...(layout.rackNodes ?? []).map(r => [r.lat, r.lng] as L.LatLngTuple),
    ]
    if (allPoints.length > 0) {
      setTimeout(() => {
        const bounds = L.latLngBounds(allPoints)
        mapRef.current?.flyToBounds(bounds, { padding: [60, 60], duration: 1.2, maxZoom: 17 })
      }, 120)
    }
  }

  const handleDeleteLayout = (name: string) => {
    const { [name]: _, ...rest } = savedLayouts
    setSavedLayouts(rest)
    saveLayouts(rest)
  }

  const openPortPick = (phase: 'from' | 'to', nodeId: string, nodeType: 'device' | 'rack', deviceId?: number, hostname?: string) => {
    setPpDeviceId(nodeType === 'device' ? (deviceId ?? null) : null)
    setPpPort('')
    setPpHostname(hostname ?? '')
    setPortPickModal({ phase, nodeId, nodeType, deviceId, hostname })
  }

  const handlePortPickConfirm = (skipPort?: boolean) => {
    if (!portPickModal) return
    const port = skipPort ? undefined : (ppPort || undefined)
    const devId = ppDeviceId ?? undefined
    const hostname = ppHostname

    if (portPickModal.phase === 'from') {
      setConnectingFrom({ nodeId: portPickModal.nodeId, nodeType: portPickModal.nodeType, deviceId: devId, hostname, port })
      setPortPickModal(null)
      setPpDeviceId(null); setPpPort(''); setPpHostname('')
    } else if (portPickModal.phase === 'to' && connectingFrom) {
      const fromId = connectingFrom.nodeId
      const toId = portPickModal.nodeId
      const dup = edges.some(e => (e.from === fromId && e.to === toId) || (e.from === toId && e.to === fromId))
      if (!dup) {
        setEdges(es => [...es, {
          id: `me${Date.now()}`, from: fromId, to: toId,
          fromPort: connectingFrom.port, toPort: port,
          fromDevice: connectingFrom.hostname, toDevice: hostname,
        }])
      } else {
        message.warning('Bu bağlantı zaten mevcut')
      }
      setConnectingFrom(null)
      setPortPickModal(null)
      setPpDeviceId(null); setPpPort(''); setPpHostname('')
    }
  }

  const handleMapClick = (lat: number, lng: number) => {
    if (mode !== 'place') return
    if (pendingRack) {
      setRackNodes(rns => [...rns, { id: `rn${Date.now()}`, rackName: pendingRack, lat, lng }])
      setPendingRack(null)
      return
    }
    if (pending && !placedIds.has(pending.id)) {
      setNodes(ns => [...ns, {
        id: `mn${Date.now()}`,
        deviceId: pending.id, hostname: pending.hostname, ip: pending.ip_address,
        vendor: pending.vendor, status: pending.status, device_type: pending.device_type,
        lat, lng,
      }])
      setPending(null)
    }
  }

  const handleMarkerClick = (nodeId: string) => {
    if (mode === 'erase') {
      setNodes(ns => ns.filter(n => n.id !== nodeId))
      setEdges(es => es.filter(e => e.from !== nodeId && e.to !== nodeId))
      return
    }
    if (mode === 'connect') {
      const node = nodes.find(n => n.id === nodeId)
      if (!node) return
      if (!connectingFrom) {
        openPortPick('from', nodeId, 'device', node.deviceId, node.hostname)
      } else if (connectingFrom.nodeId !== nodeId) {
        openPortPick('to', nodeId, 'device', node.deviceId, node.hostname)
      }
      return
    }
    // place mode → open management panel
    const node = nodes.find(n => n.id === nodeId)
    if (node) setSelectedDevice({ deviceId: node.deviceId, hostname: node.hostname, ip: node.ip, vendor: node.vendor, status: node.status })
  }

  const handleRackMarkerClick = (rackNodeId: string) => {
    if (mode === 'erase') {
      setRackNodes(rns => rns.filter(rn => rn.id !== rackNodeId))
      return
    }
    if (mode === 'connect') {
      if (!connectingFrom) {
        openPortPick('from', rackNodeId, 'rack')
      } else if (connectingFrom.nodeId !== rackNodeId) {
        openPortPick('to', rackNodeId, 'rack')
      }
      return
    }
    // place mode → open rack detail
    const rn = rackNodes.find(r => r.id === rackNodeId)
    if (rn) setSelectedRackName(rn.rackName)
  }

  const sideBorder = isDark ? '#1e2a3a' : '#e2e8f0'
  const nText = isDark ? '#e2e8f0' : '#1e293b'
  const nSub = isDark ? '#475569' : '#94a3b8'
  const sidebarBg = isDark ? '#0a0f18' : '#ffffff'
  const cardBg = isDark ? '#0e1e38' : '#ffffff'
  const borderCol = isDark ? '#1a3458' : '#e2e8f0'
  const textPrimary = isDark ? '#e2e8f0' : '#1e293b'
  const textSecondary = isDark ? '#64748b' : '#64748b'

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 230px)', minHeight: 480, border: `1px solid ${sideBorder}`, borderRadius: 12, overflow: 'hidden' }}>

      {/* Sidebar */}
      <div style={{ width: 200, borderRight: `1px solid ${sideBorder}`, display: 'flex', flexDirection: 'column', background: sidebarBg, flexShrink: 0 }}>
        <div style={{ padding: '8px 10px', borderBottom: `1px solid ${sideBorder}` }}>
          <Button.Group size="small" style={{ display: 'flex' }}>
            <Button size="small" type={sidebarTab === 'devices' ? 'primary' : 'default'} style={{ flex: 1, fontSize: 10 }}
              onClick={() => { setSidebarTab('devices'); setPendingRack(null) }}>Cihazlar</Button>
            <Button size="small" type={sidebarTab === 'racks' ? 'primary' : 'default'} style={{ flex: 1, fontSize: 10 }}
              onClick={() => { setSidebarTab('racks'); setPending(null) }}>Kabinler</Button>
          </Button.Group>
        </div>
        <div style={{ padding: '8px 10px', borderBottom: `1px solid ${sideBorder}` }}>
          <Button.Group size="small" style={{ display: 'flex' }}>
            <Button size="small" type={mode === 'place' ? 'primary' : 'default'} style={{ flex: 1, fontSize: 10 }}
              onClick={() => { setMode('place'); setConnectingFrom(null) }}>Yerleştir</Button>
            <Button size="small" type={mode === 'connect' ? 'primary' : 'default'}
              style={mode === 'connect' ? { flex: 1, fontSize: 10, background: '#22c55e', borderColor: '#22c55e' } : { flex: 1, fontSize: 10 }}
              onClick={() => { setMode('connect'); setConnectingFrom(null); setPending(null); setPendingRack(null) }}>Bağla</Button>
            <Button size="small" type={mode === 'erase' ? 'primary' : 'default'} danger={mode === 'erase'}
              style={{ flex: 1, fontSize: 10 }}
              onClick={() => { setMode('erase'); setConnectingFrom(null); setPending(null); setPendingRack(null) }}>Sil</Button>
          </Button.Group>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {sidebarTab === 'devices' ? (
            devices.length === 0 ? (
              <div style={{ padding: 16, textAlign: 'center', color: nSub, fontSize: 11 }}>Yükleniyor…</div>
            ) : devices.map(d => {
              const vc = VENDOR_COLORS[d.vendor] || VENDOR_COLORS.other
              const placed = placedIds.has(d.id)
              const isSel = pending?.id === d.id
              return (
                <div key={d.id}
                  onClick={() => !placed && mode === 'place' && setPending(isSel ? null : d)}
                  style={{
                    padding: '7px 10px', cursor: !placed && mode === 'place' ? 'pointer' : 'default',
                    opacity: placed ? 0.4 : 1, display: 'flex', alignItems: 'center', gap: 6,
                    borderBottom: `1px solid ${isDark ? '#0e1420' : '#f1f5f9'}`,
                    background: isSel ? (isDark ? '#1d4ed820' : '#eff6ff') : 'transparent',
                    borderLeft: isSel ? '3px solid #3b82f6' : '3px solid transparent',
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={e => { if (!placed && mode === 'place' && !isSel) (e.currentTarget as HTMLElement).style.background = isDark ? '#111827' : '#f8fafc' }}
                  onMouseLeave={e => { if (!isSel) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                >
                  <div style={{ width: 3, height: 26, borderRadius: 2, background: vc, flexShrink: 0 }} />
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: d.status === 'online' ? '#22c55e' : d.status === 'offline' ? '#ef4444' : '#f59e0b', flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: nText, fontSize: 10, fontWeight: 600, fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.hostname}</div>
                    <div style={{ color: nSub, fontSize: 9 }}>{d.ip_address}</div>
                  </div>
                  {placed && <div style={{ fontSize: 8, color: '#22c55e', background: '#22c55e18', borderRadius: 3, padding: '1px 4px', flexShrink: 0, border: '1px solid #22c55e33' }}>✓</div>}
                </div>
              )
            })
          ) : (
            racks.length === 0 ? (
              <div style={{ padding: 16, textAlign: 'center', color: nSub, fontSize: 11 }}>Kabin yok</div>
            ) : racks.map(r => {
              const placed = placedRackNames.has(r.rack_name)
              const isSel = pendingRack === r.rack_name
              return (
                <div key={r.rack_name}
                  onClick={() => !placed && mode === 'place' && setPendingRack(isSel ? null : r.rack_name)}
                  style={{
                    padding: '7px 10px', cursor: !placed && mode === 'place' ? 'pointer' : 'default',
                    opacity: placed ? 0.4 : 1, display: 'flex', alignItems: 'center', gap: 6,
                    borderBottom: `1px solid ${isDark ? '#0e1420' : '#f1f5f9'}`,
                    background: isSel ? (isDark ? '#7c3aed20' : '#f5f3ff') : 'transparent',
                    borderLeft: isSel ? '3px solid #7c3aed' : '3px solid transparent',
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={e => { if (!placed && mode === 'place' && !isSel) (e.currentTarget as HTMLElement).style.background = isDark ? '#111827' : '#f8fafc' }}
                  onMouseLeave={e => { if (!isSel) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                >
                  <HddOutlined style={{ color: isSel ? '#7c3aed' : '#64748b', fontSize: 13, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: nText, fontSize: 10, fontWeight: 600, fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.rack_name}</div>
                    <div style={{ color: nSub, fontSize: 9 }}>{r.device_count} cihaz · {r.used_u}/{r.total_u}U</div>
                  </div>
                  {placed && <div style={{ fontSize: 8, color: '#7c3aed', background: '#7c3aed18', borderRadius: 3, padding: '1px 4px', flexShrink: 0, border: '1px solid #7c3aed33' }}>✓</div>}
                </div>
              )
            })
          )}
        </div>

        <div style={{ padding: '8px 10px', borderTop: `1px solid ${sideBorder}` }}>
          <div style={{ fontSize: 9, color: nSub, marginBottom: 6, textAlign: 'center' }}>
            {nodes.length} cihaz · {rackNodes.length} kabin · {edges.length} bağlantı
          </div>
          <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
            <Button size="small" icon={<SaveOutlined />} style={{ flex: 1, fontSize: 10 }} onClick={() => setLayoutDrawerOpen(true)}>Kayıtlar</Button>
          </div>
          <Popconfirm title="Harita sıfırlansın mı?" onConfirm={() => { setNodes([]); setEdges([]); setRackNodes([]) }} okText="Evet" cancelText="İptal" okButtonProps={{ danger: true }}>
            <Button size="small" danger block>Temizle</Button>
          </Popconfirm>
        </div>
      </div>

      {/* Map area */}
      <div style={{ flex: 1, position: 'relative' }}>
        {(pending || pendingRack) && (
          <div style={{
            position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
            background: pendingRack ? '#7c3aed' : '#3b82f6', color: 'white', padding: '7px 18px', borderRadius: 20,
            fontSize: 12, fontWeight: 600, zIndex: 1000, pointerEvents: 'none',
            boxShadow: `0 2px 14px rgba(${pendingRack ? '124,58,237' : '59,130,246'},0.5)`, whiteSpace: 'nowrap',
          }}>
            📍 {pendingRack ? `"${pendingRack}" kabini` : `"${pending!.hostname}"`} — Haritada bir konuma tıkla
          </div>
        )}
        {connectingFrom && !portPickModal && (
          <div style={{
            position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
            background: '#22c55e', color: 'white', padding: '7px 18px', borderRadius: 20,
            fontSize: 12, fontWeight: 600, zIndex: 1000, pointerEvents: 'none',
            boxShadow: '0 2px 14px rgba(34,197,94,0.5)', whiteSpace: 'nowrap',
          }}>
            🔗 {connectingFrom.hostname ?? rackNodes.find(r => r.id === connectingFrom.nodeId)?.rackName}
            {connectingFrom.port ? ` [${connectingFrom.port}]` : ''} → Hedef noktaya tıkla
          </div>
        )}

        {/* Tile mode toggle */}
        <div style={{ position: 'absolute', bottom: 32, left: 12, zIndex: 1000, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {([
            { key: 'standard', label: '🗺 Harita' },
            { key: 'satellite', label: '🛰 Uydu' },
            { key: 'dark', label: '🌙 Koyu' },
          ] as const).map(item => (
            <button
              key={item.key}
              onClick={() => setTileMode(item.key)}
              style={{
                padding: '5px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer',
                borderRadius: 6, border: '1px solid',
                borderColor: tileMode === item.key ? '#3b82f6' : 'rgba(0,0,0,0.18)',
                background: tileMode === item.key ? '#3b82f6' : 'rgba(255,255,255,0.92)',
                color: tileMode === item.key ? 'white' : '#334155',
                boxShadow: tileMode === item.key ? '0 2px 8px rgba(59,130,246,0.4)' : '0 1px 4px rgba(0,0,0,0.12)',
                transition: 'all 0.18s',
              }}
            >
              {item.label}
            </button>
          ))}
        </div>

        {/* Location search overlay */}
        <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 1000, display: 'flex', gap: 6 }}>
          <Input
            placeholder="Konum ara…"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onPressEnter={handleSearch}
            style={{ width: 200 }}
            prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
            size="small"
          />
          <Button size="small" loading={searchLoading} onClick={handleSearch} type="primary">Ara</Button>
        </div>

        <MapContainer center={[39.9334, 32.8597] as L.LatLngTuple} zoom={6} style={{ height: '100%', width: '100%' }}>
          <TileLayer
            key={tileMode}
            attribution={
              tileMode === 'satellite'
                ? 'Tiles &copy; Esri &mdash; Source: Esri, USGS, AeroGRID, IGN'
                : '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
            }
            url={
              tileMode === 'satellite'
                ? 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
                : tileMode === 'dark'
                  ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
                  : (isDark
                      ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
                      : 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png')
            }
            maxZoom={tileMode === 'satellite' ? 19 : 20}
          />
          <MapClickHandler onMapClick={handleMapClick} />
          <MapController mapRef={mapRef} />

          {edges.map(edge => {
            const fnNode = nodes.find(n => n.id === edge.from)
            const tnNode = nodes.find(n => n.id === edge.to)
            const fnRack = rackNodes.find(r => r.id === edge.from)
            const tnRack = rackNodes.find(r => r.id === edge.to)
            const fromPos = fnNode ?? fnRack
            const toPos   = tnNode ?? tnRack
            if (!fromPos || !toPos) return null
            const portLabel = (edge.fromDevice || edge.toDevice)
              ? `${edge.fromDevice ?? '?'}${edge.fromPort ? ':' + edge.fromPort : ''} ↔ ${edge.toDevice ?? '?'}${edge.toPort ? ':' + edge.toPort : ''}`
              : undefined
            return (
              <Polyline key={edge.id}
                positions={[[fromPos.lat, fromPos.lng], [toPos.lat, toPos.lng]]}
                pathOptions={{ color: mode === 'erase' ? '#ef4444' : '#3b82f6', weight: mode === 'erase' ? 3.5 : 2.5, opacity: 0.8, dashArray: '8 5' }}
                eventHandlers={{ click: () => mode === 'erase' && setEdges(es => es.filter(e => e.id !== edge.id)) }}
              >
                {portLabel && (
                  <LeafletTooltip sticky direction="top" opacity={0.9}>
                    <span style={{ fontFamily: 'monospace', fontSize: 10 }}>{portLabel}</span>
                  </LeafletTooltip>
                )}
              </Polyline>
            )
          })}

          {nodes.map(node => (
            <Marker key={node.id}
              position={[node.lat, node.lng] as L.LatLngTuple}
              icon={makeDeviceIcon(node.vendor, node.status, connectingFrom?.nodeId === node.id, mode === 'erase')}
              draggable={mode === 'place'}
              eventHandlers={{
                click: () => handleMarkerClick(node.id),
                dragend: (e: L.DragEndEvent) => {
                  const pos = (e.target as L.Marker).getLatLng()
                  setNodes(ns => ns.map(n => n.id === node.id ? { ...n, lat: pos.lat, lng: pos.lng } : n))
                },
              }}
            >
              <LeafletTooltip permanent direction="top" offset={[0, -20]} opacity={0.9}>
                <span style={{ fontFamily: 'monospace', fontSize: 10, fontWeight: 700 }}>{node.hostname}</span>
              </LeafletTooltip>
            </Marker>
          ))}

          {rackNodes.map(rn => (
            <Marker key={rn.id}
              position={[rn.lat, rn.lng] as L.LatLngTuple}
              icon={makeRackIcon(mode === 'erase')}
              draggable={mode === 'place'}
              eventHandlers={{
                click: () => handleRackMarkerClick(rn.id),
                dragend: (e: L.DragEndEvent) => {
                  const pos = (e.target as L.Marker).getLatLng()
                  setRackNodes(rns => rns.map(r => r.id === rn.id ? { ...r, lat: pos.lat, lng: pos.lng } : r))
                },
              }}
            >
              <LeafletTooltip permanent direction="top" offset={[0, -22]} opacity={0.9}>
                <span style={{ fontFamily: 'monospace', fontSize: 10, fontWeight: 700 }}>{rn.rackName}</span>
              </LeafletTooltip>
            </Marker>
          ))}
        </MapContainer>
      </div>

      {/* Device Management Drawer */}
      <Drawer
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ color: textPrimary, fontWeight: 700 }}>{selectedDevice?.hostname}</span>
            {selectedDevice && <Tag color={selectedDevice.status === 'online' ? 'green' : 'red'} style={{ fontSize: 10 }}>{selectedDevice.status}</Tag>}
            {selectedDevice && <span style={{ color: textSecondary, fontSize: 11 }}>{selectedDevice.ip}</span>}
          </div>
        }
        open={!!selectedDevice}
        onClose={() => { setSelectedDevice(null); setPortVlanModal(null) }}
        width={900}
        styles={{
          body: { background: isDark ? '#070b14' : '#f1f5f9', padding: 16 },
          header: { background: cardBg, borderBottom: `1px solid ${borderCol}` },
        }}
        extra={<Button icon={<ReloadOutlined />} size="small" loading={deviceIfaceLoading} onClick={() => refetchDeviceIfaces()}>Yenile</Button>}
      >
        {deviceIfaceLoading ? (
          <div style={{ textAlign: 'center', padding: 48 }}><Spin /></div>
        ) : !deviceIfaceData?.success ? (
          <Typography.Text type="danger" style={{ padding: 16, display: 'block' }}>
            {deviceIfaceData?.error || 'Portlar alınamadı. SSH bağlantısını kontrol edin.'}
          </Typography.Text>
        ) : (
          <SwitchPortPanel
            ports={deviceIfaceData.interfaces}
            isPending={togglePortMutation.isPending}
            deviceModel={selectedDevice?.model}
            deviceVendor={selectedDevice?.vendor}
            onTogglePort={(name, action) => togglePortMutation.mutate({ name, action })}
            onAssignVlan={(iface) => { setPortVlanModal({ iface }); portVlanForm.resetFields() }}
          />
        )}
      </Drawer>

      {/* Rack Detail Drawer */}
      <Drawer
        title={<span style={{ color: textPrimary }}>📦 Kabin: {selectedRackName}</span>}
        open={!!selectedRackName}
        onClose={() => setSelectedRackName(null)}
        width={520}
        styles={{
          body: { background: isDark ? '#070b14' : '#f1f5f9', padding: 16 },
          header: { background: cardBg, borderBottom: `1px solid ${borderCol}` },
        }}
      >
        {rackDetailLoading ? (
          <div style={{ textAlign: 'center', padding: 48 }}><Spin /></div>
        ) : rackDetailData ? (
          <div>
            <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
              {[
                { l: 'TOPLAM', v: `${rackDetailData.total_u}U`, c: '#64748b' },
                { l: 'CİHAZ', v: rackDetailData.devices.length, c: '#3b82f6' },
                { l: 'ÖĞE', v: rackDetailData.items.length, c: '#7c3aed' },
              ].map(s => (
                <div key={s.l} style={{
                  background: isDark ? `${s.c}11` : '#f8fafc', border: `1px solid ${isDark ? s.c + '28' : borderCol}`,
                  borderTop: `2px solid ${s.c}`, borderRadius: 8, padding: '8px 14px', textAlign: 'center', minWidth: 80,
                }}>
                  <div style={{ fontSize: 18, fontWeight: 800, color: s.c, fontFamily: 'monospace' }}>{s.v}</div>
                  <div style={{ fontSize: 9, color: textSecondary, letterSpacing: '0.08em', marginTop: 1 }}>{s.l}</div>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 11, fontWeight: 700, color: textSecondary, letterSpacing: '0.08em', marginBottom: 8 }}>CİHAZLAR</div>
            {rackDetailData.devices.length === 0 ? (
              <Empty description="Bu kabinde cihaz yok" />
            ) : rackDetailData.devices.map(d => {
              const vc = VENDOR_COLORS[d.vendor] || VENDOR_COLORS.other
              return (
                <div key={d.id} style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
                  background: cardBg, border: `1px solid ${borderCol}`, borderRadius: 8, marginBottom: 8,
                  borderLeft: `4px solid ${vc}`,
                }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: d.status === 'online' ? '#22c55e' : d.status === 'offline' ? '#ef4444' : '#f59e0b' }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: textPrimary, fontWeight: 700, fontSize: 12, fontFamily: 'monospace' }}>{d.hostname}</div>
                    <div style={{ color: textSecondary, fontSize: 10 }}>{d.ip_address} · U{d.rack_unit}</div>
                  </div>
                  <div style={{ fontSize: 9, color: vc, background: `${vc}22`, border: `1px solid ${vc}44`, borderRadius: 4, padding: '2px 6px', fontWeight: 700, flexShrink: 0 }}>
                    {d.vendor.toUpperCase()}
                  </div>
                  <Button size="small" icon={<EyeOutlined />}
                    onClick={() => setSelectedDevice({ deviceId: d.id, hostname: d.hostname, ip: d.ip_address, vendor: d.vendor, status: d.status, model: d.model ?? undefined })}>
                    Yönet
                  </Button>
                </div>
              )
            })}
          </div>
        ) : null}
      </Drawer>

      {/* Port VLAN Modal */}
      <Modal
        title={<span style={{ color: textPrimary }}>VLAN Ata — {portVlanModal?.iface.name}</span>}
        open={!!portVlanModal}
        onCancel={() => { setPortVlanModal(null); portVlanForm.resetFields() }}
        onOk={() => portVlanForm.submit()}
        confirmLoading={assignPortVlanMutation.isPending}
        okText="Ata" cancelText="İptal"
        styles={{
          content: { background: cardBg, border: `1px solid ${borderCol}` },
          header: { background: cardBg, borderBottom: `1px solid ${borderCol}` },
        }}
      >
        <Form form={portVlanForm} layout="vertical" initialValues={{ mode: 'access' }} onFinish={assignPortVlanMutation.mutate}>
          <Form.Item name="vlan_id" label="VLAN ID" rules={[{ required: true, message: 'VLAN ID gerekli' }]}>
            <InputNumber min={1} max={4094} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="mode" label="Mod" rules={[{ required: true }]}>
            <Select options={[{ label: 'Access', value: 'access' }, { label: 'Trunk', value: 'trunk' }]} />
          </Form.Item>
        </Form>
      </Modal>

      {/* Layout Save/Load Drawer */}
      <Drawer
        title={<span style={{ color: textPrimary }}>💾 Harita Kayıtları</span>}
        open={layoutDrawerOpen}
        onClose={() => { setLayoutDrawerOpen(false); setSaveNameInput('') }}
        width={360}
        styles={{
          body: { background: isDark ? '#070b14' : '#f1f5f9', padding: 16 },
          header: { background: cardBg, borderBottom: `1px solid ${borderCol}` },
        }}
      >
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: textSecondary, letterSpacing: '0.08em', marginBottom: 8 }}>MEVCUT DURUMU KAYDET</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <Input
              placeholder="Kayıt adı (örn: İstanbul Merkez)"
              value={saveNameInput}
              onChange={e => setSaveNameInput(e.target.value)}
              onPressEnter={handleSaveLayout}
              size="small"
              style={{ flex: 1 }}
            />
            <Button size="small" type="primary" icon={<SaveOutlined />} onClick={handleSaveLayout} disabled={!saveNameInput.trim()}>
              Kaydet
            </Button>
          </div>
          <div style={{ fontSize: 10, color: textSecondary, marginTop: 4 }}>
            {nodes.length} cihaz · {rackNodes.length} kabin · {edges.length} bağlantı kaydedilecek
          </div>
        </div>

        <div style={{ fontSize: 11, fontWeight: 700, color: textSecondary, letterSpacing: '0.08em', marginBottom: 8 }}>KAYITLI GÖRÜNÜMLER</div>
        {Object.keys(savedLayouts).length === 0 ? (
          <Empty description={<span style={{ color: textSecondary, fontSize: 12 }}>Henüz kayıt yok</span>} />
        ) : Object.entries(savedLayouts).map(([name, layout]) => (
          <div key={name} style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
            background: cardBg, border: `1px solid ${borderCol}`, borderRadius: 8, marginBottom: 8,
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: textPrimary, fontWeight: 600, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
              <div style={{ color: textSecondary, fontSize: 10 }}>
                {layout.nodes.length} cihaz · {(layout.rackNodes ?? []).length} kabin · {layout.edges.length} bağlantı
              </div>
            </div>
            <Button size="small" icon={<FolderOpenOutlined />} onClick={() => handleLoadLayout(name)}>Yükle</Button>
            <Popconfirm title={`"${name}" silinsin mi?`} onConfirm={() => handleDeleteLayout(name)} okText="Evet" cancelText="İptal" okButtonProps={{ danger: true }}>
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          </div>
        ))}
      </Drawer>

      {/* Port-Pick Connection Wizard Modal */}
      <Modal
        title={
          <span style={{ color: textPrimary }}>
            🔗 Bağlantı Noktası — {portPickModal?.phase === 'from' ? 'Kaynak' : 'Hedef'}
            {portPickModal?.hostname ? ` (${portPickModal.hostname})` : portPickModal?.nodeType === 'rack' ? ` (${rackNodes.find(r => r.id === portPickModal?.nodeId)?.rackName})` : ''}
          </span>
        }
        open={!!portPickModal}
        onCancel={() => {
          setPortPickModal(null)
          setPpDeviceId(null); setPpPort(''); setPpHostname('')
          if (portPickModal?.phase === 'to') setConnectingFrom(null)
        }}
        footer={[
          <Button key="skip" onClick={() => handlePortPickConfirm(true)}>
            {portPickModal?.phase === 'from' ? 'Portu Atla →' : 'Portu Atla & Bağla'}
          </Button>,
          <Button key="ok" type="primary"
            disabled={portPickModal?.nodeType === 'rack' ? (!ppDeviceId || !ppPort) : !ppPort}
            onClick={() => handlePortPickConfirm(false)}>
            {portPickModal?.phase === 'from' ? 'İleri →' : 'Bağla'}
          </Button>,
        ]}
        styles={{
          content: { background: cardBg, border: `1px solid ${borderCol}` },
          header: { background: cardBg, borderBottom: `1px solid ${borderCol}` },
        }}
      >
        {/* Step 1: Select device from rack (rack type only) */}
        {portPickModal?.nodeType === 'rack' && !ppDeviceId && (
          <div>
            <div style={{ fontSize: 11, color: textSecondary, marginBottom: 8 }}>Bu kabindeki cihazlardan birini seçin:</div>
            {ppRackLoading ? (
              <div style={{ textAlign: 'center', padding: 24 }}><Spin size="small" /></div>
            ) : (ppRackData?.devices ?? []).length === 0 ? (
              <Empty description="Kabinde cihaz yok" />
            ) : (ppRackData?.devices ?? []).map(d => {
              const vc = VENDOR_COLORS[d.vendor] || VENDOR_COLORS.other
              return (
                <div key={d.id}
                  onClick={() => { setPpDeviceId(d.id); setPpHostname(d.hostname) }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
                    background: isDark ? '#0d1420' : '#f8fafc',
                    border: `1px solid ${borderCol}`, borderRadius: 8, marginBottom: 6,
                    cursor: 'pointer', borderLeft: `4px solid ${vc}`,
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = isDark ? '#111827' : '#eff6ff'}
                  onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = isDark ? '#0d1420' : '#f8fafc'}
                >
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: d.status === 'online' ? '#22c55e' : '#ef4444', flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: textPrimary, fontWeight: 600, fontSize: 12, fontFamily: 'monospace' }}>{d.hostname}</div>
                    <div style={{ color: textSecondary, fontSize: 10 }}>{d.ip_address} · U{d.rack_unit}</div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Step 2: Select port */}
        {ppDeviceId && (
          <div>
            {portPickModal?.nodeType === 'rack' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, padding: '6px 10px', background: isDark ? '#0d1420' : '#f0f9ff', borderRadius: 6, border: `1px solid ${borderCol}` }}>
                <span style={{ color: '#22c55e', fontSize: 11 }}>✓</span>
                <span style={{ color: textPrimary, fontSize: 11, fontFamily: 'monospace', fontWeight: 600 }}>{ppHostname}</span>
                <Button size="small" style={{ marginLeft: 'auto', fontSize: 10 }} onClick={() => { setPpDeviceId(null); setPpPort('') }}>← Geri</Button>
              </div>
            )}
            <div style={{ fontSize: 11, color: textSecondary, marginBottom: 8 }}>Bağlantı portu seçin:</div>
            {ppIfaceLoading ? (
              <div style={{ textAlign: 'center', padding: 24 }}><Spin size="small" /></div>
            ) : (ppIfaceData?.interfaces ?? []).length === 0 ? (
              <Empty description="Port bilgisi alınamadı" />
            ) : (
              <Select
                style={{ width: '100%' }}
                placeholder="Port seçin…"
                value={ppPort || undefined}
                onChange={val => setPpPort(val)}
                showSearch
                optionFilterProp="label"
                options={(ppIfaceData?.interfaces ?? []).map((iface: NetworkInterface) => ({
                  label: `${iface.name}${iface.description ? ' — ' + iface.description : ''}`,
                  value: iface.name,
                }))}
              />
            )}
          </div>
        )}

      </Modal>
    </div>
  )
}

// ── Topology view wrapper (OSM map + floor plan canvas) ───────────────────────
function TopoViewWrapper({ isDark, devices, racks }: {
  isDark: boolean
  devices: Device[]
  racks: Array<{ rack_name: string; total_u: number; used_u: number; device_count: number }>
}) {
  const [sub, setSub] = useState<'osm' | 'floor'>('osm')
  const borderCol = isDark ? '#1e2a3a' : '#e2e8f0'
  const textSub = isDark ? '#64748b' : '#94a3b8'
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <Button.Group size="small">
          <Button type={sub === 'osm' ? 'primary' : 'default'} onClick={() => setSub('osm')}>🗺 Açık Harita</Button>
          <Button type={sub === 'floor' ? 'primary' : 'default'} onClick={() => setSub('floor')}>📐 Kat Planı</Button>
        </Button.Group>
        <span style={{ fontSize: 11, color: textSub, borderLeft: `1px solid ${borderCol}`, paddingLeft: 10 }}>
          {sub === 'osm'
            ? 'OpenStreetMap üzerinde switch, AP ve kabinleri gerçek konumlarına yerleştir'
            : 'Kat planı / bina görseli yükle, iç mekan fiziksel topolojisini oluştur'}
        </span>
      </div>
      {sub === 'osm'
        ? <PhysicalMapView isDark={isDark} devices={devices} racks={racks} />
        : <PhysicalTopoMap isDark={isDark} devices={devices} />
      }
    </div>
  )
}

export default function RacksPage() {
  const { isDark } = useTheme()
  const { activeSite } = useSite()
  const { message, modal } = App.useApp()
  const qc = useQueryClient()

  const [selectedRack, setSelectedRack] = useState<string | null>(null)
  const [view3D, setView3D] = useState(false)
  const [newRackName, setNewRackName] = useState('')
  const [newRackTotalU, setNewRackTotalU] = useState(42)
  const [newRackOpen, setNewRackOpen] = useState(false)

  const [itemDrawerOpen, setItemDrawerOpen] = useState(false)
  const [itemForm] = Form.useForm()
  const [editingItem, setEditingItem] = useState<RackItem | null>(null)
  const [, setDefaultUnit] = useState(1)

  const [assignDrawerOpen, setAssignDrawerOpen] = useState(false)
  const [assignUnit, setAssignUnit] = useState(1)
  const [assignForm] = Form.useForm()

  const [switchDrawerDevice, setSwitchDrawerDevice] = useState<RackDeviceSummary | null>(null)
  const [portVlanModal, setPortVlanModal] = useState<{ iface: NetworkInterface } | null>(null)
  const [portVlanForm] = Form.useForm()

  const { data: racks = [], isLoading: racksLoading } = useQuery({
    queryKey: ['racks', activeSite],
    queryFn: () => racksApi.list({ site: activeSite || undefined }),
  })

  const { data: rackDetail, isLoading: detailLoading } = useQuery({
    queryKey: ['rack-detail', selectedRack],
    queryFn: () => racksApi.get(selectedRack!),
    enabled: !!selectedRack,
  })

  const { data: unassigned = [] } = useQuery({
    queryKey: ['racks-unassigned', activeSite],
    queryFn: () => racksApi.unassigned({ site: activeSite || undefined }),
  })

  const { data: allDevicesData } = useQuery({
    queryKey: ['devices-topo', activeSite],
    queryFn: () => devicesApi.list({ limit: 500, site: activeSite || undefined }),
    staleTime: 60000,
  })
  const allDevices = allDevicesData?.items ?? []

  const { data: snmpTopData } = useQuery({
    queryKey: ['racks-snmp-utilization'],
    queryFn: () => snmpApi.getTopInterfaces({ limit: 500, threshold: 0 }),
    staleTime: 120000,
    refetchInterval: 180000,
  })

  const utilizationMap = React.useMemo(() => {
    const map = new Map<number, UtilizationInfo>()
    for (const iface of snmpTopData?.items ?? []) {
      const existing = map.get(iface.device_id)
      if (!existing || iface.max_pct > existing.maxPct) {
        map.set(iface.device_id, {
          maxPct: Math.round(iface.max_pct),
          inPct:  Math.round(iface.in_pct),
          outPct: Math.round(iface.out_pct),
        })
      }
    }
    return map
  }, [snmpTopData])

  const setPlacement = useMutation({
    mutationFn: ({ deviceId, unit }: { deviceId: number; unit: number }) =>
      racksApi.setPlacement(deviceId, selectedRack!, unit, 1),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rack-detail', selectedRack] })
      qc.invalidateQueries({ queryKey: ['racks-unassigned'] })
      qc.invalidateQueries({ queryKey: ['racks'] })
    },
  })

  const removePlacement = useMutation({
    mutationFn: (deviceId: number) => racksApi.removePlacement(deviceId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rack-detail', selectedRack] })
      qc.invalidateQueries({ queryKey: ['racks-unassigned'] })
      qc.invalidateQueries({ queryKey: ['racks'] })
    },
  })

  const createItem = useMutation({
    mutationFn: (values: Omit<RackItem, 'id' | 'rack_name'>) =>
      racksApi.createItem(selectedRack!, values),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rack-detail', selectedRack] })
      qc.invalidateQueries({ queryKey: ['racks'] })
      setItemDrawerOpen(false)
      itemForm.resetFields()
      message.success('Öğe eklendi')
    },
  })

  const updateItem = useMutation({
    mutationFn: ({ id, values }: { id: number; values: Partial<Omit<RackItem, 'id' | 'rack_name'>> }) =>
      racksApi.updateItem(selectedRack!, id, values),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rack-detail', selectedRack] })
      setItemDrawerOpen(false)
      itemForm.resetFields()
      setEditingItem(null)
      message.success('Öğe güncellendi')
    },
  })

  const deleteItem = useMutation({
    mutationFn: (itemId: number) => racksApi.deleteItem(selectedRack!, itemId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rack-detail', selectedRack] })
      qc.invalidateQueries({ queryKey: ['racks'] })
    },
  })

  const createRack = useMutation({
    mutationFn: (payload: { rack_name: string; total_u: number }) => racksApi.create(payload),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['racks'] })
      setSelectedRack(data.rack_name)
      setNewRackOpen(false)
      setNewRackName('')
      setNewRackTotalU(42)
      message.success(`"${data.rack_name}" kabini oluşturuldu`)
    },
    onError: () => message.error('Kabin oluşturulamadı'),
  })

  const deleteRack = useMutation({
    mutationFn: (rackName: string) => racksApi.deleteRack(rackName),
    onSuccess: (_, rackName) => {
      qc.invalidateQueries({ queryKey: ['racks'] })
      qc.invalidateQueries({ queryKey: ['racks-unassigned'] })
      if (selectedRack === rackName) setSelectedRack(null)
      message.success('Kabin silindi')
    },
  })

  const { data: switchIfaceData, isLoading: switchIfaceLoading, refetch: refetchSwitchIfaces } = useQuery({
    queryKey: ['rack-switch-interfaces', switchDrawerDevice?.id],
    queryFn: () => devicesApi.getInterfaces(switchDrawerDevice!.id),
    enabled: !!switchDrawerDevice,
  })

  const togglePortMutation = useMutation({
    mutationFn: ({ name, action }: { name: string; action: 'shutdown' | 'no-shutdown' }) =>
      devicesApi.toggleInterface(switchDrawerDevice!.id, name, action),
    onSuccess: (res) => {
      if (res.success) { message.success('Port durumu değiştirildi'); refetchSwitchIfaces() }
      else message.error(res.error || 'İşlem başarısız')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata oluştu'),
  })

  const assignPortVlanMutation = useMutation({
    mutationFn: (vals: { vlan_id: number; mode: 'access' | 'trunk' }) =>
      devicesApi.assignVlan(switchDrawerDevice!.id, portVlanModal!.iface.name, vals.vlan_id, vals.mode),
    onSuccess: (res) => {
      if (res.success) { message.success('VLAN atandı'); setPortVlanModal(null); portVlanForm.resetFields(); refetchSwitchIfaces() }
      else message.error(res.error || 'VLAN atanamadı')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata oluştu'),
  })

  const bg = isDark ? '#070b14' : '#f1f5f9'
  const cardBg = isDark ? '#0d1117' : '#ffffff'
  const borderCol = isDark ? '#1e2a3a' : '#e2e8f0'
  const textPrimary = isDark ? '#e2e8f0' : '#1e293b'
  const textSecondary = isDark ? '#64748b' : '#64748b'

  const openItemDrawer = (unit: number, item?: RackItem) => {
    setDefaultUnit(unit)
    setEditingItem(item || null)
    itemForm.setFieldsValue(item ? {
      label: item.label, item_type: item.item_type,
      unit_start: item.unit_start, unit_height: item.unit_height, notes: item.notes,
    } : { unit_start: unit, unit_height: 1, item_type: 'other' })
    setItemDrawerOpen(true)
  }

  const handleItemSubmit = async () => {
    const values = await itemForm.validateFields()
    if (editingItem) updateItem.mutate({ id: editingItem.id, values })
    else createItem.mutate(values)
  }

  const handleDropDevice = (deviceId: number, unit: number) => setPlacement.mutate({ deviceId, unit })

  const handleAssignDevice = async () => {
    const values = await assignForm.validateFields()
    setPlacement.mutate({ deviceId: values.device_id, unit: assignUnit })
    setAssignDrawerOpen(false)
    assignForm.resetFields()
  }

  return (
    <div style={{ padding: 24, background: bg, minHeight: '100vh' }}>
      {/* Header */}
      <div style={{
        background: isDark ? 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)' : '#ffffff',
        border: `1px solid ${isDark ? '#3b82f620' : borderCol}`,
        borderLeft: '4px solid #3b82f6',
        borderRadius: 12,
        padding: '16px 20px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
        marginBottom: 20,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10,
            background: '#3b82f620', border: '1px solid #3b82f630',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <HddOutlined style={{ color: '#3b82f6', fontSize: 20 }} />
          </div>
          <div>
            <div style={{ color: textPrimary, fontWeight: 700, fontSize: 16 }}>Kabin Yönetimi</div>
            <div style={{ color: textSecondary, fontSize: 12 }}>Cihazları fiziksel kabinlere yerleştirin · PDU, UPS ve diğer ekipmanları yönetin</div>
          </div>
        </div>
        <Space>
          <Button.Group>
            <Button
              type={!view3D ? 'primary' : 'default'}
              icon={<UnorderedListOutlined />}
              onClick={() => setView3D(false)}
            >
              Diyagram
            </Button>
            <Button
              type={view3D ? 'primary' : 'default'}
              icon={<AppstoreOutlined />}
              onClick={() => setView3D(true)}
            >
              Harita
            </Button>
          </Button.Group>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setNewRackOpen(true)}>
            Yeni Kabin
          </Button>
        </Space>
      </div>

      {view3D ? (
        <TopoViewWrapper isDark={isDark} devices={allDevices} racks={racks} />
      ) : (
      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
        {/* Left panel */}
        <div style={{ width: 220, flexShrink: 0 }}>
          {/* Rack list */}
          <div style={{
            background: isDark ? '#0d1117' : '#fff',
            border: `1px solid ${borderCol}`,
            borderRadius: 10,
            overflow: 'hidden',
          }}>
            <div style={{
              padding: '10px 14px',
              borderBottom: `1px solid ${borderCol}`,
              background: isDark ? '#111827' : '#f8fafc',
            }}>
              <Text strong style={{ color: textPrimary, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                Kabinler
              </Text>
            </div>
            {racksLoading ? (
              <div style={{ padding: 20, textAlign: 'center' }}><Spin size="small" /></div>
            ) : racks.length === 0 ? (
              <div style={{ padding: 20, textAlign: 'center' }}>
                <Text style={{ color: textSecondary, fontSize: 12 }}>Henüz kabin yok</Text>
              </div>
            ) : (
              racks.map((r) => {
                const pct = Math.min(100, (r.used_u / r.total_u) * 100)
                const barColor = pct > 80 ? '#ef4444' : pct > 60 ? '#f59e0b' : '#22c55e'
                const isSelected = selectedRack === r.rack_name
                return (
                  <div
                    key={r.rack_name}
                    onClick={() => setSelectedRack(r.rack_name)}
                    style={{
                      padding: '10px 14px',
                      borderBottom: `1px solid ${borderCol}`,
                      cursor: 'pointer',
                      background: isSelected
                        ? isDark ? 'linear-gradient(90deg, #1d4ed815, #0f172a)' : '#eff6ff'
                        : 'transparent',
                      borderLeft: isSelected ? '3px solid #3b82f6' : '3px solid transparent',
                      transition: 'background 0.15s',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
                        <HddOutlined style={{ color: isSelected ? '#3b82f6' : textSecondary, fontSize: 12, flexShrink: 0 }} />
                        <span style={{
                          color: textPrimary, fontWeight: 600, fontSize: 12,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          fontFamily: 'monospace',
                        }}>
                          {r.rack_name}
                        </span>
                      </div>
                      <Popconfirm
                        title={`"${r.rack_name}" silinsin mi?`}
                        description="Tüm yerleşimler kaldırılacak"
                        onConfirm={(e) => { e?.stopPropagation(); deleteRack.mutate(r.rack_name) }}
                        onCancel={(e) => e?.stopPropagation()}
                        okText="Sil" cancelText="İptal" okButtonProps={{ danger: true }}
                      >
                        <DeleteOutlined
                          onClick={(e) => e.stopPropagation()}
                          style={{ color: isDark ? '#2d3748' : '#cbd5e1', fontSize: 11, flexShrink: 0, marginLeft: 4 }}
                        />
                      </Popconfirm>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                      <span style={{ fontSize: 10, color: textSecondary }}>{r.device_count} cihaz</span>
                      <span style={{ fontSize: 10, color: barColor, fontFamily: 'monospace' }}>
                        {r.used_u}/{r.total_u}U
                      </span>
                    </div>
                    <div style={{ background: isDark ? '#0a0f1a' : '#e2e8f0', borderRadius: 2, height: 3 }}>
                      <div style={{
                        width: `${pct}%`, height: '100%',
                        background: `linear-gradient(90deg, ${barColor}88, ${barColor})`,
                        borderRadius: 2, transition: 'width 0.3s',
                      }} />
                    </div>
                  </div>
                )
              })
            )}
          </div>

          {/* Unassigned devices */}
          <div style={{
            background: isDark ? '#0d1117' : '#fff',
            border: `1px solid ${borderCol}`,
            borderRadius: 10,
            overflow: 'hidden',
            marginTop: 16,
          }}>
            <div style={{
              padding: '10px 14px',
              borderBottom: `1px solid ${borderCol}`,
              background: isDark ? '#111827' : '#f8fafc',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <Text strong style={{ color: textPrimary, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                Atanmamış Cihazlar
              </Text>
              {unassigned.length > 0 && (
                <span style={{
                  background: '#1d4ed8', color: '#fff', fontSize: 9,
                  borderRadius: 10, padding: '1px 6px', fontWeight: 700,
                }}>
                  {unassigned.length}
                </span>
              )}
            </div>
            <div style={{ maxHeight: 300, overflowY: 'auto' }}>
              {unassigned.length === 0 ? (
                <div style={{ padding: 12, textAlign: 'center' }}>
                  <Text style={{ color: textSecondary, fontSize: 11 }}>Tüm cihazlar atandı</Text>
                </div>
              ) : (
                unassigned.map((d) => {
                  const vc = VENDOR_COLORS[d.vendor] || VENDOR_COLORS.other
                  return (
                    <div
                      key={d.id}
                      draggable
                      onDragStart={(e) => e.dataTransfer.setData('deviceId', String(d.id))}
                      style={{
                        padding: '8px 14px',
                        borderBottom: `1px solid ${borderCol}`,
                        cursor: 'grab',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        transition: 'background 0.1s',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = isDark ? '#111827' : '#f8fafc')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      <div style={{ width: 3, height: 28, borderRadius: 2, background: vc, flexShrink: 0 }} />
                      <DragOutlined style={{ color: textSecondary, fontSize: 10, flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ color: textPrimary, fontSize: 11, fontWeight: 600, fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {d.hostname}
                        </div>
                        <div style={{ color: textSecondary, fontSize: 10 }}>{d.ip_address}</div>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </div>

        {/* Main area */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {!selectedRack ? (
            <div style={{
              background: cardBg,
              border: `1px solid ${borderCol}`,
              borderRadius: 10,
              padding: 60,
              textAlign: 'center',
            }}>
              <Empty description={
                <span style={{ color: textSecondary }}>Soldan bir kabin seçin veya yeni kabin oluşturun</span>
              } />
            </div>
          ) : detailLoading ? (
            <div style={{ textAlign: 'center', padding: 60 }}><Spin /></div>
          ) : rackDetail ? (
            <div>
              {/* Stats bar */}
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16,
              }}>
                <div style={{ display: 'flex', gap: 10 }}>
                  {[
                    { label: 'TOPLAM', value: `${rackDetail.total_u}U`, color: '#64748b' },
                    { label: 'CİHAZ', value: rackDetail.devices.length, color: '#3b82f6' },
                    { label: 'ÖĞE', value: rackDetail.items.length, color: '#7c3aed' },
                    {
                      label: 'DOLULUK',
                      value: `${Math.round(((rackDetail.devices.reduce((s, d) => s + (d.rack_height || 1), 0) + rackDetail.items.reduce((s, i) => s + i.unit_height, 0)) / rackDetail.total_u) * 100)}%`,
                      color: '#22c55e',
                    },
                  ].map((stat) => (
                    <div key={stat.label} style={{
                      background: isDark ? `linear-gradient(135deg, ${stat.color}0d 0%, ${cardBg} 60%)` : cardBg,
                      border: `1px solid ${isDark ? stat.color + '28' : borderCol}`,
                      borderTop: isDark ? `2px solid ${stat.color}55` : `2px solid ${stat.color}`,
                      borderRadius: 8,
                      padding: '8px 14px',
                      textAlign: 'center',
                      minWidth: 70,
                    }}>
                      <div style={{ fontSize: 18, fontWeight: 800, color: stat.color, fontFamily: 'monospace' }}>
                        {stat.value}
                      </div>
                      <div style={{ fontSize: 9, color: textSecondary, letterSpacing: '0.08em', marginTop: 1 }}>
                        {stat.label}
                      </div>
                    </div>
                  ))}
                </div>
                <Space>
                  <Button
                    icon={<AppstoreAddOutlined />}
                    onClick={() => { setAssignUnit(1); assignForm.resetFields(); setAssignDrawerOpen(true) }}
                  >
                    Cihaz Ata
                  </Button>
                  <Button icon={<ThunderboltOutlined />} onClick={() => openItemDrawer(1)}>
                    Öğe Ekle
                  </Button>
                </Space>
              </div>

              <div style={{ overflowX: 'auto' }}>
                <RackDiagram
                  rack={rackDetail}
                  isDark={isDark}
                  onDropDevice={handleDropDevice}
                  onRemoveDevice={(id) => removePlacement.mutate(id)}
                  onAddItem={(unit) => openItemDrawer(unit)}
                  onEditItem={(item) => openItemDrawer(item.unit_start, item)}
                  onDeleteItem={(item) => modal.confirm({
                    title: `"${item.label}" silinsin mi?`,
                    onOk: () => deleteItem.mutate(item.id),
                  })}
                  onClickDevice={(device) => setSwitchDrawerDevice(device)}
                  utilizationMap={utilizationMap}
                />
              </div>

              <div style={{
                marginTop: 16, padding: '10px 14px',
                background: isDark ? '#0d1117' : '#fff',
                border: `1px solid ${borderCol}`,
                borderRadius: 8,
              }}>
                <Text style={{ color: textSecondary, fontSize: 11 }}>
                  Cihazları sol listeden sürükleyip slot üzerine bırakın · Boş slota tıklayarak PDU, UPS gibi öğe ekleyebilirsiniz
                </Text>
              </div>
            </div>
          ) : null}
        </div>
      </div>
      )}

      {/* New Rack Modal */}
      <Modal
        title={<span style={{ color: textPrimary }}>Yeni Kabin</span>}
        open={newRackOpen}
        onCancel={() => { setNewRackOpen(false); setNewRackName(''); setNewRackTotalU(42) }}
        onOk={() => { if (!newRackName.trim()) return; createRack.mutate({ rack_name: newRackName.trim(), total_u: newRackTotalU }) }}
        confirmLoading={createRack.isPending}
        okText="Oluştur"
        cancelText="İptal"
        styles={{
          content: { background: cardBg, border: `1px solid ${borderCol}` },
          header: { background: cardBg, borderBottom: `1px solid ${borderCol}` },
        }}
      >
        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <div style={{ marginBottom: 6, color: textSecondary, fontSize: 12 }}>Kabin adı</div>
            <Input
              placeholder="örn: KABİN-A1, SERVER-ROOM-01"
              value={newRackName}
              onChange={(e) => setNewRackName(e.target.value)}
              onPressEnter={() => { if (!newRackName.trim()) return; createRack.mutate({ rack_name: newRackName.trim(), total_u: newRackTotalU }) }}
            />
          </div>
          <div>
            <div style={{ marginBottom: 6, color: textSecondary, fontSize: 12 }}>Kabin boyutu</div>
            <Select
              value={newRackTotalU}
              onChange={setNewRackTotalU}
              style={{ width: '100%' }}
              options={[8, 12, 16, 20, 24, 28, 32, 36, 42, 45, 47, 48].map((u) => ({ value: u, label: `${u}U` }))}
            />
          </div>
        </div>
      </Modal>

      {/* Item Drawer */}
      <Drawer
        title={<span style={{ color: textPrimary }}>{editingItem ? 'Öğe Düzenle' : 'Öğe Ekle'}</span>}
        open={itemDrawerOpen}
        onClose={() => { setItemDrawerOpen(false); setEditingItem(null); itemForm.resetFields() }}
        width={360}
        styles={{
          body: { background: cardBg },
          header: { background: cardBg, borderBottom: `1px solid ${borderCol}` },
        }}
        footer={
          <Space style={{ justifyContent: 'flex-end', width: '100%' }}>
            <Button onClick={() => { setItemDrawerOpen(false); setEditingItem(null) }}>İptal</Button>
            <Button type="primary" onClick={handleItemSubmit} loading={createItem.isPending || updateItem.isPending}>
              {editingItem ? 'Güncelle' : 'Ekle'}
            </Button>
          </Space>
        }
      >
        <Form form={itemForm} layout="vertical">
          <Form.Item name="label" label="Etiket" rules={[{ required: true }]}>
            <Input placeholder="örn: APC Smart-UPS 1500" />
          </Form.Item>
          <Form.Item name="item_type" label="Tür" rules={[{ required: true }]}>
            <Select>
              {Object.entries(ITEM_TYPE_LABELS).map(([k, v]) => (
                <Select.Option key={k} value={k}>{v}</Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item name="unit_start" label="Başlangıç U" rules={[{ required: true }]}>
            <InputNumber min={1} max={rackDetail?.total_u ?? 42} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="unit_height" label="Yükseklik (U)" rules={[{ required: true }]}>
            <InputNumber min={1} max={10} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="notes" label="Notlar">
            <Input.TextArea rows={3} placeholder="İsteğe bağlı notlar..." />
          </Form.Item>
        </Form>
      </Drawer>

      {/* Switch Port Drawer */}
      <Drawer
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ color: textPrimary, fontWeight: 700 }}>
              {switchDrawerDevice?.hostname}
            </span>
            {switchDrawerDevice && (
              <Tag color={switchDrawerDevice.status === 'online' ? 'green' : 'red'} style={{ fontSize: 10 }}>
                {switchDrawerDevice.status}
              </Tag>
            )}
            {switchDrawerDevice && (
              <span style={{ color: textSecondary, fontSize: 11 }}>{switchDrawerDevice.ip_address}</span>
            )}
          </div>
        }
        open={!!switchDrawerDevice}
        onClose={() => { setSwitchDrawerDevice(null); setPortVlanModal(null) }}
        width={900}
        styles={{
          body: { background: isDark ? '#070b14' : '#f1f5f9', padding: 16 },
          header: { background: cardBg, borderBottom: `1px solid ${borderCol}` },
        }}
        extra={
          <Button
            icon={<ReloadOutlined />}
            size="small"
            loading={switchIfaceLoading}
            onClick={() => refetchSwitchIfaces()}
          >
            Yenile
          </Button>
        }
      >
        {switchIfaceLoading ? (
          <div style={{ textAlign: 'center', padding: 48 }}><Spin /></div>
        ) : !switchIfaceData?.success ? (
          <Typography.Text type="danger" style={{ padding: 16, display: 'block' }}>
            {switchIfaceData?.error || 'Portlar alınamadı. SSH bağlantısını kontrol edin.'}
          </Typography.Text>
        ) : (
          <SwitchPortPanel
            ports={switchIfaceData.interfaces}
            isPending={togglePortMutation.isPending}
            deviceModel={switchDrawerDevice?.model ?? undefined}
            deviceVendor={switchDrawerDevice?.vendor}
            onTogglePort={(name, action) => togglePortMutation.mutate({ name, action })}
            onAssignVlan={(iface) => { setPortVlanModal({ iface }); portVlanForm.resetFields() }}
          />
        )}
      </Drawer>

      {/* Port VLAN Assign Modal */}
      <Modal
        title={<span style={{ color: textPrimary }}>VLAN Ata — {portVlanModal?.iface.name}</span>}
        open={!!portVlanModal}
        onCancel={() => { setPortVlanModal(null); portVlanForm.resetFields() }}
        onOk={() => portVlanForm.submit()}
        confirmLoading={assignPortVlanMutation.isPending}
        okText="Ata"
        cancelText="İptal"
        styles={{
          content: { background: cardBg, border: `1px solid ${borderCol}` },
          header: { background: cardBg, borderBottom: `1px solid ${borderCol}` },
        }}
      >
        <Form
          form={portVlanForm}
          layout="vertical"
          initialValues={{ mode: 'access' }}
          onFinish={assignPortVlanMutation.mutate}
        >
          <Form.Item name="vlan_id" label="VLAN ID" rules={[{ required: true, message: 'VLAN ID gerekli' }]}>
            <InputNumber min={1} max={4094} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="mode" label="Mod" rules={[{ required: true }]}>
            <Select
              options={[
                { label: 'Access', value: 'access' },
                { label: 'Trunk', value: 'trunk' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* Assign Device Drawer */}
      <Drawer
        title={<span style={{ color: textPrimary }}>Cihaz Ata</span>}
        open={assignDrawerOpen}
        onClose={() => { setAssignDrawerOpen(false); assignForm.resetFields() }}
        width={360}
        styles={{
          body: { background: cardBg },
          header: { background: cardBg, borderBottom: `1px solid ${borderCol}` },
        }}
        footer={
          <Space style={{ justifyContent: 'flex-end', width: '100%' }}>
            <Button onClick={() => setAssignDrawerOpen(false)}>İptal</Button>
            <Button type="primary" onClick={handleAssignDevice} loading={setPlacement.isPending}>Ata</Button>
          </Space>
        }
      >
        <Form form={assignForm} layout="vertical">
          <Form.Item name="device_id" label="Cihaz" rules={[{ required: true }]}>
            <Select
              showSearch
              placeholder="Cihaz seçin..."
              optionFilterProp="label"
              options={unassigned.map((d) => ({ value: d.id, label: `${d.hostname} (${d.ip_address})` }))}
            />
          </Form.Item>
          <Form.Item label="Slot (U Pozisyonu)" required>
            <InputNumber
              min={1}
              max={rackDetail?.total_u ?? 42}
              value={assignUnit}
              onChange={(v) => setAssignUnit(v || 1)}
              style={{ width: '100%' }}
            />
          </Form.Item>
        </Form>
      </Drawer>
    </div>
  )
}
