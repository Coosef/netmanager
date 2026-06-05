/**
 * T10 C7.B — Device Detail > Genel sekmesi.
 *
 * Cihaz meta + status + lokasyon hiyerarşi + agent + lifecycle özeti. Read-only;
 * düzenleme mevcut Hızlı Düzenle Drawer'ında (cihaz listesi). Veri devicesApi.get(id).
 *
 * Wave 2 #2 F2 (2026-06-01) — NetManager mockup'tan KPI Status Cards üstüne
 * eklendi (pages-switch.jsx:173-181 + pages-devices.jsx:113-145 paterni):
 *   Aktif Port · Err / Down · PoE Port · Toplam Güç · VLAN · Son Backup
 * Veri kaynakları paralel useQuery (cache key'ler diğer tab'larla paylaşılır).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Descriptions, Tag, Badge } from 'antd'
import { StarFilled } from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { Device } from '@/types'
import { devicesApi } from '@/api/devices'
import { poeApi } from '@/api/poe'
import { snmpApi } from '@/api/snmp'
import { monitorApi } from '@/api/monitor'
import Sparkline from './_sparkline'
import Donut from './_donut'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'

dayjs.extend(relativeTime)

/** Wave 2 #2 F3 — CPU/RAM threshold sınıfı (mockup pages-devices.jsx:467-489). */
function healthClass(pct: number | null | undefined): 'ok' | 'warn' | 'crit' | '' {
  if (pct === null || pct === undefined) return ''
  if (pct >= 85) return 'crit'
  if (pct >= 60) return 'warn'
  return 'ok'
}

const STATUS_COLOR: Record<string, 'success' | 'error' | 'warning' | 'default'> = {
  online: 'success', offline: 'error', unreachable: 'warning', unknown: 'default',
}

function fmt(v?: string | null | undefined): string {
  if (!v) return '—'
  return v
}

function fmtDate(v?: string | null | undefined): string {
  if (!v) return '—'
  const d = dayjs(v)
  return d.isValid() ? `${d.format('YYYY-MM-DD HH:mm')} (${d.fromNow()})` : v
}

/** Wave 2 #2 F2 — Backup yaşı "tazelik" sınıfı: <24h ok / <7g warn / üstü crit. */
function backupFreshnessClass(lastBackup?: string | null): 'ok' | 'warn' | 'crit' | '' {
  if (!lastBackup) return ''
  const d = dayjs(lastBackup)
  if (!d.isValid()) return ''
  const hoursOld = dayjs().diff(d, 'hour')
  if (hoursOld < 24) return 'ok'
  if (hoursOld < 24 * 7) return 'warn'
  return 'crit'
}

