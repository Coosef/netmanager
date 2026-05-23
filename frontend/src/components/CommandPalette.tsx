// CommandPalette — ⌘K / Ctrl+K palette (Phase 2). Mockup commandk.jsx.
//
// Gruplar: NAV / AKSIYON / CİHAZ. Klavye: ↑↓ gezin, ↵ seç, Esc kapat.
// Devices grubu query'ye göre devicesApi.list ile filtreleniyor (gerçek
// veri). NAV statik liste, route'lar mevcut sidebar nav'la senkron. Action
// callback'leri parent (AppLayout) tarafından handle ediliyor — toggleTheme,
// openCustomize gibi.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  DashboardOutlined, ApartmentOutlined, LaptopOutlined, BranchesOutlined,
  AlertOutlined, ClusterOutlined, ThunderboltOutlined, CloudOutlined,
  DiffOutlined, FileDoneOutlined, HddOutlined, RiseOutlined,
  TableOutlined, SafetyOutlined, CalendarOutlined, BugOutlined,
  BellOutlined, BarChartOutlined, RadarChartOutlined, SettingOutlined,
  SearchOutlined, BgColorsOutlined, SunOutlined, MoonOutlined,
  PlayCircleOutlined, AimOutlined, BuildOutlined, FileTextOutlined,
  SoundOutlined, NotificationOutlined, MonitorOutlined, StopOutlined,
} from '@ant-design/icons'
import { devicesApi } from '@/api/devices'

type Group = 'NAV' | 'AKSIYON' | 'CIHAZ'
export type PaletteAction = 'theme' | 'customize' | 'sound-toggle' | 'wall-start' | 'wall-stop'
interface Cmd {
  id: string
  group: Group
  label: string
  icon: React.ReactNode
  path?: string
  action?: PaletteAction
  hint?: string
}

