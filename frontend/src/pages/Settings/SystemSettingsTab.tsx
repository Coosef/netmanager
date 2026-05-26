/**
 * SystemSettingsTab — Tarama frekansları ve sistem ayarları yönetimi.
 *
 * T9 Tur 1 #1 (1A). Org bazlı override + global default + kod fallback.
 * Beat schedule dinamik DEĞİL (1B'de gelecek) — kaydet sonrası worker
 * restart gerekiyor uyarısı verilir.
 */
import { useMemo, useState } from 'react'
import {
  Alert, Badge, Button, Card, Empty, InputNumber, Popconfirm,
  Space, Tag, Tooltip, Typography, message,
} from 'antd'
import {
  ClockCircleOutlined, InfoCircleOutlined, ReloadOutlined,
  SaveOutlined, UndoOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { systemSettingsApi, SettingValue, SettingMeta } from '@/api/systemSettings'
import { useAuthStore } from '@/store/auth'

const { Text, Paragraph } = Typography

// UI etiketleri — backend key'leri için kullanıcı dostu isim
const LABELS: Record<string, { tr: string; hint?: string }> = {
  'scan.poll_device_status_sec': {
    tr: 'Cihaz durumu kontrolü',
    hint: 'Ping/SSH ile cihazların erişilebilirliğini kontrol etme aralığı.',
  },
  'scan.poll_snmp_sec': {
    tr: 'SNMP polling',
    hint: 'Arayüz sayaçları ve cihaz metrikleri için SNMP polling aralığı. Çok düşük değer cihaz CPU\'sunu yükseltir.',
  },
  'scan.mac_arp_sec': {
    tr: 'MAC + ARP tablosu',
    hint: 'Cihazlardan MAC ve ARP tablolarını çekme aralığı.',
  },
  'scan.update_baselines_sec': {
    tr: 'Baseline güncelleme',
    hint: 'Davranış baseline (normal MAC sayısı, trafik vb.) güncelleme aralığı. Tipik: günde 1.',
  },
  'scan.detect_anomalies_sec': {
    tr: 'Anomaly detection',
    hint: 'Baseline ile karşılaştırıp anomali tespit etme aralığı.',
  },
  'scan.topology_discovery_sec': {
    tr: 'Topoloji keşfi',
    hint: 'LLDP/CDP komşuluk tarama aralığı. Topoloji haritasını günceller.',
  },
  'scan.synthetic_probe_sec': {
    tr: 'Synthetic probe',
    hint: 'TCP/HTTP/DNS latency ölçümleri. Synthetic probe konfigürasyonlarınız varsa.',
  },
  'scan.relaxed_factor_in_maintenance': {
    tr: 'Bakım penceresinde gevşeme katsayısı',
    hint: 'Bakım penceresi (1B sonrası) aktifken polling frekansı bu katsayı ile düşer. Örn: 0.5 = yarı sıklık.',
  },
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec} sn`
  if (sec < 3600) return `${Math.round(sec / 60)} dk`
  if (sec < 86400) return `${(sec / 3600).toFixed(1)} sa`
  return `${(sec / 86400).toFixed(1)} gün`
}

interface RowProps {
  setting: SettingValue
  meta: SettingMeta
  onSave: (value: number) => Promise<unknown>
  onReset: () => Promise<unknown>
  saving: boolean
}

function SettingRow({ setting, meta, onSave, onReset, saving }: RowProps) {
  const isFactor = setting.key === 'scan.relaxed_factor_in_maintenance'
  const initialVal = isFactor ? Number(setting.value) : Number(setting.value)
  const [draft, setDraft] = useState<number>(initialVal)
  const dirty = draft !== initialVal
  const label = LABELS[setting.key] || { tr: setting.key }

  const lo = meta?.min_value ?? undefined
  const hi = meta?.max_value ?? undefined

  return (
    <div style={{
      padding: '14px 16px', borderBottom: '1px solid var(--border-0)',
      display: 'grid', gridTemplateColumns: '1fr 220px 180px',
      gap: 14, alignItems: 'center',
    }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <strong style={{ fontSize: 13 }}>{label.tr}</strong>
          {setting.is_org_override ? (
            <Tag color="cyan" style={{ fontSize: 10 }}>Org Özel</Tag>
          ) : (
            <Tag color="default" style={{ fontSize: 10 }}>Varsayılan</Tag>
          )}
          {label.hint && (
            <Tooltip title={label.hint}>
              <InfoCircleOutlined style={{ color: 'var(--fg-3)', fontSize: 12 }} />
            </Tooltip>
          )}
        </div>
        <Text style={{ fontSize: 11, color: 'var(--fg-3)', display: 'block', marginTop: 2 }}>
          <code style={{ fontSize: 11 }}>{setting.key}</code>
          {' · '}
          {isFactor ? (
            <span>Etkili: <strong>×{draft.toFixed(2)}</strong></span>
          ) : (
            <span>Etkili: <strong>{formatDuration(draft)}</strong></span>
          )}
          {lo != null && hi != null && (
            <span style={{ marginLeft: 8 }}>
              ({isFactor ? `${lo ?? 0}–${hi ?? 1}` : `${formatDuration(lo)} – ${formatDuration(hi)}`})
            </span>
          )}
        </Text>
      </div>

      <InputNumber
        value={draft}
        min={lo as number | undefined}
        max={hi as number | undefined}
        step={isFactor ? 0.05 : 30}
        precision={isFactor ? 2 : 0}
        addonAfter={isFactor ? '' : 'sn'}
        onChange={(v) => setDraft(Number(v) || initialVal)}
        style={{ width: '100%' }}
      />

      <Space size={6}>
        <Button
          type="primary" size="small"
          icon={<SaveOutlined />} disabled={!dirty || saving}
          loading={saving}
          onClick={() => onSave(draft)}
        >Kaydet</Button>
        {setting.is_org_override && (
          <Popconfirm
            title="Org özel ayarını sil"
            description="Bu ayar varsayılan değere döner. Devam edilsin mi?"
            onConfirm={onReset}
          >
            <Tooltip title="Varsayılana sıfırla">
              <Button size="small" icon={<UndoOutlined />} />
            </Tooltip>
          </Popconfirm>
        )}
      </Space>
    </div>
  )
}

export default function SystemSettingsTab() {
  const qc = useQueryClient()
  const { user } = useAuthStore()
  const canEdit = user?.system_role === 'super_admin' || user?.system_role === 'org_admin'

  const settingsQ = useQuery({
    queryKey: ['system-settings'],
    queryFn: systemSettingsApi.list,
  })
  const metaQ = useQuery({
    queryKey: ['system-settings-meta'],
    queryFn: systemSettingsApi.meta,
  })

  const upsertMut = useMutation({
    mutationFn: ({ key, value }: { key: string; value: number }) =>
      systemSettingsApi.upsert(key, value),
    onSuccess: (data) => {
      message.success(
        <Space direction="vertical" size={0}>
          <Text>Ayar kaydedildi: <code>{data.key}</code></Text>
          {!data.applied_immediately && (
            <Text type="warning" style={{ fontSize: 11 }}>
              ⚠ Tarama frekansları için Celery worker yeniden başlatılmalı
            </Text>
          )}
        </Space>,
        5,
      )
      qc.invalidateQueries({ queryKey: ['system-settings'] })
    },
    onError: (err: any) => {
      message.error(err?.response?.data?.detail || 'Ayar kaydedilemedi')
    },
  })

  const resetMut = useMutation({
    mutationFn: (key: string) => systemSettingsApi.resetToDefault(key),
    onSuccess: (data) => {
      message.success(
        data.removed
          ? `Org özel ayar silindi: ${data.key}`
          : 'Zaten varsayılan değerdeydi',
      )
      qc.invalidateQueries({ queryKey: ['system-settings'] })
    },
    onError: () => message.error('Sıfırlama başarısız'),
  })

  const metaByKey = useMemo<Record<string, SettingMeta>>(() => {
    const map: Record<string, SettingMeta> = {}
    for (const m of metaQ.data?.items || []) {
      map[m.key] = m
    }
    return map
  }, [metaQ.data])

  if (!canEdit) {
    return (
      <Alert
        type="warning" showIcon
        message="Yetersiz Yetki"
        description="Sistem ayarlarını sadece org_admin veya super_admin görüntüleyip değiştirebilir."
      />
    )
  }

  if (settingsQ.isLoading || metaQ.isLoading) {
    return <Text style={{ color: 'var(--fg-3)' }}>Yükleniyor…</Text>
  }
  const data = settingsQ.data
  if (!data) {
    return <Empty description="Ayar bulunamadı" />
  }

  return (
    <Space direction="vertical" size={18} style={{ width: '100%' }}>
      <div>
        <Space size={8} style={{ marginBottom: 6 }}>
          <ClockCircleOutlined style={{ fontSize: 18, color: 'var(--accent)' }} />
          <Text strong style={{ fontSize: 15 }}>Tarama Frekansları</Text>
          <Badge count={data.settings.length} style={{ backgroundColor: 'var(--accent)' }} />
        </Space>
        <Paragraph style={{ color: 'var(--fg-3)', fontSize: 12, marginBottom: 0 }}>
          Bu ayarlar organizasyonunuz için geçerlidir. <strong>Varsayılan</strong> etiketli olanlar
          sistem genelinde tanımlı, <strong>Org Özel</strong> etiketli olanlar bu organizasyonun
          özel ayarıdır. Değişiklikler Celery worker yeniden başlatılınca etkili olur (1B'de
          dinamik scheduler gelecek).
        </Paragraph>
      </div>

      <Alert
        type="info" showIcon
        message="Bilgi"
        description={
          <span>
            Tarama frekansı çok düşük olursa cihazlar gereksiz yere yüklenir (özellikle SNMP).
            Çok yüksek değer ise gecikme algılaması yavaşlar. Her ayarın altında önerilen
            aralık vardır. Min/Max sınırını aşan değerler kabul edilmez.
          </span>
        }
        style={{ marginBottom: 8 }}
      />

      <Card
        bodyStyle={{ padding: 0 }}
        title={
          <Space>
            <span>Tarama Ayarları</span>
            <Button
              size="small" icon={<ReloadOutlined />}
              onClick={() => qc.invalidateQueries({ queryKey: ['system-settings'] })}
            >Yenile</Button>
          </Space>
        }
      >
        <div>
          {data.settings.map((s) => (
            <SettingRow
              key={s.key}
              setting={s}
              meta={metaByKey[s.key] || { key: s.key, default: s.value }}
              onSave={(v) => upsertMut.mutateAsync({ key: s.key, value: v })}
              onReset={() => resetMut.mutateAsync(s.key)}
              saving={upsertMut.isPending && upsertMut.variables?.key === s.key}
            />
          ))}
        </div>
      </Card>
    </Space>
  )
}