export default function OverviewTab({ device }: { device: Device }) {
  const { t } = useTranslation()
  // Wave 2 #2 F2 — Status Cards veri kaynakları (paralel useQuery).
  // queryKey'ler diğer tab'lardakiyle PAYLAŞIMLI → cache hit, duplicate fetch yok.
  const ifaceQ = useQuery({
    queryKey: ['device-interfaces', device.id],
    queryFn: () => devicesApi.getInterfaces(device.id),
    enabled: device.id > 0,
    staleTime: 60_000,
  })
  const vlanQ = useQuery({
    queryKey: ['device-vlans', device.id],
    queryFn: () => devicesApi.getVlans(device.id),
    enabled: device.id > 0,
    staleTime: 60_000,
  })
  const backupsQ = useQuery({
    queryKey: ['device-backups', device.id],
    queryFn: () => devicesApi.getBackups(device.id),
    enabled: device.id > 0,
    staleTime: 60_000,
  })
  const poeQ = useQuery({
    queryKey: ['poe-device', device.id],
    queryFn: () => poeApi.device(device.id),
    enabled: device.id > 0,
    staleTime: 60_000,
    retry: false,  // PoE'siz cihaz 404 dönerse skip
  })

  // Wave 2 #2 F3 — SNMP CPU/RAM polling (60s refetchInterval) + client-side history
  const cpuRamQ = useQuery({
    queryKey: ['snmp-cpu-ram', device.id],
    queryFn: () => snmpApi.getCpuRam(device.id),
    enabled: device.id > 0 && !!device.snmp_enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
  })
  const [cpuHistory, setCpuHistory] = useState<number[]>([])
  const [ramHistory, setRamHistory] = useState<number[]>([])
  const lastTsRef = useRef<number | null>(null)
  useEffect(() => {
    if (!cpuRamQ.data) return
    // Aynı snapshot üzerinde tekrar push olmasın; dataUpdatedAt referansı yeterli.
    const ts = cpuRamQ.dataUpdatedAt
    if (lastTsRef.current === ts) return
    lastTsRef.current = ts
    if (typeof cpuRamQ.data.cpu_pct === 'number') {
      setCpuHistory((h) => [...h, cpuRamQ.data!.cpu_pct!].slice(-20))
    }
    if (typeof cpuRamQ.data.ram_pct === 'number') {
      setRamHistory((h) => [...h, cpuRamQ.data!.ram_pct!].slice(-20))
    }
  }, [cpuRamQ.dataUpdatedAt, cpuRamQ.data])

  // Wave 2 #2 F3 — Son 24sa events (severity bazında aggregate). queryKey EventsTab'la
  // benzer ama farklı parametreler (hours=24 fix); cache çakışmaz.
  const eventsQ = useQuery({
    queryKey: ['device-events-overview', device.id],
    queryFn: () => monitorApi.getEvents({
      device_id: device.id, hours: 24, limit: 500,
    }),
    enabled: device.id > 0,
    staleTime: 60_000,
  })
  const eventStats = useMemo(() => {
    const items = eventsQ.data?.items ?? []
    return {
      total: items.length,
      critical: items.filter((e) => e.severity === 'critical').length,
      warning: items.filter((e) => e.severity === 'warning').length,
      info: items.filter((e) => e.severity === 'info').length,
    }
  }, [eventsQ.data?.items])

  // Wave 2 #2 F4 — Availability/SLA (devicesApi.getAvailability, 30g pencere)
  const availQ = useQuery({
    queryKey: ['device-availability', device.id, 30],
    queryFn: () => devicesApi.getAvailability(device.id, 30),
    enabled: device.id > 0,
    staleTime: 5 * 60_000,
  })

  const stats = useMemo(() => {
    const ifaces = ifaceQ.data?.interfaces ?? []
    const upCount = ifaces.filter((i) =>
      /up|connected|forwarding/i.test(i.status || '')).length
    const errCount = ifaces.filter((i) =>
      /err|disabled|down|notconnect/i.test(i.status || '')).length
    const poeActivePorts = poeQ.data?.ports?.filter(
      (p) => /on|enabled|active/i.test(p.oper_status || ''),
    ).length ?? null
    const totalPowerW = poeQ.data?.summary?.total_power_watts ?? null
    const vlans = vlanQ.data?.vlans ?? []
    const backups = backupsQ.data ?? []
    const lastBackup = backups[0]
    return {
      totalPorts: ifaces.length,
      upCount, errCount,
      poeActivePorts,
      totalPowerW,
      vlanCount: vlans.length,
      lastBackup,
      isGolden: lastBackup?.is_golden ?? false,
    }
  }, [ifaceQ.data, vlanQ.data, backupsQ.data, poeQ.data])

  const backupClass = backupFreshnessClass(stats.lastBackup?.created_at)

  return (
    <div style={{ padding: '4px 0 16px' }}>
      {/* Wave 2 #2 F2 — Status Cards (6 KPI satırı) */}
      <div className="nm-statbar" style={{ marginBottom: 16 }}>
        <div className={`nm-stat ${stats.upCount > 0 ? 'ok' : ''}`}>
          <div className="nm-stat-label">{t('devices.detail.overview.active_port')}</div>
          <div className="nm-stat-val">
            {stats.upCount}
            {stats.totalPorts > 0 && <small> / {stats.totalPorts}</small>}
          </div>
          <div className="nm-stat-delta">
            {ifaceQ.isLoading ? t('common.loading') : ifaceQ.data?.cached ? t('devices.detail.overview.cache') : t('devices.detail.overview.live')}
          </div>
        </div>

        <div className={`nm-stat ${stats.errCount > 0 ? 'crit' : ''}`}>
          <div className="nm-stat-label">{t('devices.detail.overview.err_down')}</div>
          <div className="nm-stat-val">{stats.errCount}</div>
          <div className="nm-stat-delta">err-disabled / notconnect</div>
        </div>

        <div className={`nm-stat ${(stats.poeActivePorts ?? 0) > 0 ? 'ok' : ''}`}>
          <div className="nm-stat-label">{t('devices.detail.overview.poe_port')}</div>
          <div className="nm-stat-val">{stats.poeActivePorts ?? '—'}</div>
          <div className="nm-stat-delta">{t('devices.detail.overview.poe_serving')}</div>
        </div>

        <div className={`nm-stat ${stats.totalPowerW !== null && stats.totalPowerW > 100 ? 'warn' : ''}`}>
          <div className="nm-stat-label">{t('devices.detail.overview.total_power')}</div>
          <div className="nm-stat-val">
            {stats.totalPowerW !== null ? Math.round(stats.totalPowerW) : '—'}
            <small> W</small>
          </div>
          <div className="nm-stat-delta">{t('devices.detail.overview.poe_budget')}</div>
        </div>

        <div className="nm-stat">
          <div className="nm-stat-label">VLAN</div>
          <div className="nm-stat-val">{stats.vlanCount}</div>
          <div className="nm-stat-delta">{t('devices.detail.overview.defined')}</div>
        </div>

        <div className={`nm-stat ${backupClass}`}>
          <div className="nm-stat-label">
            {t('devices.detail.overview.last_backup')} {stats.isGolden && <StarFilled style={{ color: '#faad14', fontSize: 11, marginLeft: 4 }} />}
          </div>
          <div className="nm-stat-val">
            {stats.lastBackup?.created_at
              ? <span style={{ fontSize: 18 }}>{dayjs(stats.lastBackup.created_at).fromNow(true)}</span>
              : '—'}
          </div>
          <div className="nm-stat-delta">
            {stats.lastBackup?.created_at
              ? dayjs(stats.lastBackup.created_at).format('YYYY-MM-DD HH:mm')
              : t('devices.detail.overview.no_backup')}
          </div>
        </div>
      </div>

      {/* Wave 2 #2 F3 — Sistem Sağlığı (SNMP CPU/RAM + sparkline) */}
      {device.snmp_enabled && (
        <div className="nm-card" style={{
          padding: 14, marginBottom: 16, border: '1px solid var(--line-soft)',
          borderRadius: 8, background: 'var(--bg-1)',
        }}>
          <div style={{
            fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.06,
            color: 'var(--fg-3)', marginBottom: 10, fontWeight: 600,
          }}>
            {t('devices.detail.overview.system_health_snmp')}
            {cpuRamQ.isFetching && (
              <span style={{ marginLeft: 8, fontWeight: 400, fontSize: 10 }}>
                {t('devices.detail.overview.refreshing_dot')}
              </span>
            )}
          </div>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12,
          }}>
            <div className={`nm-stat ${healthClass(cpuRamQ.data?.cpu_pct)}`}
                 style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <div style={{ flex: 1 }}>
                <div className="nm-stat-label">CPU</div>
                <div className="nm-stat-val">
                  {cpuRamQ.data?.cpu_pct !== null && cpuRamQ.data?.cpu_pct !== undefined
                    ? <>{cpuRamQ.data.cpu_pct.toFixed(0)}<small>%</small></>
                    : '—'}
                </div>
                <div className="nm-stat-delta">{t('devices.detail.overview.last_n_samples', { count: cpuHistory.length })}</div>
              </div>
              <Sparkline data={cpuHistory} color="var(--accent, #22d3c5)" yMin={0} yMax={100} fill />
            </div>
            <div className={`nm-stat ${healthClass(cpuRamQ.data?.ram_pct)}`}
                 style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <div style={{ flex: 1 }}>
                <div className="nm-stat-label">RAM</div>
                <div className="nm-stat-val">
                  {cpuRamQ.data?.ram_pct !== null && cpuRamQ.data?.ram_pct !== undefined
                    ? <>{cpuRamQ.data.ram_pct.toFixed(0)}<small>%</small></>
                    : '—'}
                </div>
                <div className="nm-stat-delta">
                  {cpuRamQ.data?.ram_used_mb !== null && cpuRamQ.data?.ram_total_mb !== null
                    ? `${cpuRamQ.data?.ram_used_mb} / ${cpuRamQ.data?.ram_total_mb} MB`
                    : t('devices.detail.overview.no_usage_info')}
                </div>
              </div>
              <Sparkline data={ramHistory} color="var(--warn, #f59e0b)" yMin={0} yMax={100} fill />
            </div>
          </div>
          {!cpuRamQ.data?.cpu_pct && !cpuRamQ.isLoading && (
            <div style={{ marginTop: 10, fontSize: 11, color: 'var(--fg-3)' }}>
              {t('devices.detail.overview.cpu_ram_no_data')}
            </div>
          )}
        </div>
      )}

      {/* Wave 2 #2 F3 — 24sa Olay Özeti */}
      <div className="nm-card" style={{
        padding: 14, marginBottom: 16, border: '1px solid var(--line-soft)',
        borderRadius: 8, background: 'var(--bg-1)',
      }}>
        <div style={{
          fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.06,
          color: 'var(--fg-3)', marginBottom: 10, fontWeight: 600,
        }}>
          {t('devices.detail.overview.events_24h_title')}
          {eventsQ.isFetching && (
            <span style={{ marginLeft: 8, fontWeight: 400, fontSize: 10 }}>
              {t('devices.detail.overview.refreshing_dot')}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 28, fontWeight: 500, fontFamily: 'var(--font-mono)' }}>
            {eventStats.total}
          </div>
          <div style={{ fontSize: 11, color: 'var(--fg-3)' }}>
            {t('devices.detail.overview.events_24h_caption_1')}<br />{t('devices.detail.overview.events_24h_caption_2')}
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <span className="nm-pill crit">{t('devices.detail.overview.events_critical', { count: eventStats.critical })}</span>
            <span className="nm-pill warn">{t('devices.detail.overview.events_warning', { count: eventStats.warning })}</span>
            <span className="nm-pill">{t('devices.detail.overview.events_info', { count: eventStats.info })}</span>
          </div>
        </div>
      </div>

      {/* Wave 2 #2 F4 — SLA / Availability (mockup pages-devices.jsx:547-576) */}
      <div className="nm-card" style={{
        padding: 14, marginBottom: 16, border: '1px solid var(--line-soft)',
        borderRadius: 8, background: 'var(--bg-1)',
      }}>
        <div style={{
          fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.06,
          color: 'var(--fg-3)', marginBottom: 14, fontWeight: 600,
        }}>
          {t('devices.detail.overview.sla_availability')}
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap',
        }}>
          <Donut value={availQ.data?.current?.availability_7d ?? null} label={t('devices.detail.overview.donut_label')} />
          <div style={{ display: 'grid', gridTemplateColumns: 'auto auto', gap: '6px 14px', fontSize: 12 }}>
            <span style={{ color: 'var(--fg-3)' }}>{t('devices.detail.overview.uptime_7d')}</span>
            <span style={{ fontFamily: 'var(--font-mono)' }}>
              {availQ.data?.current?.availability_7d?.toFixed(2) ?? '—'}%
            </span>
            <span style={{ color: 'var(--fg-3)' }}>{t('devices.detail.overview.uptime_30d')}</span>
            <span style={{ fontFamily: 'var(--font-mono)' }}>
              {availQ.data?.current?.availability_24h !== null
                ? availQ.data?.current?.availability_24h?.toFixed(2)
                : '—'}%
            </span>
            <span style={{ color: 'var(--fg-3)' }}>{t('devices.detail.overview.mtbf_hours')}</span>
            <span style={{ fontFamily: 'var(--font-mono)' }}>
              {availQ.data?.current?.mtbf_hours?.toFixed(1) ?? '—'}
            </span>
            <span style={{ color: 'var(--fg-3)' }}>{t('devices.detail.overview.experience_score')}</span>
            <span style={{ fontFamily: 'var(--font-mono)' }}>
              {availQ.data?.current?.experience_score?.toFixed(0) ?? '—'} / 100
            </span>
            <span style={{ color: 'var(--fg-3)' }}>{t('devices.detail.overview.sla_target')}</span>
            <span style={{ fontFamily: 'var(--font-mono)' }}>99.00%</span>
          </div>
        </div>
      </div>

      <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}
                    labelStyle={{ width: 160, fontWeight: 500 }}>
        <Descriptions.Item label={t('common.status')}>
          <Badge status={STATUS_COLOR[device.status] ?? 'default'} text={device.status} />
        </Descriptions.Item>
        <Descriptions.Item label={t('devices.detail.overview.lifecycle')}>
          <Tag color={device.lifecycle_status === 'archived' ? 'default'
                    : device.lifecycle_status === 'production' ? 'green'
                    : device.lifecycle_status === 'passive' ? 'orange'
                    : 'blue'}>
            {fmt(device.lifecycle_status)}
          </Tag>
        </Descriptions.Item>
        <Descriptions.Item label={t('devices.detail.overview.is_active')}>
          {device.is_active ? <Tag color="green">{t('devices.detail.overview.tag_active')}</Tag> : <Tag>{t('devices.detail.overview.tag_passive')}</Tag>}
        </Descriptions.Item>

        <Descriptions.Item label={t('common.hostname')}>{fmt(device.hostname)}</Descriptions.Item>
        <Descriptions.Item label={t('devices.form.alias')}>{fmt(device.alias)}</Descriptions.Item>
        <Descriptions.Item label="IP">{fmt(device.ip_address)}</Descriptions.Item>

        <Descriptions.Item label={t('common.vendor')}>{fmt(device.vendor)}</Descriptions.Item>
        <Descriptions.Item label={t('devices.form.os_type')}>{fmt(device.os_type)}</Descriptions.Item>
        <Descriptions.Item label={t('common.model')}>{fmt(device.model)}</Descriptions.Item>

        <Descriptions.Item label={t('common.location')}>{fmt(device.site || device.location)}</Descriptions.Item>
        <Descriptions.Item label={t('devices.form.building')}>{fmt(device.building)}</Descriptions.Item>
        <Descriptions.Item label={t('devices.form.floor')}>{fmt(device.floor)}</Descriptions.Item>

        <Descriptions.Item label={t('devices.form.layer')}>{fmt(device.layer)}</Descriptions.Item>
        <Descriptions.Item label={t('devices.form.tags')} span={2}>
          {device.tags
            ? device.tags.split(',').map((tag) => <Tag key={tag.trim()} style={{ margin: 2 }}>{tag.trim()}</Tag>)
            : '—'}
        </Descriptions.Item>

        <Descriptions.Item label="Agent">
          {device.agent_name
            ? <>
                <Badge status={device.agent_status === 'online' ? 'success' : 'error'} text={device.agent_name} />
                <span style={{ marginLeft: 8, color: 'var(--fg-3, #64748b)', fontSize: 12 }}>
                  ({device.agent_id})
                </span>
              </>
            : (device.agent_id ? <code style={{ fontSize: 12 }}>{device.agent_id}</code> : <em style={{ color: 'var(--fg-3,#64748b)' }}>{t('devices.detail.overview.direct_ssh')}</em>)}
        </Descriptions.Item>
        <Descriptions.Item label={t('devices.detail.overview.cli_mode')}>
          {device.is_readonly ? <Tag color="blue">{t('devices.detail.overview.tag_readonly')}</Tag> : <Tag color="orange">{t('devices.detail.overview.tag_write')}</Tag>}
        </Descriptions.Item>
        <Descriptions.Item label={t('devices.detail.overview.approval_flow')}>
          {device.approval_required ? <Tag color="purple">{t('devices.detail.overview.tag_approval_required')}</Tag> : <Tag>{t('devices.detail.overview.tag_free')}</Tag>}
        </Descriptions.Item>

        <Descriptions.Item label={t('common.last_seen')}>{fmtDate(device.last_seen)}</Descriptions.Item>
        <Descriptions.Item label={t('devices.detail.overview.last_backup_label')}>{fmtDate(device.last_backup)}</Descriptions.Item>
        <Descriptions.Item label={t('common.created_at')}>{fmtDate(device.created_at)}</Descriptions.Item>

        {device.description && (
          <Descriptions.Item label={t('devices.form.description')} span={3}>{device.description}</Descriptions.Item>
        )}
      </Descriptions>
    </div>
  )
}