const NAV_COMMANDS: Cmd[] = [
  { id: 'nav-/',              group: 'NAV', label: 'Dashboard',                icon: <DashboardOutlined />,   path: '/' },
  { id: 'nav-monitor',        group: 'NAV', label: 'Uyarılar & Olaylar',       icon: <AlertOutlined />,        path: '/monitor' },
  { id: 'nav-topology',       group: 'NAV', label: 'Topoloji',                  icon: <ApartmentOutlined />,    path: '/topology' },
  { id: 'nav-topology-next',  group: 'NAV', label: 'Topology · Gold',           icon: <ThunderboltOutlined />,  path: '/topology-next' },
  { id: 'nav-devices',        group: 'NAV', label: 'Cihazlar',                  icon: <LaptopOutlined />,       path: '/devices' },
  { id: 'nav-discovery',      group: 'NAV', label: 'Keşif Envanteri',           icon: <RadarChartOutlined />,   path: '/discovery' },
  { id: 'nav-ipam',           group: 'NAV', label: 'IPAM',                      icon: <ClusterOutlined />,      path: '/ipam' },
  { id: 'nav-vlan',           group: 'NAV', label: 'VLAN Yönetimi',             icon: <BranchesOutlined />,     path: '/vlan' },
  { id: 'nav-backups',        group: 'NAV', label: 'Yedekleme Merkezi',         icon: <CloudOutlined />,        path: '/backups' },
  { id: 'nav-config-drift',   group: 'NAV', label: 'Config Drift',              icon: <DiffOutlined />,         path: '/config-drift' },
  { id: 'nav-compliance',     group: 'NAV', label: 'Uyumluluk Denetimi',        icon: <FileDoneOutlined />,     path: '/compliance' },
  { id: 'nav-racks',          group: 'NAV', label: 'Kabinler',                  icon: <HddOutlined />,          path: '/racks' },
  { id: 'nav-floor-plan',     group: 'NAV', label: 'Kat Planı',                 icon: <BuildOutlined />,        path: '/floor-plan' },
  { id: 'nav-intelligence',   group: 'NAV', label: 'Ağ Analitik',               icon: <BugOutlined />,          path: '/intelligence' },
  { id: 'nav-alert-rules',    group: 'NAV', label: 'Alert Kuralları',           icon: <AlertOutlined />,        path: '/alert-rules' },
  { id: 'nav-bandwidth',      group: 'NAV', label: 'Bant Genişliği',            icon: <BarChartOutlined />,     path: '/bandwidth' },
  { id: 'nav-mac-arp',        group: 'NAV', label: 'Port Intelligence',         icon: <TableOutlined />,        path: '/mac-arp' },
  { id: 'nav-security-audit', group: 'NAV', label: 'Güvenlik Denetimi',         icon: <SafetyOutlined />,       path: '/security-audit' },
  { id: 'nav-asset',          group: 'NAV', label: 'Asset Lifecycle',           icon: <CalendarOutlined />,     path: '/asset-lifecycle' },
  { id: 'nav-diagnostics',    group: 'NAV', label: 'Ağ Tanılama',               icon: <AimOutlined />,          path: '/diagnostics' },
  { id: 'nav-tasks',          group: 'NAV', label: 'Görevler',                  icon: <PlayCircleOutlined />,   path: '/tasks' },
  { id: 'nav-playbooks',      group: 'NAV', label: 'Playbook\'lar',             icon: <ThunderboltOutlined />,  path: '/playbooks' },
  { id: 'nav-templates',      group: 'NAV', label: 'Config Şablonları',         icon: <FileTextOutlined />,     path: '/config-templates' },
  { id: 'nav-approvals',      group: 'NAV', label: 'Onaylar',                   icon: <SafetyOutlined />,       path: '/approvals' },
  { id: 'nav-sla',            group: 'NAV', label: 'SLA & Uptime',              icon: <RiseOutlined />,         path: '/sla' },
  { id: 'nav-probes',         group: 'NAV', label: 'Synthetic Probes',          icon: <RadarChartOutlined />,   path: '/synthetic-probes' },
  { id: 'nav-incidents',      group: 'NAV', label: 'Incident RCA',              icon: <BugOutlined />,          path: '/incidents' },
  { id: 'nav-escalation',     group: 'NAV', label: 'Escalation Kuralları',      icon: <BellOutlined />,         path: '/escalation-rules' },
  { id: 'nav-services',       group: 'NAV', label: 'Servis Etki Haritası',      icon: <ApartmentOutlined />,    path: '/services' },
  { id: 'nav-twin',           group: 'NAV', label: 'Network Digital Twin',      icon: <ApartmentOutlined />,    path: '/topology-twin' },
  { id: 'nav-reports',        group: 'NAV', label: 'Raporlar',                  icon: <BarChartOutlined />,     path: '/reports' },
  { id: 'nav-audit',          group: 'NAV', label: 'Audit Log',                 icon: <SafetyOutlined />,       path: '/audit' },
  { id: 'nav-settings',       group: 'NAV', label: 'Ayarlar',                   icon: <SettingOutlined />,      path: '/settings' },
]

interface Props {
  open: boolean
  onClose: () => void
  onAction: (action: PaletteAction) => void
  isDark: boolean
  soundEnabled: boolean
  wallActive: boolean
}

