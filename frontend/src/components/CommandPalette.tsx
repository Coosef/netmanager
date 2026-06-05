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
import { useTranslation } from 'react-i18next'
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

// Group key'leri (NAV/AKSIYON/CIHAZ) iç enum olarak kalır — kullanıcı
// görmediği teknik gruplama tanımı. UI etiketleri command.group.* keys
// üzerinden t() ile çevrilir.
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
  const { t } = useTranslation()
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQ(''); setIdx(0)
    const tm = setTimeout(() => inputRef.current?.focus(), 50)
    return () => clearTimeout(tm)
  }, [open])

  // NAV komutları — t()'a bağımlı olduğu için component içinde useMemo.
  const NAV_COMMANDS: Cmd[] = useMemo(() => [
    { id: 'nav-/',              group: 'NAV', label: t('command.nav.dashboard'),         icon: <DashboardOutlined />,    path: '/' },
    { id: 'nav-monitor',        group: 'NAV', label: t('command.nav.monitor'),           icon: <AlertOutlined />,        path: '/monitor' },
    { id: 'nav-topology',       group: 'NAV', label: t('command.nav.topology'),          icon: <ApartmentOutlined />,    path: '/topology' },
    { id: 'nav-topology-next',  group: 'NAV', label: t('command.nav.topology_next'),     icon: <ThunderboltOutlined />,  path: '/topology-next' },
    { id: 'nav-devices',        group: 'NAV', label: t('command.nav.devices'),           icon: <LaptopOutlined />,       path: '/devices' },
    { id: 'nav-discovery',      group: 'NAV', label: t('command.nav.discovery'),         icon: <RadarChartOutlined />,   path: '/discovery' },
    { id: 'nav-ipam',           group: 'NAV', label: t('command.nav.ipam'),              icon: <ClusterOutlined />,      path: '/ipam' },
    { id: 'nav-vlan',           group: 'NAV', label: t('command.nav.vlan'),              icon: <BranchesOutlined />,     path: '/vlan' },
    { id: 'nav-backups',        group: 'NAV', label: t('command.nav.backups'),           icon: <CloudOutlined />,        path: '/backups' },
    { id: 'nav-config-drift',   group: 'NAV', label: t('command.nav.config_drift'),      icon: <DiffOutlined />,         path: '/config-drift' },
    { id: 'nav-compliance',     group: 'NAV', label: t('command.nav.compliance'),        icon: <FileDoneOutlined />,     path: '/compliance' },
    { id: 'nav-racks',          group: 'NAV', label: t('command.nav.racks'),             icon: <HddOutlined />,          path: '/racks' },
    { id: 'nav-floor-plan',     group: 'NAV', label: t('command.nav.floor_plan'),        icon: <BuildOutlined />,        path: '/floor-plan' },
    { id: 'nav-intelligence',   group: 'NAV', label: t('command.nav.intelligence'),      icon: <BugOutlined />,          path: '/intelligence' },
    { id: 'nav-alert-rules',    group: 'NAV', label: t('command.nav.alert_rules'),       icon: <AlertOutlined />,        path: '/alert-rules' },
    { id: 'nav-bandwidth',      group: 'NAV', label: t('command.nav.bandwidth'),         icon: <BarChartOutlined />,     path: '/bandwidth' },
    { id: 'nav-mac-arp',        group: 'NAV', label: t('command.nav.port_intelligence'), icon: <TableOutlined />,        path: '/mac-arp' },
    { id: 'nav-security-audit', group: 'NAV', label: t('command.nav.security_audit'),    icon: <SafetyOutlined />,       path: '/security-audit' },
    { id: 'nav-asset',          group: 'NAV', label: t('command.nav.asset_lifecycle'),   icon: <CalendarOutlined />,     path: '/asset-lifecycle' },
    { id: 'nav-diagnostics',    group: 'NAV', label: t('command.nav.diagnostics'),       icon: <AimOutlined />,          path: '/diagnostics' },
    { id: 'nav-tasks',          group: 'NAV', label: t('command.nav.tasks'),             icon: <PlayCircleOutlined />,   path: '/tasks' },
    { id: 'nav-playbooks',      group: 'NAV', label: t('command.nav.playbooks'),         icon: <ThunderboltOutlined />,  path: '/playbooks' },
    { id: 'nav-templates',      group: 'NAV', label: t('command.nav.config_templates'),  icon: <FileTextOutlined />,     path: '/config-templates' },
    { id: 'nav-approvals',      group: 'NAV', label: t('command.nav.approvals'),         icon: <SafetyOutlined />,       path: '/approvals' },
    { id: 'nav-sla',            group: 'NAV', label: t('command.nav.sla'),               icon: <RiseOutlined />,         path: '/sla' },
    { id: 'nav-probes',         group: 'NAV', label: t('command.nav.synthetic_probes'),  icon: <RadarChartOutlined />,   path: '/synthetic-probes' },
    { id: 'nav-incidents',      group: 'NAV', label: t('command.nav.incident_rca'),      icon: <BugOutlined />,          path: '/incidents' },
    { id: 'nav-escalation',     group: 'NAV', label: t('command.nav.escalation_rules'),  icon: <BellOutlined />,         path: '/escalation-rules' },
    { id: 'nav-services',       group: 'NAV', label: t('command.nav.service_impact'),    icon: <ApartmentOutlined />,    path: '/services' },
    { id: 'nav-twin',           group: 'NAV', label: t('command.nav.network_twin'),      icon: <ApartmentOutlined />,    path: '/topology-twin' },
    { id: 'nav-reports',        group: 'NAV', label: t('command.nav.reports'),           icon: <BarChartOutlined />,     path: '/reports' },
    { id: 'nav-audit',          group: 'NAV', label: t('command.nav.audit'),             icon: <SafetyOutlined />,       path: '/audit' },
    { id: 'nav-settings',       group: 'NAV', label: t('command.nav.settings'),          icon: <SettingOutlined />,      path: '/settings' },
  ], [t])

  // Aksiyon komutları — durum değişkenlerine göre dinamik etiketler.
  const ACTION_COMMANDS: Cmd[] = useMemo(() => [
    { id: 'act-theme', group: 'AKSIYON',
      label: isDark ? t('command.action.theme_to_light') : t('command.action.theme_to_dark'),
      icon: isDark ? <SunOutlined /> : <MoonOutlined />, action: 'theme' },
    { id: 'act-customize', group: 'AKSIYON',
      label: t('command.action.open_customize'),
      icon: <BgColorsOutlined />, action: 'customize' },
    { id: 'act-sound', group: 'AKSIYON',
      label: soundEnabled ? t('command.action.sound_off') : t('command.action.sound_on'),
      icon: soundEnabled ? <NotificationOutlined /> : <SoundOutlined />, action: 'sound-toggle' },
    ...(wallActive
      ? [{ id: 'act-wall-stop', group: 'AKSIYON' as Group,
          label: t('command.action.wall_stop'), icon: <StopOutlined />, action: 'wall-stop' as PaletteAction }]
      : [{ id: 'act-wall-start', group: 'AKSIYON' as Group,
          label: t('command.action.wall_start'), icon: <MonitorOutlined />, action: 'wall-start' as PaletteAction }]),
  ], [t, isDark, soundEnabled, wallActive])

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

  const groupLabel = (g: Group): string => {
    if (g === 'NAV') return t('command.group.nav')
    if (g === 'AKSIYON') return t('command.group.action')
    return t('command.group.device')
  }

  let runningIdx = 0
  return (
    <div className="nm-cmdk-scrim open" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="nm-cmdk" onClick={(e) => e.stopPropagation()}>
        <div className="nm-cmdk-search">
          <SearchOutlined style={{ fontSize: 16, color: 'var(--fg-3)' }} />
          <input ref={inputRef} placeholder={t('command.search_placeholder')}
            value={q} onChange={(e) => { setQ(e.target.value); setIdx(0) }} />
          <kbd>esc</kbd>
        </div>
        <div className="nm-cmdk-list">
          {filtered.length === 0 ? (
            <div className="nm-cmdk-empty">{t('command.no_results')}</div>
          ) : (
            (Object.entries(grouped) as [Group, Cmd[]][]).map(([group, items]) => {
              if (items.length === 0) return null
              return (
                <div key={group}>
                  <div className="nm-cmdk-group">{groupLabel(group)}</div>
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
          <span><kbd>↑↓</kbd> {t('command.foot.navigate')}</span>
          <span><kbd>↵</kbd> {t('command.foot.select')}</span>
          <span><kbd>esc</kbd> {t('command.foot.close')}</span>
          <span style={{ marginLeft: 'auto', color: 'var(--accent)' }}>Charon · ⌘K</span>
        </div>
      </div>
    </div>
  )
}
