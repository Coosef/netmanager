/**
 * SystemSettingsTab — sistem ayarları yönetimi (kategori sekmeleri).
 *
 * T9 Tur 1 #1 (1A): tarama frekansları. T10 A2: operasyonel tuning
 * (dedup/korelasyon/flap/bakım/oturum) + kategori sekmeleri + scope.
 *
 * scope:
 *   - "org"    → org_admin kendi org'una override yazar.
 *   - "global" → yalnız super_admin değiştirir (fleet-wide); org_admin
 *     görür ama düzenleyemez.
 * Beat schedule dinamik DEĞİL — bazı ayarlar için worker restart gerekir.
 */
import { useMemo, useState } from 'react'
import {
  Alert, Badge, Button, Card, Empty, InputNumber, Popconfirm,
  Space, Table, Tabs, Tag, Tooltip, Typography, message,
} from 'antd'
import {
  ExperimentOutlined, InfoCircleOutlined, ReloadOutlined,
  SaveOutlined, UndoOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { systemSettingsApi, SettingValue, SettingMeta } from '@/api/systemSettings'
import { useAuthStore } from '@/store/auth'

// KURAL-E3: backend kategori adı (meta.category) RAW string — RetentionPreviewPanel
// karşılaştırması için kategori karşılığını backend'den alıyoruz; UI etiketi ise
// CATEGORY_LABEL useMemo'da t() ile çözülür.
const RETENTION_CATEGORY = 'Veri Saklama (Retention)'

// T10 A3 — dry-run önizleme paneli: "şu an çalışsa ne silinirdi?" (hiçbir
// şey silinmez). Retention sekmesinin altında gösterilir.
function RetentionPreviewPanel() {
  const { t } = useTranslation()
  const previewMut = useMutation({
    mutationFn: () => systemSettingsApi.retentionPreview(),
    onError: (err: any) =>
      message.error(err?.response?.data?.detail || t('settings.system.retention.preview_failed')),
  })
  const data = previewMut.data

  return (
    <Card
      size="small"
      style={{ marginTop: 12 }}
      title={<Space><ExperimentOutlined /><span>{t('settings.system.retention.panel_title')}</span></Space>}
      extra={
        <Button
          size="small" type="primary" ghost
          loading={previewMut.isPending}
          onClick={() => previewMut.mutate()}
        >{t('settings.system.retention.btn_preview')}</Button>
      }
    >
      <Paragraph style={{ color: 'var(--fg-3)', fontSize: 12, marginBottom: 8 }}>
        {t('settings.system.retention.intro')}
      </Paragraph>

      {!data ? (
        <Text style={{ color: 'var(--fg-3)', fontSize: 12 }}>
          {t('settings.system.retention.empty_hint')}
        </Text>
      ) : data.total === 0 ? (
        <Alert type="success" showIcon message={t('settings.system.retention.nothing_to_delete')} />
      ) : (
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Text>{t('settings.system.retention.total_candidates', { count: data.total })}</Text>
          {data.organizations.map((org) => {
            const rows = Object.entries(org.tables).map(([table, count]) => ({
              key: table, table, count,
            }))
            return (
              <Card key={org.organization_id} size="small" type="inner"
                title={<span>{org.organization_name} <Tag color="orange">{org.total}</Tag></span>}>
                <Table
                  size="small" pagination={false}
                  dataSource={rows}
                  columns={[
                    { title: t('settings.system.retention.col_table'), dataIndex: 'table', key: 'table' },
                    { title: t('settings.system.retention.col_rows'), dataIndex: 'count', key: 'count', align: 'right' as const },
                  ]}
                />
              </Card>
            )
          })}
        </Space>
      )}
    </Card>
  )
}

const { Text, Paragraph } = Typography

// UI etiketleri — backend key'leri için kullanıcı dostu isim + ipucu.
const LABELS: Record<string, { tr: string; hint?: string }> = {
  'scan.poll_device_status_sec': { tr: 'Cihaz durumu kontrolü', hint: 'Ping/SSH ile cihazların erişilebilirliğini kontrol etme aralığı.' },
  'scan.poll_snmp_sec': { tr: 'SNMP polling', hint: 'Arayüz sayaçları ve cihaz metrikleri için SNMP polling aralığı. Çok düşük değer cihaz CPU\'sunu yükseltir.' },
  'scan.mac_arp_sec': { tr: 'MAC + ARP tablosu', hint: 'Cihazlardan MAC ve ARP tablolarını çekme aralığı.' },
  'scan.update_baselines_sec': { tr: 'Baseline güncelleme', hint: 'Davranış baseline güncelleme aralığı. Tipik: günde 1.' },
  'scan.detect_anomalies_sec': { tr: 'Anomaly detection', hint: 'Baseline ile karşılaştırıp anomali tespit etme aralığı.' },
  'scan.topology_discovery_sec': { tr: 'Topoloji keşfi', hint: 'LLDP/CDP komşuluk tarama aralığı.' },
  'scan.synthetic_probe_sec': { tr: 'Synthetic probe', hint: 'TCP/HTTP/DNS latency ölçüm aralığı.' },
  'scan.relaxed_factor_in_maintenance': { tr: 'Bakımda gevşeme katsayısı', hint: 'Bakım penceresi aktifken polling frekansı bu katsayı ile düşer. Örn: 0.5 = yarı sıklık.' },

  'dedup.offline_event_sec': { tr: 'Offline event dedup', hint: 'Aynı cihaz için offline event\'in tekrar üretilme aralığı (gürültü engeli).' },
  'dedup.online_event_sec': { tr: 'Online event dedup', hint: 'Aynı cihaz için online event tekrar aralığı.' },
  'dedup.flap_alert_sec': { tr: 'Flap uyarı dedup', hint: 'Flapping uyarısının tekrar üretilme aralığı.' },
  'dedup.correlation_incident_sec': { tr: 'Korelasyon incident dedup', hint: 'Kök-neden/korelasyon incident\'ı tekrar aralığı.' },
  'dedup.agent_event_sec': { tr: 'Agent event dedup', hint: 'Agent online/offline event tekrar aralığı.' },

  'flap.device_threshold_per_hour': { tr: 'Cihaz flap eşiği (saat)', hint: 'Bir saatte bu kadar durum değişimi → cihaz "flapping" sayılır, bireysel olaylar bastırılır.' },
  'flap.incident_threshold': { tr: 'Incident flap eşiği', hint: 'Korelasyon penceresinde bu kadar event → flapping olarak bastır.' },

  'correlation.group_wait_sec': { tr: 'Group wait', hint: 'Incident açmadan önce beklenen tampon süre (tek-poll glitch filtresi).' },
  'correlation.bounce_guard_sec': { tr: 'Bounce guard', hint: 'RECOVERING\'e geçmeden önce minimum açık kalma süresi.' },
  'correlation.recovery_confirm_sec': { tr: 'Recovery onay penceresi', hint: 'RECOVERING → CLOSED onay bekleme süresi.' },
  'correlation.upstream_settle_sec': { tr: 'Upstream settle', hint: 'Downstream bastırmadan önce upstream durumunun oturması için bekleme.' },
  'correlation.flap_window_sec': { tr: 'Flap penceresi', hint: 'Flap tespiti için kayan zaman penceresi.' },

  'maintenance.spawn_horizon_days': { tr: 'Bakım penceresi ufku', hint: 'Döngüsel bakım pencerelerinin kaç gün önceden materialize edileceği.' },

  'session.terminal_stale_min': { tr: 'Terminal oturum stale', hint: 'Bu süre kapanmamış terminal oturumu otomatik kapatılır.' },
  'session.poe_snapshot_stale_min': { tr: 'PoE snapshot stale', hint: 'PoE snapshot bu süre güncellenmezse "stale" işaretlenir.' },
}

// Kategori sekme sırası (meta.category etiketleriyle birebir).
const CATEGORY_ORDER = [
  'Tarama Frekansları', 'Alarm / Dedup', 'Flap Tespiti',
  'Korelasyon Motoru', 'Bakım Pencereleri', 'Oturum / Stale',
  'Veri Saklama (Retention)',
]

type UnitKind = 'sec' | 'min' | 'days' | 'factor' | 'count'

function unitKind(key: string): UnitKind {
  if (key.includes('factor')) return 'factor'
  if (key.endsWith('_sec')) return 'sec'
  if (key.endsWith('_min')) return 'min'
  if (key.endsWith('_days')) return 'days'
  return 'count'
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec} sn`
  if (sec < 3600) return `${Math.round(sec / 60)} dk`
  if (sec < 86400) return `${(sec / 3600).toFixed(1)} sa`
  return `${(sec / 86400).toFixed(1)} gün`
}

function formatValue(kind: UnitKind, v: number): string {
  switch (kind) {
    case 'sec': return formatDuration(v)
    case 'min': return `${v} dk`
    case 'days': return `${v} gün`
    case 'factor': return `×${v.toFixed(2)}`
    default: return `${v}`
  }
}

function rangeLabel(kind: UnitKind, lo?: number | null, hi?: number | null): string | null {
  if (lo == null || hi == null) return null
  if (kind === 'sec') return `${formatDuration(lo)} – ${formatDuration(hi)}`
  if (kind === 'factor') return `${lo}–${hi}`
  const unit = kind === 'min' ? 'dk' : kind === 'days' ? 'gün' : ''
  return `${lo}–${hi}${unit ? ' ' + unit : ''}`
}

const UNIT_ADDON: Record<UnitKind, string> = {
  sec: 'sn', min: 'dk', days: 'gün', factor: '', count: '',
}

interface RowProps {
  setting: SettingValue
  meta: SettingMeta
  canEdit: boolean
  onSave: (value: number) => Promise<unknown>
  onReset: () => Promise<unknown>
  saving: boolean
}

function SettingRow({ setting, meta, canEdit, onSave, onReset, saving }: RowProps) {
  const { t } = useTranslation()
  const kind = unitKind(setting.key)
  const initialVal = Number(setting.value)
  const [draft, setDraft] = useState<number>(initialVal)
  const dirty = draft !== initialVal
  const label = LABELS[setting.key] || { tr: setting.key }
  const isGlobal = meta?.scope === 'global'

  const lo = meta?.min_value ?? undefined
  const hi = meta?.max_value ?? undefined
  const rng = rangeLabel(kind, meta?.min_value, meta?.max_value)

  return (
    <div style={{
      padding: '14px 16px', borderBottom: '1px solid var(--border-0)',
      display: 'grid', gridTemplateColumns: '1fr 220px 180px',
      gap: 14, alignItems: 'center',
    }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* KURAL-E3: LABELS sözlüğü backend setting key'leri için TR isim
              veriyor; bunlar sayfa-spesifik tooltip/hint. İleride i18n
              kapsamına alınabilir (ayrı sprint), şu an raw tutuluyor. */}
          <strong style={{ fontSize: 13 }}>{label.tr}</strong>
          {isGlobal ? (
            <Tag color="purple" style={{ fontSize: 10 }}>{t('settings.system.scope.global')}</Tag>
          ) : setting.is_org_override ? (
            <Tag color="cyan" style={{ fontSize: 10 }}>{t('settings.system.scope.org_override')}</Tag>
          ) : (
            <Tag color="default" style={{ fontSize: 10 }}>{t('settings.system.scope.default')}</Tag>
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
          <span>{t('settings.system.row.effective_label')}: <strong>{formatValue(kind, draft)}</strong></span>
          {rng && <span style={{ marginLeft: 8 }}>({rng})</span>}
        </Text>
      </div>

      <InputNumber
        value={draft}
        min={lo as number | undefined}
        max={hi as number | undefined}
        step={kind === 'factor' ? 0.05 : kind === 'sec' ? 30 : 1}
        precision={kind === 'factor' ? 2 : 0}
        addonAfter={UNIT_ADDON[kind] || undefined}
        disabled={!canEdit}
        onChange={(v) => setDraft(Number(v) || initialVal)}
        style={{ width: '100%' }}
      />

      <Space size={6}>
        <Tooltip title={!canEdit ? t('settings.system.row.global_lock_tooltip') : ''}>
          <Button
            type="primary" size="small"
            icon={<SaveOutlined />} disabled={!dirty || saving || !canEdit}
            loading={saving}
            onClick={() => onSave(draft)}
          >{t('common.save')}</Button>
        </Tooltip>
        {canEdit && setting.is_org_override && !isGlobal && (
          <Popconfirm
            title={t('settings.system.popconfirm.reset_title')}
            description={t('settings.system.popconfirm.reset_desc')}
            onConfirm={onReset}
          >
            <Tooltip title={t('settings.system.row.reset_to_default')}>
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
  const { t } = useTranslation()
  const { user } = useAuthStore()
  const isSuperAdmin = user?.system_role === 'super_admin'
  const canView = isSuperAdmin || user?.system_role === 'org_admin'

  // KURAL-E1: kategori UI etiketleri hook scope'unda useMemo + t().
  // RETENTION_CATEGORY backend string'i karşılaştırma için sabit kalır.
  const CATEGORY_LABEL = useMemo<Record<string, string>>(() => ({
    'Tarama Frekansları':         t('settings.system.category.scan_frequencies'),
    'Alarm / Dedup':              t('settings.system.category.alarm_dedup'),
    'Flap Tespiti':               t('settings.system.category.flap'),
    'Korelasyon Motoru':          t('settings.system.category.correlation'),
    'Bakım Pencereleri':          t('settings.system.category.maintenance'),
    'Oturum / Stale':             t('settings.system.category.session_stale'),
    'Veri Saklama (Retention)':   t('settings.system.category.retention'),
    'Diğer':                       t('settings.system.category.other'),
  }), [t])

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
          <Text>{t('settings.system.toast.saved_key', { key: data.key })}</Text>
          {!data.applied_immediately && (
            <Text type="warning" style={{ fontSize: 11 }}>
              {t('settings.system.toast.worker_restart_required')}
            </Text>
          )}
        </Space>,
        5,
      )
      qc.invalidateQueries({ queryKey: ['system-settings'] })
    },
    onError: (err: any) => {
      message.error(err?.response?.data?.detail || t('settings.system.toast.save_failed'))
    },
  })

  const resetMut = useMutation({
    mutationFn: (key: string) => systemSettingsApi.resetToDefault(key),
    onSuccess: (data) => {
      message.success(
        data.removed ? t('settings.system.toast.override_removed', { key: data.key }) : t('settings.system.toast.already_default'),
      )
      qc.invalidateQueries({ queryKey: ['system-settings'] })
    },
    onError: () => message.error(t('settings.system.toast.reset_failed')),
  })

  const metaByKey = useMemo<Record<string, SettingMeta>>(() => {
    const map: Record<string, SettingMeta> = {}
    for (const m of metaQ.data?.items || []) map[m.key] = m
    return map
  }, [metaQ.data])

  // Ayarları kategoriye göre grupla (meta.category) → sekme başına liste.
  const grouped = useMemo<Record<string, SettingValue[]>>(() => {
    const g: Record<string, SettingValue[]> = {}
    for (const s of settingsQ.data?.settings || []) {
      const cat = metaByKey[s.key]?.category || 'Diğer'
      ;(g[cat] ||= []).push(s)
    }
    return g
  }, [settingsQ.data, metaByKey])

  if (!canView) {
    return (
      <Alert
        type="warning" showIcon
        message={t('settings.system.no_permission_title')}
        description={t('settings.system.no_permission_desc')}
      />
    )
  }

  if (settingsQ.isLoading || metaQ.isLoading) {
    return <Text style={{ color: 'var(--fg-3)' }}>{t('common.loading')}</Text>
  }
  const data = settingsQ.data
  if (!data) return <Empty description={t('settings.system.empty')} />

  const categories = Object.keys(grouped).sort(
    (a, b) => {
      const ia = CATEGORY_ORDER.indexOf(a), ib = CATEGORY_ORDER.indexOf(b)
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib)
    },
  )

  const tabItems = categories.map((cat) => ({
    key: cat,
    label: <span>{CATEGORY_LABEL[cat] ?? cat} <Badge count={grouped[cat].length} style={{ backgroundColor: 'var(--accent)' }} /></span>,
    children: (
      <>
        <Card bodyStyle={{ padding: 0 }}>
          {grouped[cat].map((s) => {
            const meta = metaByKey[s.key] || { key: s.key, default: s.value }
            const isGlobal = meta.scope === 'global'
            const canEditThis = isGlobal ? isSuperAdmin : canView
            return (
              <SettingRow
                key={s.key}
                setting={s}
                meta={meta}
                canEdit={canEditThis}
                onSave={(v) => upsertMut.mutateAsync({ key: s.key, value: v })}
                onReset={() => resetMut.mutateAsync(s.key)}
                saving={upsertMut.isPending && upsertMut.variables?.key === s.key}
              />
            )
          })}
        </Card>
        {cat === RETENTION_CATEGORY && <RetentionPreviewPanel />}
      </>
    ),
  }))

  return (
    <Space direction="vertical" size={18} style={{ width: '100%' }}>
      <div>
        <Space size={8} style={{ marginBottom: 6 }}>
          <Text strong style={{ fontSize: 15 }}>{t('settings.system.page_title')}</Text>
          <Badge count={data.settings.length} style={{ backgroundColor: 'var(--accent)' }} />
          <Button
            size="small" icon={<ReloadOutlined />}
            onClick={() => qc.invalidateQueries({ queryKey: ['system-settings'] })}
          >{t('common.refresh')}</Button>
        </Space>
        <Paragraph style={{ color: 'var(--fg-3)', fontSize: 12, marginBottom: 0 }}>
          <Tag color="cyan" style={{ fontSize: 10 }}>{t('settings.system.scope.org_override')}</Tag> {t('settings.system.scope_legend_org')}
          {' '}<Tag color="purple" style={{ fontSize: 10 }}>{t('settings.system.scope.global')}</Tag> {t('settings.system.scope_legend_global')}
        </Paragraph>
      </div>

      <Alert
        type="info" showIcon
        message={t('common.info')}
        description={t('settings.system.info_desc')}
        style={{ marginBottom: 4 }}
      />

      <Tabs items={tabItems} />
    </Space>
  )
}
