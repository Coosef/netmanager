import { useState } from 'react'
import {
  Table, Tag, Input, Select, Space, Typography,
  Badge, Tooltip, Button, DatePicker,
} from 'antd'
import {
  InfoCircleOutlined, ClockCircleOutlined, GlobalOutlined, CodeOutlined,
  DownloadOutlined, UserOutlined,
} from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { useTheme } from '@/contexts/ThemeContext'
import dayjs from 'dayjs'
import { tasksApi } from '@/api/tasks'
import type { AuditLog } from '@/types'
import AuditActionChip from './AuditActionChip'
import AuditDetailDrawer from './AuditDetailDrawer'
import AuditResourceLink from './AuditResourceLink'

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

// Audit Log v2 PR 2 — eski ACTION_HEX legacy map KALDIRILDI.
// AuditActionChip (PR 1) + AuditDetailDrawer (PR 2) artık tüm action
// renk/ikon kararlarını auditActionCategory üzerinden yapıyor.

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

const RESOURCE_TYPES = [
  { label: 'Cihaz', value: 'device' },
  { label: 'Kullanıcı', value: 'user' },
  { label: 'Görev', value: 'task' },
  { label: 'Playbook', value: 'playbook' },
  { label: 'Approval', value: 'approval' },
  { label: 'Agent', value: 'agent' },
]

// Audit Log v2 PR 2 — inline StateDiff + DetailModal KALDIRILDI.
// Yeni: AuditDetailDrawer.tsx (Modal → Drawer, ÖZET + DİFF + Raw)
//       AuditDiffViewer.tsx (field-level diff + add/change/remove)
//       auditFormatters.ts (action-spesifik human-readable summary)


