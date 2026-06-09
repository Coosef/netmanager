import { useState, useMemo } from 'react'
import {
  Table, Tag, Space, Typography,
  Badge, Tooltip, Button,
} from 'antd'
import {
  InfoCircleOutlined, ClockCircleOutlined, GlobalOutlined, CodeOutlined,
  DownloadOutlined,
} from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { useTheme } from '@/contexts/ThemeContext'
import { useTranslation } from 'react-i18next'
import dayjs from 'dayjs'
import { tasksApi } from '@/api/tasks'
import type { AuditLog } from '@/types'
import AuditActionChip from './AuditActionChip'
import AuditDetailDrawer from './AuditDetailDrawer'
import AuditResourceLink from './AuditResourceLink'
import AuditFilterBar from './AuditFilterBar'
import AuditEmptyState from './AuditEmptyState'
import { countActiveFilters } from './auditDatePresets'

const { Text } = Typography

const AUDIT_CSS = `
@keyframes auditRowIn {
  from { opacity: 0; transform: translateX(-4px); }
  to   { opacity: 1; transform: translateX(0); }
}
@keyframes auditHeaderGlow {
  0%, 100% { box-shadow: 0 0 18px #3b82f620; }
  50%       { box-shadow: 0 0 30px #3b82f635; }
}
.audit-row-fail td { background: rgba(239,68,68,0.035) !important; }
.audit-row-fail:hover td { background: rgba(239,68,68,0.07) !important; }
.audit-row-success:hover td { background: rgba(34,197,94,0.03) !important; }
`

const ROLE_COLOR: Record<string, string> = {
  super_admin: '#ef4444', admin: '#f97316', operator: '#3b82f6',
  viewer: '#64748b', auditor: '#8b5cf6',
}

function parseUA(ua?: string): string {
  if (!ua) return '—'
  if (ua.includes('Python')) return 'Python'
  if (ua.includes('curl')) return 'cURL'
  if (ua.includes('Postman')) return 'Postman'
  if (ua.includes('Edg/')) return 'Edge'
  if (ua.includes('Chrome')) return 'Chrome'
  if (ua.includes('Firefox')) return 'Firefox'
  if (ua.includes('Safari')) return 'Safari'
  return ua.substring(0, 24)
}

function mkC(isDark: boolean) {
  return {
    bg:     isDark ? '#1e293b' : '#ffffff',
    bg2:    isDark ? '#0f172a' : '#f8fafc',
    border: isDark ? '#334155' : '#e2e8f0',
    text:   isDark ? '#f1f5f9' : '#1e293b',
    muted:  isDark ? '#64748b' : '#94a3b8',
    dim:    isDark ? '#475569' : '#cbd5e1',
    primary: '#3b82f6', success: '#22c55e', danger: '#ef4444',
  }
}

