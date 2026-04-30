import { useState } from 'react'
import { Tooltip, Popconfirm, Button } from 'antd'
import { PoweroffOutlined, CheckCircleOutlined } from '@ant-design/icons'
import type { NetworkInterface } from '@/types'

const ANIM_CSS = `
@keyframes portGlow {
  0%, 100% { box-shadow: 0 0 4px 1px #22c55e55; }
  50%       { box-shadow: 0 0 11px 3px #22c55e92; }
}
@keyframes trunkGlow {
  0%, 100% { box-shadow: 0 0 5px 1px #3b82f660; }
  50%       { box-shadow: 0 0 14px 3px #3b82f699; }
}
@keyframes errBlink {
  0%, 100% { background: #7f1d1d; box-shadow: 0 0 4px #ef444452; }
  50%       { background: #dc2626; box-shadow: 0 0 9px #ef4444bb; }
}
@keyframes sfpGlow {
  0%, 100% { box-shadow: 0 0 4px 1px #3b82f640; }
  50%       { box-shadow: 0 0 9px 2px #3b82f678; }
}
@keyframes actSingle {
  0%,75%,100% { opacity: 1; }
  80%         { opacity: 0.06; }
}
@keyframes actDouble {
  0%,48%,54%,90%,100% { opacity: 1; }
  50%                 { opacity: 0.06; }
  92%                 { opacity: 0.06; }
}
.sw-port { transition: filter 0.12s ease; }
.sw-port:hover { filter: brightness(1.65) saturate(1.25) !important; }
`

function portHash(name: string): number {
  return name.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
}

function actAnimation(p: NetworkInterface, trunk: boolean): React.CSSProperties {
  if (normalize(p.status) !== 'connected') return {}
  const h = portHash(p.name)
  // trunk / uplinks: double-blink, fast
  if (trunk) return {
    animation: `actDouble ${0.9 + (h % 4) * 0.15}s ease-in-out ${(h % 22) * 100}ms infinite`,
    opacity: 1,
  }
  // regular connected: alternate single-blink speed based on hash
  const dur = [2.2, 2.9, 3.7, 1.7][h % 4]
  return {
    animation: `actSingle ${dur}s ease-in-out ${(h % 28) * 80}ms infinite`,
    opacity: 1,
  }
}

const VENDOR_COLORS: Record<string, string> = {
  cisco:    '#1d6fa4',
  aruba:    '#ff8300',
  ruijie:   '#e4002b',
  fortinet: '#ee3124',
  mikrotik: '#0073a8',
  juniper:  '#84b135',
  ubiquiti: '#0559c9',
  h3c:      '#d10024',
  other:    '#64748b',
}

type PortStatus = 'connected' | 'notconnect' | 'disabled' | 'err-disabled' | 'unknown'

function normalize(s: string): PortStatus {
  if (s === 'connected' || s === 'up') return 'connected'
  if (s === 'err-disabled')            return 'err-disabled'
  if (s === 'disabled' || s === 'inactive' || s === 'administratively down') return 'disabled'
  return 'notconnect'
}

function ledColor(s: PortStatus): string {
  if (s === 'connected')    return '#22c55e'
  if (s === 'err-disabled') return '#ef4444'
  if (s === 'disabled')     return '#374151'
  return '#1a2535'
}

function portFill(s: PortStatus, trunk: boolean): string {
  if (s === 'connected')    return trunk ? '#1e3a5f' : '#14532d'
  if (s === 'err-disabled') return '#450a0a'
  if (s === 'disabled')     return '#111827'
  return '#0a0e17'
}

function isPhysical(name: string): boolean {
  const n = name.toLowerCase().replace(/\s+/g, '')
  return !/^(vlan|loopback|lo\d|tunnel|port-channel|po\d|trk\d|mgmt|management|null|nve|bdi)/.test(n)
}

function isSFP(name: string): boolean {
  const n = name.toLowerCase().replace(/\s+/g, '')
  return /^(tengig|te\d|hu\d|fo\d|fortygig|hundredgig|twentyfivegig|fiftygig)/.test(n)
}

function toShort(name: string): string {
  return name
    .replace(/HundredGigE/gi,           'Hu')
    .replace(/FortyGigabitEthernet/gi,  'Fo')
    .replace(/TenGigabitEthernet/gi,    'Te')
    .replace(/GigabitEthernet/gi,       'Gi')
    .replace(/FastEthernet/gi,          'Fa')
    .replace(/\s+/g, '')
}