function exportCSV(items: AuditLog[]) {
  const headers = ['ID', 'Zaman', 'Kullanıcı', 'Rol', 'Aksiyon', 'Kaynak Tipi', 'Kaynak', 'IP', 'Süre(ms)', 'Durum', 'UA']
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
  return (
    <div className="nm-page" style={{ padding: '4px 2px' }}>
      <style>{AUDIT_CSS}</style>

      <div className="nm-page-hd">
        <div className="title-block">
          <div className="nm-crumbs"><span>Yönetim</span><span>Denetim Kaydı</span></div>
          <h1 className="nm-page-title">
            Denetim Kaydı
            <span className="nm-pill mono">{data?.total ?? 0} kayıt</span>
            {(data?.failure_count ?? 0) > 0 && <span className="nm-pill crit">{data?.failure_count} başarısız</span>}
          </h1>
          <div className="nm-page-sub">Tüm kullanıcı aksiyonlarının denetim kaydı — kim, ne zaman, hangi kaynağa, hangi IP'den.</div>
        </div>
        <div className="nm-page-actions">
          <button className="nm-btn primary" onClick={() => data?.items && exportCSV(data.items)} disabled={!data?.items?.length}>
            <DownloadOutlined /> CSV İndir
          </button>
        </div>
      </div>

      <div className="nm-statbar">
        <div className="nm-stat"><div className="nm-stat-label">Toplam Kayıt</div><div className="nm-stat-val">{data?.total ?? 0}</div></div>
        <div className="nm-stat ok"><div className="nm-stat-label">Başarılı</div><div className="nm-stat-val">{successCount}</div></div>
        <div className="nm-stat crit"><div className="nm-stat-label">Başarısız</div><div className="nm-stat-val">{data?.failure_count ?? 0}</div></div>
        <div className="nm-stat"><div className="nm-stat-label">Benzersiz Kullanıcı</div><div className="nm-stat-val">{data?.unique_users ?? 0}</div></div>
        <div className="nm-stat"><div className="nm-stat-label">Sayfa</div><div className="nm-stat-val">{page}</div><div className="nm-stat-delta">/ {Math.max(1, Math.ceil((data?.total ?? 0) / 50))}</div></div>
        <div className="nm-stat"><div className="nm-stat-label">Görüntülenen</div><div className="nm-stat-val">{data?.items?.length ?? 0}</div></div>
      </div>

      {/* Filter card */}
      <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8, padding: '10px 12px', marginBottom: 12 }}>
        <Space wrap>
          <Input.Search
            placeholder="Kullanıcı ara..."
            style={{ width: 150 }}
            allowClear
            onSearch={setSearch}
            onChange={(e) => !e.target.value && setSearch('')}
            prefix={<UserOutlined style={{ color: C.dim }} />}
          />
          <Input.Search
            placeholder="Aksiyon ara..."
            style={{ width: 150 }}
            allowClear
            onSearch={setActionFilter}
            onChange={(e) => !e.target.value && setActionFilter('')}
          />
          <Input.Search
            placeholder="IP ara..."
            style={{ width: 140 }}
            allowClear
            onSearch={setIpFilter}
            onChange={(e) => !e.target.value && setIpFilter('')}
            prefix={<GlobalOutlined style={{ color: C.dim }} />}
          />
          <Select
            placeholder="Kaynak tipi"
            allowClear
            style={{ width: 130 }}
            onChange={setResourceType}
            options={RESOURCE_TYPES}
          />
          <Select
            placeholder="Durum"
            allowClear
            style={{ width: 110 }}
            onChange={setStatusFilter}
            options={[
              { label: 'Başarılı', value: 'success' },
              { label: 'Başarısız', value: 'failure' },
            ]}
          />
          <DatePicker.RangePicker
            showTime={{ format: 'HH:mm' }}
            format="DD.MM.YY HH:mm"
            style={{ width: 310 }}
            onChange={(range) => {
              setDateRange(range as [dayjs.Dayjs | null, dayjs.Dayjs | null] | null)
              setPage(1)
            }}
          />
        </Space>
      </div>

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
          pagination={{
            total: data?.total,
            pageSize,
            current: page,
            onChange: setPage,
            showTotal: (n) => <span style={{ color: C.muted }}>{n} kayıt</span>,
            showSizeChanger: false,
            style: { padding: '8px 16px' },
          }}
          columns={[
            {
              title: 'Zaman',
              dataIndex: 'created_at',
              width: 145,
              render: (v) => (
                <Text style={{ fontSize: 12, fontFamily: 'monospace', color: C.muted }}>
                  {dayjs(v).format('DD.MM.YY HH:mm:ss')}
                </Text>
              ),
            },
            {
              title: 'Kullanıcı',
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
              title: 'Aksiyon',
              dataIndex: 'action',
              render: (v, r) => {
                // Audit Log v2 PR 1 — kategori-bazlı chip (ikon + renk + label).
                // status=failure görsel ayrımı chip içinde işlenir.
                // ACTION_HEX map eski tek-renk fallback — şimdilik dosyada kalıyor
                // (PR 2/3/4'te tamamen kaldırılacak), bu kolonda kullanılmıyor.
                return (
                  <Space size={4}>
                    <AuditActionChip action={v} status={r.status} compact />
                    {(r.before_state || r.after_state) && (
                      <Tooltip title="Before/After değişiklik mevcut">
                        <CodeOutlined style={{ color: '#3b82f6', fontSize: 12 }} />
                      </Tooltip>
                    )}
                  </Space>
                )
              },
            },
            {
              title: 'Kaynak',
              // Audit Log v2 PR 3 — düz text yerine AuditResourceLink.
              // Permission + route resolution + tooltip + truncate component
              // tarafında ele alınır. compact=true ile tablo içi kısa render.
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
              title: 'IP (gerçek)',
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
              title: 'İstemci',
              dataIndex: 'user_agent',
              width: 80,
              render: (v) => (
                <Tooltip title={v || '—'}>
                  <Text style={{ fontSize: 11, color: C.muted }}>{parseUA(v)}</Text>
                </Tooltip>
              ),
            },
            {
              title: <Tooltip title="İşlem süresi"><ClockCircleOutlined /></Tooltip>,
              dataIndex: 'duration_ms',
              width: 70,
              render: (v) => v != null
                ? <Text style={{ fontSize: 12, color: v > 5000 ? '#ef4444' : v > 2000 ? '#f59e0b' : C.muted }}>{v.toFixed(0)}ms</Text>
                : <Text style={{ color: C.dim, fontSize: 11 }}>—</Text>,
            },
            {
              title: 'Durum',
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
