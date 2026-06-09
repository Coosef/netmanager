import { Input, Select, Space, DatePicker, Button, Tag } from 'antd'
import {
  UserOutlined,
  GlobalOutlined,
  ReloadOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { Dayjs } from 'dayjs'
import {
  AUDIT_DATE_PRESETS,
  getPresetRange,
  detectActivePreset,
  countActiveFilters,
  type AuditDatePreset,
} from './auditDatePresets'

/**
 * Audit Log v2 PR 4 — Filter Bar component.
 *
 * Mevcut filtre state'leri parent'ta (AuditLog/index.tsx) kalır;
 * component sadece UI + callback yönetir. Tek source-of-truth dateRange:
 * aktif preset her render'da detectActivePreset ile derive edilir
 * (state olarak TUTULMAZ).
 *
 * UI:
 *   1. Üst satır: Quick presets (1sa / 24sa / 7g / 30g) + aktif preset
 *      highlight + aktif filter count chip + Reset Filters butonu
 *   2. Alt satır: 6 filter input (Kullanıcı/Aksiyon/IP search +
 *      Kaynak tipi/Durum select + DateRange)
 *
 * Mobile/wrap: Space wrap.
 */

export type AuditFilterBarProps = {
  search: string
  onSearchChange: (v: string) => void
  actionFilter: string
  onActionChange: (v: string) => void
  ipFilter: string
  onIpChange: (v: string) => void
  resourceType?: string
  onResourceTypeChange: (v?: string) => void
  statusFilter?: string
  onStatusFilterChange: (v?: string) => void
  dateRange: [Dayjs | null, Dayjs | null] | null
  onDateRangeChange: (range: [Dayjs | null, Dayjs | null] | null) => void
  onReset: () => void
}

const PRESET_I18N_KEY: Record<Exclude<AuditDatePreset, 'custom'>, string> = {
  '1h':  'audit.filter.preset_1h',
  '24h': 'audit.filter.preset_24h',
  '7d':  'audit.filter.preset_7d',
  '30d': 'audit.filter.preset_30d',
}

const RESOURCE_TYPE_VALUES = [
  { value: 'device',           i18nKey: 'audit.resource.type_device' },
  { value: 'user',             i18nKey: 'audit.resource.type_user' },
  { value: 'task',             i18nKey: 'audit.resource.type_task' },
  { value: 'agent',            i18nKey: 'audit.resource.type_agent' },
  { value: 'ipam',             i18nKey: 'audit.resource.type_ipam' },
  { value: 'security_audit',   i18nKey: 'audit.resource.type_security_audit' },
  { value: 'terminal_session', i18nKey: 'audit.resource.type_terminal_session' },
  { value: 'asset_lifecycle',  i18nKey: 'audit.resource.type_asset_lifecycle' },
  { value: 'organization',     i18nKey: 'audit.resource.type_organization' },
  { value: 'config_template',  i18nKey: 'audit.resource.type_config_template' },
]

export default function AuditFilterBar(props: AuditFilterBarProps) {
  const { t } = useTranslation()
  const {
    search, onSearchChange,
    actionFilter, onActionChange,
    ipFilter, onIpChange,
    resourceType, onResourceTypeChange,
    statusFilter, onStatusFilterChange,
    dateRange, onDateRangeChange,
    onReset,
  } = props

  const activeCount = countActiveFilters({
    search, actionFilter, ipFilter, resourceType, statusFilter, dateRange,
  })
  const activePreset = detectActivePreset(dateRange)

  const handlePresetClick = (preset: AuditDatePreset) => {
    const range = getPresetRange(preset)
    if (range) onDateRangeChange(range)
  }

  return (
    <div
      data-testid="audit-filter-bar"
      style={{
        background: 'var(--bg-1)',
        border: '1px solid var(--line)',
        borderRadius: 8,
        padding: '10px 12px',
        marginBottom: 12,
      }}
    >
      {/* Üst satır — quick presets + aktif filter count + reset */}
      <Space
        wrap
        style={{ marginBottom: 10, width: '100%', justifyContent: 'space-between' }}
        align="center"
      >
        <Space size={6} wrap align="center">
          <ClockCircleOutlined style={{ color: 'var(--fg-3)' }} />
          <span style={{ fontSize: 11, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            {t('audit.filter.quick_label')}
          </span>
          {AUDIT_DATE_PRESETS.map((preset) => {
            const isActive = activePreset === preset
            return (
              <Button
                key={preset}
                size="small"
                type={isActive ? 'primary' : 'default'}
                data-testid={`audit-filter-preset-${preset}`}
                data-active={isActive ? 'true' : 'false'}
                onClick={() => handlePresetClick(preset)}
              >
                {t(PRESET_I18N_KEY[preset])}
              </Button>
            )
          })}
        </Space>

        <Space size={6} align="center">
          {activeCount > 0 && (
            <Tag color="blue" data-testid="audit-filter-active-count">
              {t('audit.filter.active_count', { n: activeCount })}
            </Tag>
          )}
          {activeCount > 0 && (
            <Button
              size="small"
              icon={<ReloadOutlined />}
              data-testid="audit-filter-reset"
              onClick={onReset}
              danger
            >
              {t('audit.filter.reset')}
            </Button>
          )}
        </Space>
      </Space>

      {/* Alt satır — 6 filter input */}
      <Space wrap>
        <Input.Search
          placeholder={t('audit.filter.search_user')}
          style={{ width: 150 }}
          value={search}
          allowClear
          onSearch={onSearchChange}
          onChange={(e) => !e.target.value && onSearchChange('')}
          prefix={<UserOutlined style={{ color: 'var(--fg-3)' }} />}
        />
        <Input.Search
          placeholder={t('audit.filter.search_action')}
          style={{ width: 150 }}
          value={actionFilter}
          allowClear
          onSearch={onActionChange}
          onChange={(e) => !e.target.value && onActionChange('')}
        />
        <Input.Search
          placeholder={t('audit.filter.search_ip')}
          style={{ width: 140 }}
          value={ipFilter}
          allowClear
          onSearch={onIpChange}
          onChange={(e) => !e.target.value && onIpChange('')}
          prefix={<GlobalOutlined style={{ color: 'var(--fg-3)' }} />}
        />
        <Select
          placeholder={t('audit.filter.resource_type_placeholder')}
          allowClear
          style={{ width: 160 }}
          value={resourceType}
          onChange={onResourceTypeChange}
          options={RESOURCE_TYPE_VALUES.map((r) => ({
            value: r.value,
            label: t(r.i18nKey),
          }))}
        />
        <Select
          placeholder={t('audit.filter.status_placeholder')}
          allowClear
          style={{ width: 130 }}
          value={statusFilter}
          onChange={onStatusFilterChange}
          options={[
            { label: t('audit.status.success'), value: 'success' },
            { label: t('audit.status.failure'), value: 'failure' },
          ]}
        />
        <DatePicker.RangePicker
          showTime={{ format: 'HH:mm' }}
          format="DD.MM.YY HH:mm"
          style={{ width: 310 }}
          value={dateRange ?? undefined}
          onChange={(range) =>
            onDateRangeChange(range as [Dayjs | null, Dayjs | null] | null)
          }
        />
      </Space>
    </div>
  )
}