function sortKey(name: string): number[] {
  const nums = name.match(/\d+/g) ?? ['0']
  return nums.map(Number)
}

function getPortNum(name: string): string {
  const nums = name.match(/\d+/g) ?? []
  return nums[nums.length - 1] ?? '?'
}

function detectTrunk(p: NetworkInterface): boolean {
  return (
    p.vlan?.toLowerCase() === 'trunk' ||
    p.duplex?.toLowerCase() === 'trunk' ||
    p.speed?.toLowerCase() === 'trunk' ||
    p.description?.toLowerCase().includes('uplink') ||
    p.description?.toLowerCase().includes('trunk')
  )
}

export interface PortUtil { in_pct: number; out_pct: number; max_pct: number }

interface Props {
  ports:         NetworkInterface[]
  isPending?:    boolean
  deviceModel?:  string
  deviceVendor?: string
  snmpUtil?:     Record<string, PortUtil>
  onTogglePort:  (name: string, action: 'shutdown' | 'no-shutdown') => void
  onAssignVlan:  (iface: NetworkInterface) => void
}

// ── Mini stat pill ────────────────────────────────────────────────────────────
function StatPill({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 4,
      padding: '2px 7px', borderRadius: 10,
      background: `${color}15`, border: `1px solid ${color}38`,
    }}>
      <div style={{ width: 5, height: 5, borderRadius: '50%', background: color }} />
      <span style={{ fontSize: 9, fontWeight: 700, color, fontFamily: 'monospace' }}>{value}</span>
      <span style={{ fontSize: 8, color: `${color}99` }}>{label}</span>
    </div>
  )
}

// ── Legend item ───────────────────────────────────────────────────────────────
function LegendItem({ color, label, shape }: { color: string; label: string; shape?: 'rect' | 'circle' }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
      <div style={{
        width: shape === 'rect' ? 9 : 7,
        height: shape === 'rect' ? 5 : 7,
        borderRadius: shape === 'rect' ? 1 : '50%',
        background: color,
        boxShadow: `0 0 3px ${color}70`,
      }} />
      <span style={{ fontSize: 8.5, color: '#4b5563', letterSpacing: 0.2 }}>{label}</span>
    </div>
  )
}

// ── Corner screw detail ───────────────────────────────────────────────────────
function Screw() {
  return (
    <div style={{
      width: 7, height: 7, borderRadius: '50%',
      background: 'radial-gradient(circle at 35% 35%, #2d3748, #111827)',
      border: '1px solid #0d1117',
      position: 'relative',
      boxShadow: 'inset 0 1px 1px rgba(255,255,255,0.06)',
      flexShrink: 0,
    }}>
      <div style={{ position: 'absolute', top: '50%', left: '15%', right: '15%', height: 1, background: '#0d1117', transform: 'translateY(-50%)', opacity: 0.9 }} />
      <div style={{ position: 'absolute', left: '50%', top: '15%', bottom: '15%', width: 1, background: '#0d1117', transform: 'translateX(-50%)', opacity: 0.9 }} />
    </div>
  )
}

function normPortName(n: string): string {
  return n.toLowerCase().replace(/\s+/g, '')
}

function utilColor(pct: number): string {
  if (pct >= 80) return '#ef4444'
  if (pct >= 50) return '#f59e0b'
  return '#3b82f6'
}