export default function CommandPalette({ open, onClose, onAction, isDark, soundEnabled, wallActive }: Props) {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQ(''); setIdx(0)
    const tm = setTimeout(() => inputRef.current?.focus(), 50)
    return () => clearTimeout(tm)
  }, [open])

  // Aksiyon komutları — durum değişkenlerine göre dinamik etiketler.
  const ACTION_COMMANDS: Cmd[] = useMemo(() => [
    { id: 'act-theme', group: 'AKSIYON',
      label: isDark ? 'Aydınlık temaya geç' : 'Karanlık temaya geç',
      icon: isDark ? <SunOutlined /> : <MoonOutlined />, action: 'theme' },
    { id: 'act-customize', group: 'AKSIYON',
      label: 'Özelleştir panelini aç',
      icon: <BgColorsOutlined />, action: 'customize' },
    { id: 'act-sound', group: 'AKSIYON',
      label: soundEnabled ? 'Kritik alarm sesini kapat' : 'Kritik alarm sesini aç',
      icon: soundEnabled ? <NotificationOutlined /> : <SoundOutlined />, action: 'sound-toggle' },
    ...(wallActive
      ? [{ id: 'act-wall-stop', group: 'AKSIYON' as Group,
          label: 'NOC Duvar modunu durdur', icon: <StopOutlined />, action: 'wall-stop' as PaletteAction }]
      : [{ id: 'act-wall-start', group: 'AKSIYON' as Group,
          label: 'NOC Duvar modunu başlat (auto-rotation)', icon: <MonitorOutlined />, action: 'wall-start' as PaletteAction }]),
  ], [isDark, soundEnabled, wallActive])

  // Cihaz arama — query 2+ karakter ise devicesApi.list (limit 6)
  const { data: deviceRes } = useQuery({
    queryKey: ['cmdk-devices', q],
    queryFn: () => devicesApi.list({ search: q.trim(), limit: 6 }),
    enabled: open && q.trim().length >= 2,
    staleTime: 10_000,
  })
  const deviceCmds: Cmd[] = useMemo(() => {
    const items = deviceRes?.items ?? []
    return items.map((d) => ({
      id: `dev-${d.id}`,
      group: 'CIHAZ' as Group,
      label: `${d.hostname} · ${d.ip_address}${d.vendor ? ' · ' + d.vendor : ''}`,
      icon: <LaptopOutlined />,
      path: `/devices?search=${encodeURIComponent(d.hostname)}`,
      hint: d.status,
    }))
  }, [deviceRes])

  // Filtre: query'ye göre NAV+AKSIYON; CİHAZ zaten server-side filtered
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    const navFiltered = s.length === 0
      ? NAV_COMMANDS.slice(0, 12)   // boş query'de ilk 12 nav
      : NAV_COMMANDS.filter((c) => c.label.toLowerCase().includes(s))
    const actFiltered = s.length === 0
      ? ACTION_COMMANDS
      : ACTION_COMMANDS.filter((c) => c.label.toLowerCase().includes(s))
    return [...navFiltered, ...actFiltered, ...deviceCmds]
  }, [q, ACTION_COMMANDS, deviceCmds])

  // Index clamp filtered değişince
  useEffect(() => { if (idx >= filtered.length) setIdx(0) }, [filtered, idx])

  // Group sırası NAV → AKSIYON → CIHAZ
  const grouped = useMemo(() => {
    const out: Record<Group, Cmd[]> = { NAV: [], AKSIYON: [], CIHAZ: [] }
    for (const c of filtered) out[c.group].push(c)
    return out
  }, [filtered])

  const handle = (c: Cmd) => {
    if (c.path) {
      navigate(c.path); onClose()
    } else if (c.action) {
      onAction(c.action); onClose()
    }
  }

  // Klavye
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(filtered.length - 1, i + 1)) }
      else if (e.key === 'ArrowUp')   { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)) }
      else if (e.key === 'Enter') {
        const sel = filtered[idx]; if (sel) handle(sel)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, idx, filtered])

  if (!open) return null

  let runningIdx = 0
  return (
    <div className="nm-cmdk-scrim open" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="nm-cmdk" onClick={(e) => e.stopPropagation()}>
        <div className="nm-cmdk-search">
          <SearchOutlined style={{ fontSize: 16, color: 'var(--fg-3)' }} />
          <input ref={inputRef} placeholder="Komut, sayfa veya cihaz ara…"
            value={q} onChange={(e) => { setQ(e.target.value); setIdx(0) }} />
          <kbd>esc</kbd>
        </div>
        <div className="nm-cmdk-list">
          {filtered.length === 0 ? (
            <div className="nm-cmdk-empty">Hiçbir sonuç yok</div>
          ) : (
            (Object.entries(grouped) as [Group, Cmd[]][]).map(([group, items]) => {
              if (items.length === 0) return null
              return (
                <div key={group}>
                  <div className="nm-cmdk-group">{group}</div>
                  {items.map((c) => {
                    const i = runningIdx++
                    const isActive = i === idx
                    return (
                      <div key={c.id} className={`nm-cmdk-item ${isActive ? 'active' : ''}`}
                        onMouseEnter={() => setIdx(i)} onClick={() => handle(c)}>
                        <span className="ico">{c.icon}</span>
                        <span style={{ flex: 1 }}>{c.label}</span>
                        {c.hint && <span style={{ fontSize: 10.5, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)', marginRight: 6 }}>{c.hint}</span>}
                        {isActive && <kbd>↵</kbd>}
                      </div>
                    )
                  })}
                </div>
              )
            })
          )}
        </div>
        <div className="nm-cmdk-foot">
          <span><kbd>↑↓</kbd> gez</span>
          <span><kbd>↵</kbd> seç</span>
          <span><kbd>esc</kbd> kapat</span>
          <span style={{ marginLeft: 'auto', color: 'var(--accent)' }}>NetManager · ⌘K</span>
        </div>
      </div>
    </div>
  )
}
