import { useEffect, useRef, useState } from 'react'
import { Input, Modal, Tag, Typography, Spin, Empty } from 'antd'
import {
  LaptopOutlined, CloseCircleOutlined, WarningOutlined, InfoCircleOutlined,
  AppstoreOutlined, ClusterOutlined, DatabaseOutlined, SafetyOutlined,
  RiseOutlined, ApiOutlined, BranchesOutlined, SearchOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { devicesApi } from '@/api/devices'
import { monitorApi } from '@/api/monitor'
import { useTheme } from '@/contexts/ThemeContext'

const { Text } = Typography

const PAGES = [
  { title: 'Cihaz Listesi', path: '/devices', icon: <LaptopOutlined />, keywords: ['cihaz', 'device', 'switch', 'router'] },
  { title: 'IPAM', path: '/ipam', icon: <ClusterOutlined />, keywords: ['ipam', 'ip', 'subnet', 'adres', 'address'] },
  { title: 'VLAN Yönetimi', path: '/vlans', icon: <ApiOutlined />, keywords: ['vlan', 'port', 'trunk', 'access', 'yönetim'] },
  { title: 'Backup Merkezi', path: '/backups', icon: <DatabaseOutlined />, keywords: ['backup', 'yedek', 'merkezi'] },
  { title: 'Uyumluluk Denetimi', path: '/compliance', icon: <SafetyOutlined />, keywords: ['compliance', 'uyum', 'denetim', 'politika', 'güvenlik'] },
  { title: 'SLA & Uptime Raporu', path: '/sla', icon: <RiseOutlined />, keywords: ['sla', 'uptime', 'rapor', 'süre'] },
  { title: 'Topoloji Haritası', path: '/topology', icon: <BranchesOutlined />, keywords: ['topoloji', 'topology', 'harita', 'map'] },
  { title: 'Monitör & Olaylar', path: '/monitor', icon: <AppstoreOutlined />, keywords: ['monitor', 'olay', 'event', 'alarm', 'uyarı'] },
]

interface GlobalSearchModalProps {
  open: boolean
  onClose: () => void
}

export default function GlobalSearchModal({ open, onClose }: GlobalSearchModalProps) {
  const { isDark } = useTheme()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const inputRef = useRef<any>(null)

  const C = isDark
    ? { bg: '#1e293b', border: '#334155', text: '#f1f5f9', muted: '#64748b', hover: '#0f172a', section: '#263148' }
    : { bg: '#ffffff', border: '#e2e8f0', text: '#1e293b', muted: '#64748b', hover: '#f8fafc', section: '#f8fafc' }

  useEffect(() => {
    if (open) {
      setQuery('')
      setTimeout(() => inputRef.current?.focus(), 80)
    }
  }, [open])

  const { data: deviceResults, isFetching: devFetching } = useQuery({
    queryKey: ['global-search-devices', query],
    queryFn: () => devicesApi.list({ search: query.trim(), limit: 6 }),
    enabled: open && query.trim().length >= 2,
    staleTime: 10_000,
  })

  const { data: recentEvents } = useQuery({
    queryKey: ['global-search-events'],
    queryFn: () => monitorApi.getEvents({ limit: 8, unacked_only: true }),
    enabled: open,
    staleTime: 30_000,
  })

  const filteredPages = PAGES.filter((p) => {
    if (!query.trim()) return true
    const q = query.toLowerCase()
    return p.title.toLowerCase().includes(q) || p.keywords.some((k) => k.includes(q))
  })

  const filteredEvents = (recentEvents?.items ?? []).filter((ev) => {
    if (!query.trim()) return true
    const q = query.toLowerCase()
    return ev.title.toLowerCase().includes(q) || (ev.device_hostname?.toLowerCase().includes(q) ?? false)
  })

  const goTo = (path: string, extra?: string) => {
    navigate(extra ? `${path}${extra}` : path)
    onClose()
  }

  const sevIcon = (s: string) => {
    if (s === 'critical') return <CloseCircleOutlined style={{ color: '#ef4444', fontSize: 13 }} />
    if (s === 'warning') return <WarningOutlined style={{ color: '#f59e0b', fontSize: 13 }} />
    return <InfoCircleOutlined style={{ color: '#3b82f6', fontSize: 13 }} />
  }

  const showDevices = query.trim().length >= 2
  const hasDeviceResults = (deviceResults?.items ?? []).length > 0
  const hasEvents = filteredEvents.length > 0
  const hasResults = filteredPages.length > 0 || hasDeviceResults || hasEvents

  const SectionHeader = ({ label }: { label: string }) => (
    <div style={{
      padding: '6px 16px 4px',
      fontSize: 11,
      fontWeight: 700,
      color: C.muted,
      letterSpacing: '0.07em',
      background: C.section,
      borderTop: `1px solid ${C.border}`,
    }}>
      {label}
    </div>
  )

  const ResultRow = ({
    icon, primary, secondary, right, onClick,
  }: {
    icon: React.ReactNode
    primary: string
    secondary?: string
    right?: React.ReactNode
    onClick: () => void
  }) => (
    <div
      onClick={onClick}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 16px', cursor: 'pointer' }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = C.hover }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
    >
      <span style={{ fontSize: 14, flexShrink: 0 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ fontSize: 13, color: C.text, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' }}>
          {primary}
        </Text>
        {secondary && (
          <Text type="secondary" style={{ fontSize: 11 }}>{secondary}</Text>
        )}
      </div>
      {right && <span style={{ flexShrink: 0 }}>{right}</span>}
    </div>
  )

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      closable={false}
      width={580}
      styles={{
        content: { padding: 0, background: C.bg, borderRadius: 12, overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' },
        mask: { backdropFilter: 'blur(2px)' },
      }}
      style={{ top: 120 }}
    >
      {/* Search bar */}
      <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <SearchOutlined style={{ color: C.muted, fontSize: 16, flexShrink: 0 }} />
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Cihaz, VLAN, sayfa, olay ara…"
          variant="borderless"
          style={{ fontSize: 15, color: C.text, background: 'transparent', padding: 0 }}
          onKeyDown={(e) => e.key === 'Escape' && onClose()}
        />
        {devFetching
          ? <Spin size="small" />
          : <Tag style={{ flexShrink: 0, fontSize: 11 }}>ESC</Tag>
        }
      </div>
      <div style={{ borderBottom: `1px solid ${C.border}` }} />

      <div style={{ maxHeight: 460, overflowY: 'auto' }}>
        {/* Pages */}
        {filteredPages.length > 0 && (
          <>
            <SectionHeader label="SAYFALAR" />
            {filteredPages.map((p) => (
              <ResultRow
                key={p.path}
                icon={<span style={{ color: '#3b82f6' }}>{p.icon}</span>}
                primary={p.title}
                right={<Text type="secondary" style={{ fontSize: 11 }}>{p.path}</Text>}
                onClick={() => goTo(p.path)}
              />
            ))}
          </>
        )}

        {/* Devices */}
        {showDevices && (
          <>
            <SectionHeader label="CİHAZLAR" />
            {devFetching ? (
              <div style={{ padding: '12px 16px', textAlign: 'center' }}><Spin size="small" /></div>
            ) : !hasDeviceResults ? (
              <div style={{ padding: '10px 16px', color: C.muted, fontSize: 13 }}>Cihaz bulunamadı</div>
            ) : (
              <>
                {(deviceResults?.items ?? []).map((d) => (
                  <ResultRow
                    key={d.id}
                    icon={
                      <LaptopOutlined style={{
                        color: d.status === 'online' ? '#22c55e' : d.status === 'offline' ? '#ef4444' : '#94a3b8',
                      }} />
                    }
                    primary={d.hostname}
                    secondary={`${d.ip_address}${d.vendor ? ` · ${d.vendor}` : ''}${d.location ? ` · ${d.location}` : ''}`}
                    right={
                      <Tag style={{ fontSize: 10 }} color={d.status === 'online' ? 'green' : d.status === 'offline' ? 'red' : 'default'}>
                        {d.status}
                      </Tag>
                    }
                    onClick={() => goTo('/devices', `?search=${encodeURIComponent(d.hostname)}`)}
                  />
                ))}
                <div
                  onClick={() => goTo('/devices', `?search=${encodeURIComponent(query.trim())}`)}
                  style={{
                    padding: '8px 16px', textAlign: 'center', borderTop: `1px solid ${C.border}`,
                    cursor: 'pointer', color: C.muted, fontSize: 12,
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = C.hover }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                >
                  "{query.trim()}" için tüm sonuçları gör →
                </div>
              </>
            )}
          </>
        )}

        {/* Events */}
        {hasEvents && (
          <>
            <SectionHeader label={query.trim() ? 'OLAYLAR' : 'SON OLAYLAR (onaylanmamış)'} />
            {filteredEvents.slice(0, 5).map((ev) => (
              <ResultRow
                key={ev.id}
                icon={sevIcon(ev.severity)}
                primary={ev.title}
                secondary={ev.device_hostname ?? undefined}
                onClick={() => goTo('/monitor')}
              />
            ))}
          </>
        )}

        {!hasResults && query.trim().length >= 2 && !devFetching && (
          <Empty description="Sonuç bulunamadı" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ padding: '28px 0' }} />
        )}

        <div style={{ padding: '8px 16px', borderTop: `1px solid ${C.border}` }}>
          <Text type="secondary" style={{ fontSize: 11 }}>Enter ile seç · ↑↓ gezin · Esc kapat</Text>
        </div>
      </div>
    </Modal>
  )
}
