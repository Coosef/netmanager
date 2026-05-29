/**
 * T10 C7.B — Device Detail > Genel sekmesi.
 *
 * Cihaz meta + status + lokasyon hiyerarşi + agent + lifecycle özeti. Read-only;
 * düzenleme mevcut Hızlı Düzenle Drawer'ında (cihaz listesi). Veri devicesApi.get(id).
 */
import { Descriptions, Tag, Badge } from 'antd'
import type { Device } from '@/types'
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

export default function OverviewTab({ device }: { device: Device }) {
  return (
    <div style={{ padding: '4px 0 16px' }}>
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
