/**
 * T10 C7.B — Device Detail Page.
 *
 * Route: /devices/:deviceId. Kalıcı sekmeli sayfa. URL ?tab= ile derin link.
 * Wave 2 #2 F1 (2026-06-01) — Header NetManager mockup'a göre refactor edildi:
 *  - .nm-page-hd / .title-block / .nm-page-title / .nm-page-actions
 *  - Vendor badge (.nm-vendor.cisco/.aruba/.ruijie + ek vendor'lar)
 *  - Risk pill: devicesApi.getHealthScores() fleet endpoint'inden cihaz score'u filter
 *  - Quick Actions tray: Yedek Al / SSH Aç / Yenile (mockup pages-devices.jsx:347-351)
 * AntD Tabs (Wave 1) korunur.
 */
import { useMemo } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useOperationsNavigate } from '@/hooks/useOperationsNavigate'
import { Spin, Result, Tabs, App } from 'antd'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { devicesApi } from '@/api/devices'
import { useSite } from '@/contexts/SiteContext'
import { DETAIL_TABS, normalizeTab, type TabKey } from './detail/_tabs'
import OverviewTab from './detail/OverviewTab'
import SecurityPoliciesTab from './detail/SecurityPoliciesTab'
import PortsTab from './detail/PortsTab'
import VlanTab from './detail/VlanTab'
import MacTab from './detail/MacTab'
import PoeTab from './detail/PoeTab'
import EventsTab from './detail/EventsTab'
import BackupTab from './detail/BackupTab'
import ActionsTab from './detail/ActionsTab'
import TerminalTab from './detail/TerminalTab'
import dayjs from 'dayjs'

/** Wave 2 #2 F1: status → .nm-status-dot class. KURAL-E1: TR etiketler
 *  component içinde useMemo + t() ile çözülür; module-level literal yok. */
const STATUS_CLS: Record<string, 'ok' | 'crit' | 'warn' | ''> = {
  online: 'ok', offline: 'crit', unreachable: 'warn', unknown: '',
}

/** Wave 2 #2 F1: getHealthScores score → risk pill class + i18n key.
 *  KURAL-E1: etiket TR literal değil; render-time t() ile çevrilir. */
function riskFromScore(score: number | null): { cls: 'ok' | 'warn' | 'crit'; labelKey: string } | null {
  if (score === null || score === undefined) return null
  if (score >= 80) return { cls: 'ok',   labelKey: 'devices.detail.risk.healthy' }
  if (score >= 50) return { cls: 'warn', labelKey: 'devices.detail.risk.watch' }
  return { cls: 'crit', labelKey: 'devices.detail.risk.critical' }
}