// Audit Log v2 PR 4 — exportCSV t() ile çağrıldı, header'lar locale'e göre üretilir.
// Kolon sırası KORUNUR (11 sütun); sadece header text dil bazlı.
function exportCSV(
  items: AuditLog[],
  t: (key: string) => string,
) {
  const headers = [
    t('audit.csv.id'),
    t('audit.csv.time'),
    t('audit.csv.user'),
    t('audit.csv.role'),
    t('audit.csv.action'),
    t('audit.csv.resource_type'),
    t('audit.csv.resource'),
    t('audit.csv.ip'),
    t('audit.csv.duration_ms'),
    t('audit.csv.status'),
    t('audit.csv.client'),
  ]
  const rows = items.map(l => [
    l.id,
    dayjs(l.created_at).format('DD.MM.YYYY HH:mm:ss'),
    l.username,
    l.user_role || '',
    l.action,
    l.resource_type || '',
    l.resource_name || l.resource_id || '',
    l.client_ip || '',
    l.duration_ms?.toFixed(0) || '',
    l.status,
    parseUA(l.user_agent),
  ])
  const csv = [headers, ...rows]
    .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `audit-log-${dayjs().format('YYYYMMDD-HHmm')}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

export default function AuditLogPage() {
  const { t } = useTranslation()
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [actionFilter, setActionFilter] = useState('')
  const [ipFilter, setIpFilter] = useState('')
  const [resourceType, setResourceType] = useState<string>()
  const [statusFilter, setStatusFilter] = useState<string>()
  const [dateRange, setDateRange] = useState<[dayjs.Dayjs | null, dayjs.Dayjs | null] | null>(null)
  const [selected, setSelected] = useState<AuditLog | null>(null)
  const pageSize = 100
  const { isDark } = useTheme()
  const C = mkC(isDark)

  const { data, isLoading } = useQuery({
    queryKey: ['audit-log', page, search, actionFilter, ipFilter, resourceType, statusFilter, dateRange],
    queryFn: () =>
      tasksApi.getAuditLog({
        skip: (page - 1) * pageSize,
        limit: pageSize,
        username: search || undefined,
        action: actionFilter || undefined,
        client_ip: ipFilter || undefined,
        resource_type: resourceType,
        status: statusFilter,
        date_from: dateRange?.[0]?.toISOString(),
        date_to: dateRange?.[1]?.toISOString(),
      }),
  })

  const successCount = (data?.total ?? 0) - (data?.failure_count ?? 0)

  // Audit Log v2 PR 4 — Reset Filters callback.
  // Tüm filter state'lerini sıfırlar + sayfa 1'e döner.
  const handleResetFilters = () => {
    setSearch('')
    setActionFilter('')
    setIpFilter('')
    setResourceType(undefined)
    setStatusFilter(undefined)
    setDateRange(null)
    setPage(1)
  }

  // Empty state mode — filtre var mı, yok mu
  const activeCount = useMemo(
    () => countActiveFilters({ search, actionFilter, ipFilter, resourceType, statusFilter, dateRange }),
    [search, actionFilter, ipFilter, resourceType, statusFilter, dateRange],
  )
  const emptyMode: 'no_data' | 'no_match' = activeCount > 0 ? 'no_match' : 'no_data'

  return (
    <div className="nm-page" style={{ padding: '4px 2px' }}>
      <style>{AUDIT_CSS}</style>

      <div className="nm-page-hd">
        <div className="title-block">
          <div className="nm-crumbs">
            <span>{t('audit.page.crumb_root')}</span>
            <span>{t('audit.page.title')}</span>
          </div>
          <h1 className="nm-page-title">
            {t('audit.page.title')}
            <span className="nm-pill mono">
              {t('audit.page.records_count', { n: data?.total ?? 0 })}
            </span>
            {(data?.failure_count ?? 0) > 0 && (
              <span className="nm-pill crit">
                {t('audit.page.failed_count', { n: data?.failure_count ?? 0 })}
              </span>
            )}
          </h1>
          <div className="nm-page-sub">{t('audit.page.subtitle')}</div>
        </div>
        <div className="nm-page-actions">
          <button className="nm-btn primary" onClick={() => data?.items && exportCSV(data.items, t)} disabled={!data?.items?.length}>
            <DownloadOutlined /> {t('audit.page.download_csv')}
          </button>
        </div>
      </div>

      <div className="nm-statbar">
        <div className="nm-stat"><div className="nm-stat-label">{t('audit.stat.total')}</div><div className="nm-stat-val">{data?.total ?? 0}</div></div>
        <div className="nm-stat ok"><div className="nm-stat-label">{t('audit.stat.success')}</div><div className="nm-stat-val">{successCount}</div></div>
        <div className="nm-stat crit"><div className="nm-stat-label">{t('audit.stat.failure')}</div><div className="nm-stat-val">{data?.failure_count ?? 0}</div></div>
        <div className="nm-stat"><div className="nm-stat-label">{t('audit.stat.unique_users')}</div><div className="nm-stat-val">{data?.unique_users ?? 0}</div></div>
        <div className="nm-stat"><div className="nm-stat-label">{t('audit.stat.page')}</div><div className="nm-stat-val">{page}</div><div className="nm-stat-delta">/ {Math.max(1, Math.ceil((data?.total ?? 0) / 50))}</div></div>
        <div className="nm-stat"><div className="nm-stat-label">{t('audit.stat.displayed')}</div><div className="nm-stat-val">{data?.items?.length ?? 0}</div></div>
      </div>

      {/* Audit Log v2 PR 4 — Filter Card → AuditFilterBar component.
          State management parent'ta, callback'lerle update edilir.
          Quick presets + Reset + active count chip dahil. */}
      <AuditFilterBar
        search={search}
        onSearchChange={(v) => { setSearch(v); setPage(1) }}
        actionFilter={actionFilter}
        onActionChange={(v) => { setActionFilter(v); setPage(1) }}
        ipFilter={ipFilter}
        onIpChange={(v) => { setIpFilter(v); setPage(1) }}
        resourceType={resourceType}
        onResourceTypeChange={(v) => { setResourceType(v); setPage(1) }}
        statusFilter={statusFilter}
        onStatusFilterChange={(v) => { setStatusFilter(v); setPage(1) }}
        dateRange={dateRange}
        onDateRangeChange={(range) => { setDateRange(range); setPage(1) }}
        onReset={handleResetFilters}
      />

      <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
        <Table<AuditLog>
          dataSource={data?.items || []}
          rowKey="id"
          loading={isLoading}
          size="small"
          rowClassName={(r) => r.status === 'failure' ? 'audit-row-fail' : 'audit-row-success'}
          onRow={(r) => ({
            style: {
              borderLeft: r.status === 'failure' ? '3px solid rgba(239,68,68,0.35)' : '3px solid transparent',
              animation: 'auditRowIn 0.2s ease-out',
            },
          })}
          /* Audit Log v2 PR 4 — Custom empty state.
             mode: aktif filter var mı → 'no_match' (reset CTA görünür)
                   yok → 'no_data' (gerçek empty, CTA yok) */
          locale={{
            emptyText: (
              <AuditEmptyState
                mode={emptyMode}
                onReset={emptyMode === 'no_match' ? handleResetFilters : undefined}
              />
            ),
          }}
          pagination={{
            total: data?.total,
            pageSize,
            current: page,
            onChange: setPage,
            showTotal: (n) => <span style={{ color: C.muted }}>{t('audit.page.records_count', { n })}</span>,
            showSizeChanger: false,
            style: { padding: '8px 16px' },
          }}
          columns={[
            {
              title: t('audit.column.time'),
              dataIndex: 'created_at',
              width: 145,
              render: (v) => (
                <Text style={{ fontSize: 12, fontFamily: 'monospace', color: C.muted }}>
                  {dayjs(v).format('DD.MM.YY HH:mm:ss')}
                </Text>
              ),
            },
            {
              title: t('audit.column.user'),
              dataIndex: 'username',
              width: 130,
              render: (v, r) => (
                <Space size={4} direction="vertical" style={{ gap: 2 }}>
                  <Text strong style={{ fontSize: 12, color: C.text }}>{v}</Text>
                  {r.user_role && (
                    <Tag style={{
                      fontSize: 10, lineHeight: '14px', padding: '0 4px',
                      color: ROLE_COLOR[r.user_role] || '#64748b',
                      borderColor: (ROLE_COLOR[r.user_role] || '#64748b') + '50',
                      background: (ROLE_COLOR[r.user_role] || '#64748b') + '15',
                      margin: 0,
                    }}>
                      {r.user_role}
                    </Tag>
                  )}
                </Space>
              ),
            },
            {
              title: t('audit.column.action'),
              dataIndex: 'action',
              render: (v, r) => (
                <Space size={4}>
                  <AuditActionChip action={v} status={r.status} compact />
                  {(r.before_state || r.after_state) && (
                    <Tooltip title={t('audit.column.has_diff_tooltip')}>
                      <CodeOutlined style={{ color: '#3b82f6', fontSize: 12 }} />
                    </Tooltip>
                  )}
                </Space>
              ),
            },
            {
              title: t('audit.column.resource'),
              render: (_, r) => (
                <AuditResourceLink
                  type={r.resource_type}
                  id={r.resource_id}
                  name={r.resource_name}
                  compact
                />
              ),
            },
            {
              title: t('audit.column.ip'),
              dataIndex: 'client_ip',
              width: 130,
              render: (v) => v
                ? <Space size={4}>
                    <GlobalOutlined style={{ fontSize: 11, color: C.dim }} />
                    <Text copyable={{ text: v }} style={{ fontSize: 12, color: C.muted, fontFamily: 'monospace' }}>{v}</Text>
                  </Space>
                : <Text style={{ color: C.dim }}>—</Text>,
            },
            {
              title: t('audit.column.client'),
              dataIndex: 'user_agent',
              width: 80,
              render: (v) => (
                <Tooltip title={v || '—'}>
                  <Text style={{ fontSize: 11, color: C.muted }}>{parseUA(v)}</Text>
                </Tooltip>
              ),
            },
            {
              title: <Tooltip title={t('audit.column.duration_tooltip')}><ClockCircleOutlined /></Tooltip>,
              dataIndex: 'duration_ms',
              width: 70,
              render: (v) => v != null
                ? <Text style={{ fontSize: 12, color: v > 5000 ? '#ef4444' : v > 2000 ? '#f59e0b' : C.muted }}>{v.toFixed(0)}ms</Text>
                : <Text style={{ color: C.dim, fontSize: 11 }}>—</Text>,
            },
            {
              title: t('audit.column.status'),
              dataIndex: 'status',
              width: 90,
              render: (v) => (
                <Badge
                  status={v === 'success' ? 'success' : 'error'}
                  text={<span style={{ fontSize: 12, color: C.muted }}>{v}</span>}
                />
              ),
            },
            {
              title: '',
              width: 36,
              render: (_, r) => (
                <Button
                  size="small"
                  type="text"
                  icon={<InfoCircleOutlined style={{ color: C.dim }} />}
                  onClick={() => setSelected(r)}
                />
              ),
            },
          ]}
        />
      </div>

      {/* Audit Log v2 PR 2 — DetailModal → AuditDetailDrawer dönüşümü. */}
      <AuditDetailDrawer record={selected} onClose={() => setSelected(null)} />

    </div>
  )
}
