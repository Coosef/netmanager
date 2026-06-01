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
import { useMemo } from 'react'
import { Descriptions, Tag, Badge } from 'antd'
import { StarFilled } from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import type { Device } from '@/types'
import { devicesApi } from '@/api/devices'
import { poeApi } from '@/api/poe'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'

dayjs.extend(relativeTime)

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
          <div className="nm-stat-label">Aktif Port</div>
          <div className="nm-stat-val">
            {stats.upCount}
            {stats.totalPorts > 0 && <small> / {stats.totalPorts}</small>}
          </div>
          <div className="nm-stat-delta">
            {ifaceQ.isLoading ? 'yükleniyor…' : ifaceQ.data?.cached ? 'cache' : 'canlı'}
          </div>
        </div>

        <div className={`nm-stat ${stats.errCount > 0 ? 'crit' : ''}`}>
          <div className="nm-stat-label">Err / Down</div>
          <div className="nm-stat-val">{stats.errCount}</div>
          <div className="nm-stat-delta">err-disabled / notconnect</div>
        </div>

        <div className={`nm-stat ${(stats.poeActivePorts ?? 0) > 0 ? 'ok' : ''}`}>
          <div className="nm-stat-label">PoE Port</div>
          <div className="nm-stat-val">{stats.poeActivePorts ?? '—'}</div>
          <div className="nm-stat-delta">PoE veren port</div>
        </div>

        <div className={`nm-stat ${stats.totalPowerW !== null && stats.totalPowerW > 100 ? 'warn' : ''}`}>
          <div className="nm-stat-label">Toplam Güç</div>
          <div className="nm-stat-val">
            {stats.totalPowerW !== null ? Math.round(stats.totalPowerW) : '—'}
            <small> W</small>
          </div>
          <div className="nm-stat-delta">cihaz PoE bütçesi</div>
        </div>

        <div className="nm-stat">
          <div className="nm-stat-label">VLAN</div>
          <div className="nm-stat-val">{stats.vlanCount}</div>
          <div className="nm-stat-delta">tanımlı</div>
        </div>

        <div className={`nm-stat ${backupClass}`}>
          <div className="nm-stat-label">
            Son Backup {stats.isGolden && <StarFilled style={{ color: '#faad14', fontSize: 11, marginLeft: 4 }} />}
          </div>
          <div className="nm-stat-val">
            {stats.lastBackup?.created_at
              ? <span style={{ fontSize: 18 }}>{dayjs(stats.lastBackup.created_at).fromNow(true)}</span>
              : '—'}
          </div>
          <div className="nm-stat-delta">
            {stats.lastBackup?.created_at
              ? dayjs(stats.lastBackup.created_at).format('YYYY-MM-DD HH:mm')
              : 'yedek alınmamış'}
          </div>
        </div>
      </div>

      <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}
                    labelStyle={{ width: 160, fontWeight: 500 }}>
        <Descriptions.Item label="Durum">
          <Badge status={STATUS_COLOR[device.status] ?? 'default'} text={device.status} />
        </Descriptions.Item>
        <Descriptions.Item label="Yaşam Döngüsü">
          <Tag color={device.lifecycle_status === 'archived' ? 'default'
                    : device.lifecycle_status === 'production' ? 'green'
                    : device.lifecycle_status === 'passive' ? 'orange'
                    : 'blue'}>
            {fmt(device.lifecycle_status)}
          </Tag>
        </Descriptions.Item>
        <Descriptions.Item label="Etkin">
          {device.is_active ? <Tag color="green">aktif</Tag> : <Tag>pasif</Tag>}
        </Descriptions.Item>

        <Descriptions.Item label="Hostname">{fmt(device.hostname)}</Descriptions.Item>
        <Descriptions.Item label="Alias">{fmt(device.alias)}</Descriptions.Item>
        <Descriptions.Item label="IP">{fmt(device.ip_address)}</Descriptions.Item>

        <Descriptions.Item label="Vendor">{fmt(device.vendor)}</Descriptions.Item>
        <Descriptions.Item label="OS Tipi">{fmt(device.os_type)}</Descriptions.Item>
        <Descriptions.Item label="Model">{fmt(device.model)}</Descriptions.Item>

        <Descriptions.Item label="Lokasyon">{fmt(device.site || device.location)}</Descriptions.Item>
        <Descriptions.Item label="Bina">{fmt(device.building)}</Descriptions.Item>
        <Descriptions.Item label="Kat">{fmt(device.floor)}</Descriptions.Item>

        <Descriptions.Item label="Ağ Katmanı">{fmt(device.layer)}</Descriptions.Item>
        <Descriptions.Item label="Etiketler" span={2}>
          {device.tags
            ? device.tags.split(',').map((t) => <Tag key={t.trim()} style={{ margin: 2 }}>{t.trim()}</Tag>)
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
            : (device.agent_id ? <code style={{ fontSize: 12 }}>{device.agent_id}</code> : <em style={{ color: 'var(--fg-3,#64748b)' }}>direkt SSH</em>)}
        </Descriptions.Item>
        <Descriptions.Item label="CLI Modu">
          {device.is_readonly ? <Tag color="blue">salt-okunur</Tag> : <Tag color="orange">yazma izni</Tag>}
        </Descriptions.Item>
        <Descriptions.Item label="Onay Akışı">
          {device.approval_required ? <Tag color="purple">onay zorunlu</Tag> : <Tag>serbest</Tag>}
        </Descriptions.Item>

        <Descriptions.Item label="Son Görülme">{fmtDate(device.last_seen)}</Descriptions.Item>
        <Descriptions.Item label="Son Backup">{fmtDate(device.last_backup)}</Descriptions.Item>
        <Descriptions.Item label="Oluşturma">{fmtDate(device.created_at)}</Descriptions.Item>

        {device.description && (
          <Descriptions.Item label="Açıklama" span={3}>{device.description}</Descriptions.Item>
        )}
      </Descriptions>
    </div>
  )
}