export default function DeviceDetailPage() {
  const { deviceId } = useParams<{ deviceId: string }>()
  // PR-A2 — operations-aware navigation. Inside /app/org/:id/devices/:deviceId,
  // "back to list" must return to /app/org/:id/devices (not legacy /devices).
  const opsNavigate = useOperationsNavigate()
  const qc = useQueryClient()
  const { message } = App.useApp()
  const { t } = useTranslation()
  const [search, setSearch] = useSearchParams()
  const id = Number(deviceId)

  // KURAL-E1: status label haritası hook scope'unda useMemo ile.
  const STATUS_LABEL = useMemo<Record<string, string>>(() => ({
    online:      t('devices.status.online'),
    offline:     t('devices.status.offline'),
    unreachable: t('devices.status.unreachable'),
    unknown:     t('common.unknown'),
  }), [t])

  const { data: device, isLoading, error } = useQuery({
    queryKey: ['device', id],
    queryFn: () => devicesApi.get(id),
    enabled: Number.isFinite(id) && id > 0,
  })

  // Wave 2 #2 F1 — Fleet getHealthScores cache (5dk staleTime), cihaz score'u filter.
  const { data: healthData } = useQuery({
    queryKey: ['device-health-scores-fleet'],
    queryFn: () => devicesApi.getHealthScores(),
    staleTime: 5 * 60_000,
    enabled: Number.isFinite(id) && id > 0,
  })
  const healthScore = useMemo(
    () => healthData?.items.find((i) => i.device_id === id)?.score ?? null,
    [healthData, id],
  )
  const risk = riskFromScore(healthScore)

  // Wave 2 #2 F1 — Quick Action: Yedek Al
  const takeBackupMut = useMutation({
    mutationFn: () => devicesApi.takeBackup(id),
    onSuccess: () => {
      message.success(t('devices.detail.toast.backup_triggered'))
      qc.invalidateQueries({ queryKey: ['device-backups', id] })
      qc.invalidateQueries({ queryKey: ['device', id] })
    },
    onError: (e: any) => {
      const detail = e?.response?.data?.detail || t('devices.detail.toast.backup_failed')
      if (typeof detail === 'string' && detail.includes("hasn't changed")) {
        message.info(t('devices.detail.toast.backup_no_change'))
      } else {
        message.error(detail)
      }
    },
  })

  // Wave 2 #2 F1 — Quick Action: Yenile (invalidate tüm device-* query'leri)
  const handleRefresh = () => {
    qc.invalidateQueries({ queryKey: ['device', id] })
    qc.invalidateQueries({ queryKey: ['device-interfaces', id] })
    qc.invalidateQueries({ queryKey: ['device-vlans', id] })
    qc.invalidateQueries({ queryKey: ['device-backups', id] })
    qc.invalidateQueries({ queryKey: ['device-events', id] })
    message.success(t('devices.detail.toast.data_refreshed'))
  }

  // Feature gate: security_policy explicit false ise Güvenlik Politikası sekmesi gizlenir.
  const { features } = useSite()
  const secPolEnabled = features['security_policy'] !== false
  const visibleTabs = useMemo(
    () => DETAIL_TABS.filter((t) => t.key !== 'security' || secPolEnabled),
    [secPolEnabled],
  )

  const activeTab: TabKey = useMemo(() => {
    const t = normalizeTab(search.get('tab'))
    // İstenen tab gizliyse (örn. security gate kapalı) overview'a düş.
    return visibleTabs.some((v) => v.key === t) ? t : 'overview'
  }, [search, visibleTabs])
  const setTab = (key: string) => {
    const next = new URLSearchParams(search)
    next.set('tab', key)
    setSearch(next, { replace: true })
  }

  if (!Number.isFinite(id) || id <= 0) {
    return (
      <div style={{ padding: 24 }}>
        <Result status="404" title={t('devices.detail.invalid_id')} extra={
          <button className="nm-btn" onClick={() => opsNavigate('/devices')}>{t('devices.detail.back_to_list')}</button>
        } />
      </div>
    )
  }
  if (isLoading) return <div style={{ padding: 24 }}><Spin /> {t('devices.detail.loading')}</div>
  if (error || !device) {
    return (
      <div style={{ padding: 24 }}>
        <Result status="404" title={t('devices.detail.not_found_title')}
          subTitle={t('devices.detail.not_found_desc')}
          extra={<button className="nm-btn" onClick={() => opsNavigate('/devices')}>{t('devices.detail.back_to_list')}</button>} />
      </div>
    )
  }

  const statusCls = STATUS_CLS[device.status] ?? ''
  const statusLabel = STATUS_LABEL[device.status] ?? STATUS_LABEL.unknown
  const vendorClass = (device.vendor || 'generic').toLowerCase().replace(/[^a-z]/g, '')

  // KURAL-E1: tab item üretimi render-time t() ile. Iç içe yerel `t` değişkeni
  // kullanırken outer useTranslation `t`'ini gölgelemesin diye `tab` adıyla.
  const tabItems = visibleTabs.map((tab) => ({
    key: tab.key,
    label: t(tab.labelKey) + (tab.placeholder ? ' ·' : ''),
    children: (() => {
      if (tab.key === 'overview') return <OverviewTab device={device} />
      if (tab.key === 'security') return <SecurityPoliciesTab device={device} />
      if (tab.key === 'ports') return <PortsTab device={device} />
      if (tab.key === 'vlan') return <VlanTab device={device} />
      if (tab.key === 'mac') return <MacTab device={device} />
      if (tab.key === 'poe') return <PoeTab device={device} />
      if (tab.key === 'events') return <EventsTab device={device} />
      if (tab.key === 'backup') return <BackupTab device={device} />
      if (tab.key === 'actions') return <ActionsTab device={device} />
      if (tab.key === 'terminal') return <TerminalTab device={device} />
      return null  // tüm sekmeler artık live; placeholder yok
    })(),
  }))

  return (
    <div style={{ padding: 16 }}>
      {/* Wave 2 #2 F1 — Header (NetManager mockup pages-devices.jsx:328-345 paterni) */}
      <div className="nm-page-hd" style={{ marginBottom: 16 }}>
        <div className="title-block">
          <div className="nm-crumbs">
            <span
              onClick={() => opsNavigate('/devices')}
              style={{ cursor: 'pointer' }}
            >{t('devices.crumb_devices')}</span>
            {' › '}
            <span>{device.hostname || device.ip_address}</span>
          </div>
          <h1 className="nm-page-title">
            {device.hostname || device.ip_address}
            {risk && <span className={`nm-risk-pill ${risk.cls}`}>{t(risk.labelKey)}</span>}
            {device.lifecycle_status && device.lifecycle_status !== 'production' && (
              <span className="nm-pill">{device.lifecycle_status}</span>
            )}
          </h1>
          <div style={{
            fontSize: 12.5, color: 'var(--fg-2)',
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
            marginTop: 6,
          }}>
            <span className={`nm-status-dot ${statusCls}${statusCls === 'ok' || statusCls === 'crit' ? ' pulse' : ''}`}></span>
            <span>{statusLabel}</span>
            <span style={{ color: 'var(--fg-3)' }}>·</span>
            <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{device.ip_address}</code>
            {device.vendor && (
              <>
                <span style={{ color: 'var(--fg-3)' }}>·</span>
                <span className={`nm-vendor ${vendorClass}`}>{device.vendor}</span>
              </>
            )}
            {device.os_type && (
              <>
                <span style={{ color: 'var(--fg-3)' }}>·</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{device.os_type}</span>
              </>
            )}
            {device.site && (
              <>
                <span style={{ color: 'var(--fg-3)' }}>·</span>
                <span>{device.site}</span>
              </>
            )}
            {device.last_seen && (
              <>
                <span style={{ color: 'var(--fg-3)' }}>·</span>
                <span style={{ color: 'var(--fg-3)' }}>{dayjs(device.last_seen).fromNow()}</span>
              </>
            )}
          </div>
        </div>
        <div className="nm-page-actions">
          <button
            className="nm-btn ghost"
            onClick={() => takeBackupMut.mutate()}
            disabled={takeBackupMut.isPending}
            title={t('devices.detail.actions.backup_tooltip')}
          >
            {takeBackupMut.isPending ? t('devices.detail.actions.backup_loading') : t('devices.detail.actions.backup_btn')}
          </button>
          <button
            className="nm-btn ghost"
            onClick={() => setTab('terminal')}
            title={t('devices.detail.actions.ssh_tooltip')}
          >
            {t('devices.detail.actions.ssh_btn')}
          </button>
          <button
            className="nm-btn"
            onClick={handleRefresh}
            title={t('devices.detail.actions.refresh_tooltip')}
          >
            {t('devices.detail.actions.refresh_btn')}
          </button>
        </div>
      </div>
      <Tabs activeKey={activeTab} onChange={setTab} items={tabItems} destroyInactiveTabPane={false} />
    </div>
  )
}