// ── Main component ────────────────────────────────────────────────────────────
export default function SwitchPortPanel({
  ports, isPending, deviceModel, deviceVendor, snmpUtil, onTogglePort, onAssignVlan,
}: Props) {
  const [selected, setSelected] = useState<NetworkInterface | null>(null)

  const accent = VENDOR_COLORS[deviceVendor?.toLowerCase() ?? ''] ?? VENDOR_COLORS.other

  const physical = [...ports]
    .filter(p => isPhysical(p.name))
    .sort((a, b) => {
      const ka = sortKey(a.name), kb = sortKey(b.name)
      for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
        const d = (ka[i] ?? 0) - (kb[i] ?? 0)
        if (d !== 0) return d
      }
      return 0
    })

  const rj45 = physical.filter(p => !isSFP(p.name))
  const sfps  = physical.filter(p => isSFP(p.name))

  const groups: NetworkInterface[][] = []
  for (let i = 0; i < rj45.length; i += 8) groups.push(rj45.slice(i, i + 8))

  const connected = rj45.filter(p => normalize(p.status) === 'connected').length
  const adminDown = rj45.filter(p => normalize(p.status) === 'disabled').length
  const notConn   = rj45.filter(p => normalize(p.status) === 'notconnect').length
  const errD      = rj45.filter(p => normalize(p.status) === 'err-disabled').length

  function toggleSelect(p: NetworkInterface) {
    setSelected(prev => prev?.name === p.name ? null : p)
  }

  return (
    <div>
      <style>{ANIM_CSS}</style>

      {/* ── Chassis ─────────────────────────────────────────────────────── */}
      <div style={{
        overflowX: 'auto',
        background: [
          'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.06) 2px, rgba(0,0,0,0.06) 3px)',
          'linear-gradient(180deg, #1e2435 0%, #0d111c 100%)',
        ].join(', '),
        border: '1px solid #1a2234',
        borderLeft: `4px solid ${accent}`,
        borderRadius: selected ? '8px 8px 0 0' : 8,
        padding: '10px 14px 8px',
        boxShadow: '0 4px 24px rgba(0,0,0,0.65), inset 0 1px 0 rgba(255,255,255,0.05)',
        userSelect: 'none',
        position: 'relative',
      }}>
        {/* Corner screws */}
        <div style={{ position: 'absolute', top: 5, right: 8, display: 'flex', gap: 5 }}>
          <Screw /><Screw />
        </div>
        <div style={{ position: 'absolute', bottom: 5, right: 8, display: 'flex', gap: 5 }}>
          <Screw /><Screw />
        </div>

        {/* ── Header ── */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10, paddingRight: 24 }}>
          {/* Left: vendor + legend */}
          <div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
              <span style={{
                fontSize: 10, fontWeight: 700, letterSpacing: 2.5,
                textTransform: 'uppercase', color: accent, fontFamily: 'monospace',
              }}>
                {deviceVendor?.toUpperCase() ?? 'SWITCH'}
              </span>
              {deviceModel && (
                <span style={{ fontSize: 9, color: '#374151', fontFamily: 'monospace' }}>{deviceModel}</span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <LegendItem color="#22c55e" label="Up" />
              <LegendItem color="#4b5563" label="Not Connect" />
              <LegendItem color="#374151" label="Admin Down" />
              <LegendItem color="#ef4444" label="Err-Disabled" />
              <LegendItem color="#3b82f6" label="Trunk" shape="rect" />
              {snmpUtil && Object.keys(snmpUtil).length > 0 && (
                <>
                  <LegendItem color="#3b82f6" label="<50% util" shape="rect" />
                  <LegendItem color="#f59e0b" label="50-80%" shape="rect" />
                  <LegendItem color="#ef4444" label=">80%" shape="rect" />
                </>
              )}
            </div>
          </div>

          {/* Right: stat pills */}
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <StatPill value={connected}           label="UP"    color="#22c55e" />
            {notConn   > 0 && <StatPill value={notConn}   label="DOWN"  color="#4b5563" />}
            {adminDown > 0 && <StatPill value={adminDown} label="ADMIN" color="#374151" />}
            {errD      > 0 && <StatPill value={errD}      label="ERR"   color="#ef4444" />}
            <StatPill value={rj45.length}         label="TOTAL" color="#475569" />
          </div>
        </div>

        {/* ── Port groups ── */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'nowrap' }}>
          {groups.map((grp, gi) => {
            const top    = grp.filter((_, i) => i % 2 === 0)
            const bot    = grp.filter((_, i) => i % 2 === 1)
            const topNums = top.map(p => getPortNum(p.name))
            const botNums = bot.map(p => getPortNum(p.name))

            return (
              <div key={gi} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {/* Top row labels — above top ports */}
                <div style={{ display: 'flex', gap: 3 }}>
                  {topNums.map((n, i) => (
                    <div key={i} style={{ width: 26, textAlign: 'center', fontSize: 7, color: '#2d3748', fontFamily: 'monospace' }}>
                      {n}
                    </div>
                  ))}
                </div>
                {/* Top row ports */}
                <div style={{ display: 'flex', gap: 3 }}>
                  {top.map(p => (
                    <Port key={p.name} p={p} accent={accent} selected={selected} util={snmpUtil?.[normPortName(p.name)]} onSelect={toggleSelect} />
                  ))}
                </div>
                {/* Bottom row ports */}
                <div style={{ display: 'flex', gap: 3 }}>
                  {bot.map(p => (
                    <Port key={p.name} p={p} accent={accent} selected={selected} util={snmpUtil?.[normPortName(p.name)]} onSelect={toggleSelect} />
                  ))}
                </div>
                {/* Bottom row labels — below bottom ports */}
                {bot.length > 0 && (
                  <div style={{ display: 'flex', gap: 3 }}>
                    {botNums.map((n, i) => (
                      <div key={i} style={{ width: 26, textAlign: 'center', fontSize: 7, color: '#2d3748', fontFamily: 'monospace' }}>
                        {n}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}

          {/* ── SFP uplinks ── */}
          {sfps.length > 0 && (
            <div style={{
              display: 'flex', flexDirection: 'column', gap: 3,
              paddingLeft: 10, borderLeft: '1px solid #1e2a3a', marginLeft: 4,
            }}>
              <div style={{ fontSize: 8, fontWeight: 700, color: '#3b82f6', letterSpacing: 1.2, fontFamily: 'monospace', marginBottom: 1 }}>
                SFP+
              </div>
              <div style={{ display: 'flex', gap: 3 }}>
                {sfps.map(p => (
                  <SFPPort key={p.name} p={p} accent={accent} selected={selected} util={snmpUtil?.[normPortName(p.name)]} onSelect={toggleSelect} />
                ))}
              </div>
              <div style={{ height: 24 }} />
              <div style={{ display: 'flex', gap: 3 }}>
                {sfps.map(p => (
                  <div key={p.name} style={{ width: 22, textAlign: 'center', fontSize: 7, color: '#2d3748', fontFamily: 'monospace' }}>
                    {getPortNum(p.name)}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div style={{ height: 4 }} />
      </div>

      {/* ── Selected port info panel ── */}
      {selected && (
        <PortInfoPanel
          port={selected}
          accent={accent}
          isPending={isPending}
          onClose={() => setSelected(null)}
          onToggle={(action) => { onTogglePort(selected.name, action); setSelected(null) }}
          onAssignVlan={() => { onAssignVlan(selected); setSelected(null) }}
        />
      )}
    </div>
  )
}

// ── Single RJ45 port ──────────────────────────────────────────────────────────
function Port({ p, accent, selected, util, onSelect }: {
  p:        NetworkInterface
  accent:   string
  selected: NetworkInterface | null
  util?:    PortUtil
  onSelect: (p: NetworkInterface) => void
}) {
  const status  = normalize(p.status)
  const isConn  = status === 'connected'
  const isErr   = status === 'err-disabled'
  const isSel   = selected?.name === p.name
  const isTrk   = detectTrunk(p)
  const short   = toShort(p.name)
  const portLed = isConn ? (isTrk ? '#3b82f6' : '#22c55e') : ledColor(status)
  const h       = portHash(p.name)
  const glowAnim = isConn
    ? isTrk
      ? `trunkGlow ${0.9 + (h % 5) * 0.18}s ease-in-out ${(h % 15) * 120}ms infinite`
      : `portGlow ${2.0 + (h % 5) * 0.4}s ease-in-out ${(h % 25) * 90}ms infinite`
    : isErr ? 'errBlink 1s ease-in-out infinite' : undefined

  const hasUtil = util && util.max_pct > 0
  const uColor = hasUtil ? utilColor(util!.max_pct) : undefined

  return (
    <Tooltip
      title={
        <div style={{ fontSize: 11, lineHeight: 1.7 }}>
          <div style={{ fontWeight: 600 }}>{short}</div>
          {p.description && <div style={{ color: '#94a3b8' }}>{p.description}</div>}
          <div>Status: <span style={{ color: ledColor(status) }}>{p.status}</span></div>
          {p.vlan  && <div>VLAN: <span style={{ color: '#f59e0b' }}>{p.vlan}</span></div>}
          {p.speed && <div>Speed: {p.speed}</div>}
          {isTrk   && <div style={{ color: '#3b82f6' }}>Trunk / Uplink</div>}
          {hasUtil && (
            <div style={{ marginTop: 4, borderTop: '1px solid #1e293b', paddingTop: 4 }}>
              <div>In: <span style={{ color: utilColor(util!.in_pct) }}>{util!.in_pct.toFixed(1)}%</span></div>
              <div>Out: <span style={{ color: utilColor(util!.out_pct) }}>{util!.out_pct.toFixed(1)}%</span></div>
            </div>
          )}
        </div>
      }
      mouseEnterDelay={0.2}
    >
      <div
        className="sw-port"
        onClick={() => onSelect(p)}
        style={{
          width: 26, height: 24,
          background: portFill(status, isTrk),
          border: `1px solid ${isSel ? accent : (isConn ? (isTrk ? '#1d4ed8' : '#166534') : '#1a2234')}`,
          borderRadius: 3,
          cursor: 'pointer',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '2px 3px 3px',
          boxSizing: 'border-box',
          outline: isSel ? `2px solid ${accent}` : undefined,
          outlineOffset: 1,
          animation: glowAnim,
          position: 'relative',
        }}
      >
        {/* RJ45 teeth */}
        <div style={{ display: 'flex', gap: 1 }}>
          {[0,1,2,3].map(i => (
            <div key={i} style={{
              width: 3, height: 9,
              background: isConn ? (isTrk ? '#3b82f638' : '#22c55e35') : '#1e2a3a',
              borderRadius: '0 0 1px 1px',
            }} />
          ))}
        </div>
        {/* LED + activity indicator */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <div style={{
            width: 4, height: 4, borderRadius: '50%',
            background: portLed,
            boxShadow: isConn ? `0 0 5px ${portLed}` : undefined,
            ...actAnimation(p, isTrk),
          }} />
          {isConn && (
            <div style={{
              width: 2, height: 2, borderRadius: '50%',
              background: isTrk ? '#60a5fa' : '#86efac',
              ...actAnimation(p, !isTrk),
            }} />
          )}
        </div>
        {/* SNMP utilization bar */}
        {hasUtil && (
          <div style={{
            position: 'absolute', bottom: 1, left: 2,
            height: 2, borderRadius: 1,
            width: `${Math.min(100, Math.round(util!.max_pct))}%`,
            background: uColor,
            boxShadow: util!.max_pct >= 80 ? `0 0 4px ${uColor}` : undefined,
            opacity: 0.85,
          }} />
        )}
      </div>
    </Tooltip>
  )
}

// ── SFP port ──────────────────────────────────────────────────────────────────
function SFPPort({ p, accent, selected, util, onSelect }: {
  p:        NetworkInterface
  accent:   string
  selected: NetworkInterface | null
  util?:    PortUtil
  onSelect: (p: NetworkInterface) => void
}) {
  const status = normalize(p.status)
  const isConn = status === 'connected'
  const isSel  = selected?.name === p.name
  const short  = toShort(p.name)
  const h      = portHash(p.name)
  const hasUtil = util && util.max_pct > 0
  const uColor = hasUtil ? utilColor(util!.max_pct) : undefined

  return (
    <Tooltip
      title={
        <div style={{ fontSize: 11, lineHeight: 1.7 }}>
          <div style={{ fontWeight: 600 }}>{short} <span style={{ color: '#3b82f6', fontSize: 10 }}>SFP+</span></div>
          <div>Status: <span style={{ color: ledColor(status) }}>{p.status}</span></div>
          {p.speed && <div>Speed: <span style={{ color: '#f59e0b' }}>{p.speed}</span></div>}
          {hasUtil && (
            <div style={{ marginTop: 4, borderTop: '1px solid #1e293b', paddingTop: 4 }}>
              <div>In: <span style={{ color: utilColor(util!.in_pct) }}>{util!.in_pct.toFixed(1)}%</span></div>
              <div>Out: <span style={{ color: utilColor(util!.out_pct) }}>{util!.out_pct.toFixed(1)}%</span></div>
            </div>
          )}
        </div>
      }
      mouseEnterDelay={0.2}
    >
      <div
        className="sw-port"
        onClick={() => onSelect(p)}
        style={{
          width: 22, height: 47,
          background: portFill(status, false),
          border: `1px solid ${isSel ? accent : (isConn ? '#1d4ed8' : '#1a2234')}`,
          borderRadius: 3,
          cursor: 'pointer',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'space-around',
          padding: '4px 2px',
          boxSizing: 'border-box',
          outline: isSel ? `2px solid ${accent}` : undefined,
          outlineOffset: 1,
          position: 'relative',
          animation: isConn
            ? `trunkGlow ${1.0 + (h % 4) * 0.2}s ease-in-out ${(h % 12) * 130}ms infinite`
            : undefined,
        }}
      >
        {/* SFP cage slot */}
        <div style={{
          width: 14, height: 7,
          background: isConn ? '#3b82f640' : '#1e2a3a',
          border: '1px solid #1e293b',
          borderRadius: 1,
        }} />
        {/* LED + activity dot */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <div style={{
            width: 5, height: 5, borderRadius: '50%',
            background: isConn ? '#3b82f6' : ledColor(status),
            boxShadow: isConn ? '0 0 6px #3b82f6' : undefined,
            ...actAnimation(p, true),
          }} />
        </div>
        {/* SNMP utilization bar */}
        {hasUtil && (
          <div style={{
            position: 'absolute', bottom: 2, left: 2,
            height: 2, borderRadius: 1,
            width: `${Math.min(100, Math.round(util!.max_pct))}%`,
            background: uColor,
            boxShadow: util!.max_pct >= 80 ? `0 0 4px ${uColor}` : undefined,
            opacity: 0.85,
          }} />
        )}
      </div>
    </Tooltip>
  )
}

// ── Port info + actions panel ─────────────────────────────────────────────────
function PortInfoPanel({ port, accent, isPending, onClose, onToggle, onAssignVlan }: {
  port:         NetworkInterface
  accent:       string
  isPending?:   boolean
  onClose:      () => void
  onToggle:     (action: 'shutdown' | 'no-shutdown') => void
  onAssignVlan: () => void
}) {
  const status   = normalize(port.status)
  const isDown   = status !== 'connected'
  const statClr  = status === 'connected' ? '#22c55e'
                 : status === 'err-disabled' ? '#ef4444'
                 : status === 'disabled'     ? '#6b7280'
                 : '#475569'
  const isTrk    = detectTrunk(port)
  const modeClr  = isTrk ? '#3b82f6' : '#22c55e'
  const modeLbl  = isTrk ? 'Trunk' : 'Access'

  const fields = [
    { label: 'Port',   value: toShort(port.name),  mono: true },
    { label: 'Status', value: port.status,          color: statClr },
    { label: 'Mode',   value: modeLbl,              badge: true, color: modeClr },
    ...(port.vlan        ? [{ label: 'VLAN',   value: port.vlan        }] : []),
    ...(port.speed       ? [{ label: 'Speed',  value: port.speed       }] : []),
    ...(port.duplex      ? [{ label: 'Duplex', value: port.duplex      }] : []),
    ...(port.description ? [{ label: 'Desc',   value: port.description }] : []),
  ] as { label: string; value: string; color?: string; mono?: boolean; badge?: boolean }[]

  return (
    <div style={{
      background: 'linear-gradient(180deg, #111827 0%, #0a0e17 100%)',
      border: '1px solid #1a2234',
      borderTop: `2px solid ${accent}`,
      borderRadius: '0 0 8px 8px',
      padding: '10px 14px 12px',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: 12,
      flexWrap: 'wrap',
    }}>
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {fields.map(({ label, value, color, mono, badge }) => (
          <div key={label}>
            <div style={{ fontSize: 9, color: '#4b5563', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 3 }}>
              {label}
            </div>
            {badge ? (
              <span style={{
                fontSize: 10, fontWeight: 600,
                color: color ?? '#94a3b8',
                background: `${color ?? '#94a3b8'}18`,
                border: `1px solid ${color ?? '#94a3b8'}40`,
                padding: '1px 7px',
                borderRadius: 4,
              }}>
                {value}
              </span>
            ) : (
              <div style={{
                fontSize: 12, fontWeight: 600,
                color: color ?? '#94a3b8',
                fontFamily: mono ? 'monospace' : undefined,
              }}>
                {value}
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <Popconfirm
          title={isDown ? 'Port açılsın mı?' : 'Port kapatılsın mı?'}
          onConfirm={() => onToggle(isDown ? 'no-shutdown' : 'shutdown')}
        >
          <Button
            size="small"
            icon={isDown ? <CheckCircleOutlined /> : <PoweroffOutlined />}
            loading={isPending}
            danger={!isDown}
            style={isDown ? { background: '#14532d', borderColor: '#166534', color: '#4ade80' } : undefined}
          >
            {isDown ? 'Aç' : 'Kapat'}
          </Button>
        </Popconfirm>
        <Button
          size="small"
          onClick={onAssignVlan}
          style={{ borderColor: '#1d4ed8', color: '#3b82f6', background: 'transparent' }}
        >
          VLAN Ata
        </Button>
        <Button
          size="small"
          onClick={onClose}
          style={{ color: '#4b5563', borderColor: '#1a2234', background: 'transparent' }}
        >
          ✕
        </Button>
      </div>
    </div>
  )
}
