import { useState } from 'react'
import {
  Table, Tag, Input, Select, Space, Typography, Modal, Descriptions,
  Badge, Tooltip, Button, DatePicker, Collapse,
} from 'antd'
import {
  InfoCircleOutlined, ClockCircleOutlined, GlobalOutlined, CodeOutlined,
  FileSearchOutlined,
} from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/contexts/ThemeContext'
import dayjs from 'dayjs'
import { tasksApi } from '@/api/tasks'
import type { AuditLog } from '@/types'

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

const ACTION_HEX: Record<string, string> = {
  login: '#22c55e', login_failed: '#ef4444',
  device_created: '#3b82f6', device_deleted: '#f97316', device_updated: '#06b6d4',
  user_created: '#a855f7', user_deleted: '#ef4444',
  task_created: '#6366f1', cli_command: '#f59e0b',
  approval_requested: '#eab308', approval_approved: '#22c55e', approval_rejected: '#ef4444',
  playbook_run: '#a855f7', config_backup: '#06b6d4',
  password_changed: '#eab308',
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
]

function StateDiff({ before, after, isDark }: {
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  isDark: boolean
}) {
  if (!before && !after) return null
  const C = mkC(isDark)
  const keys = Array.from(new Set([...Object.keys(before || {}), ...Object.keys(after || {})]))
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead>
        <tr>
          <th style={{ textAlign: 'left', padding: '4px 8px', background: C.bg2, width: 160, color: C.muted }}>Alan</th>
          <th style={{ textAlign: 'left', padding: '4px 8px', background: isDark ? 'rgba(239,68,68,0.08)' : '#fff1f0', width: '50%', color: C.muted }}>Önce</th>
          <th style={{ textAlign: 'left', padding: '4px 8px', background: isDark ? 'rgba(34,197,94,0.08)' : '#f6ffed', color: C.muted }}>Sonra</th>
        </tr>
      </thead>
      <tbody>
        {keys.map((key) => {
          const bv = before?.[key]
          const av = after?.[key]
          const changed = JSON.stringify(bv) !== JSON.stringify(av)
          return (
            <tr key={key} style={{ borderBottom: `1px solid ${C.border}` }}>
              <td style={{ padding: '3px 8px', fontFamily: 'monospace', color: C.dim }}>{key}</td>
              <td style={{ padding: '3px 8px', color: changed ? '#ef4444' : C.muted, fontFamily: 'monospace', fontSize: 11 }}>
                {bv === null || bv === undefined ? <em style={{ opacity: 0.4 }}>—</em> : String(bv)}
              </td>
              <td style={{ padding: '3px 8px', color: changed ? '#22c55e' : C.muted, fontFamily: 'monospace', fontSize: 11 }}>
                {av === null || av === undefined ? <em style={{ opacity: 0.4 }}>—</em> : String(av)}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function DetailModal({ record, onClose, isDark }: { record: AuditLog; onClose: () => void; isDark: boolean }) {
  const C = mkC(isDark)
  const hasStateChange = record.before_state || record.after_state
  const hasDetails = record.details && Object.keys(record.details).length > 0
  const accentHex = ACTION_HEX[record.action] || '#64748b'

  return (
    <Modal
      open
      title={
        <Space>
          <div style={{
            width: 8, height: 8, borderRadius: '50%',
            background: accentHex, boxShadow: `0 0 6px ${accentHex}`,
          }} />
          <Tag
            style={{ color: accentHex, borderColor: accentHex + '60', background: accentHex + '18', fontSize: 12 }}
          >
            {record.action}
          </Tag>
          <Text style={{ fontSize: 13, color: C.text }}>{record.resource_name || record.resource_id || ''}</Text>
        </Space>
      }
      onCancel={onClose}
      footer={null}
      width={700}
      styles={{
        content: { background: C.bg, border: `1px solid ${C.border}` },
        header: { background: C.bg, borderBottom: `1px solid ${C.border}` },
      }}
    >
      <Descriptions size="small" column={2} bordered style={{ marginBottom: 16 }}
        styles={{ label: { background: C.bg2, color: C.muted }, content: { background: C.bg, color: C.text } }}
      >
        <Descriptions.Item label="Kullanıcı">{record.username}</Descriptions.Item>
        <Descriptions.Item label="Tarih">
          {dayjs(record.created_at).format('DD.MM.YYYY HH:mm:ss')}
        </Descriptions.Item>
        <Descriptions.Item label="IP">{record.client_ip || '—'}</Descriptions.Item>
        <Descriptions.Item label="Süre">
          {record.duration_ms != null ? (
            <Text style={{ color: record.duration_ms > 5000 ? '#ef4444' : C.text }}>
              {record.duration_ms.toFixed(0)} ms
            </Text>
          ) : '—'}
        </Descriptions.Item>
        <Descriptions.Item label="Durum">
          <Badge status={record.status === 'success' ? 'success' : 'error'} text={record.status} />
        </Descriptions.Item>
        <Descriptions.Item label="Request ID">
          <Text copyable style={{ fontSize: 11, fontFamily: 'monospace', color: C.muted }}>
            {record.request_id || '—'}
          </Text>
        </Descriptions.Item>
        {record.user_agent && (
          <Descriptions.Item label="User Agent" span={2}>
            <Text style={{ fontSize: 11, color: C.dim }}>{record.user_agent}</Text>
          </Descriptions.Item>
        )}
      </Descriptions>

      {hasStateChange && (
        <Collapse
          defaultActiveKey={['diff']}
          style={{ background: C.bg2, border: `1px solid ${C.border}` }}
          items={[{
            key: 'diff',
            label: <span style={{ color: C.text }}>Değişiklik (Before → After)</span>,
            children: <StateDiff before={record.before_state} after={record.after_state} isDark={isDark} />,
          }]}
        />
      )}

      {hasDetails && (
        <Collapse
          style={{ marginTop: 8, background: C.bg2, border: `1px solid ${C.border}` }}
          items={[{
            key: 'details',
            label: <span style={{ color: C.text }}>Detaylar (JSON)</span>,
            children: (
              <pre style={{
                fontSize: 12, margin: 0, maxHeight: 300, overflow: 'auto',
                background: '#0f172a', color: '#94a3b8',
                padding: '10px 14px', borderRadius: 6,
              }}>
                {JSON.stringify(record.details, null, 2)}
              </pre>
            ),
          }]}
        />
      )}
    </Modal>
  )
}

export default function AuditLogPage() {
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [resourceType, setResourceType] = useState<string>()
  const [statusFilter, setStatusFilter] = useState<string>()
  const [dateRange, setDateRange] = useState<[dayjs.Dayjs | null, dayjs.Dayjs | null] | null>(null)
  const [selected, setSelected] = useState<AuditLog | null>(null)
  const pageSize = 100
  const { t } = useTranslation()
  const { isDark } = useTheme()
  const C = mkC(isDark)

  const { data, isLoading } = useQuery({
    queryKey: ['audit-log', page, search, resourceType, statusFilter, dateRange],
    queryFn: () =>
      tasksApi.getAuditLog({
        skip: (page - 1) * pageSize,
        limit: pageSize,
        username: search || undefined,
        resource_type: resourceType,
        status: statusFilter,
        date_from: dateRange?.[0]?.toISOString(),
        date_to: dateRange?.[1]?.toISOString(),
      }),
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <style>{AUDIT_CSS}</style>

      {/* Header */}
      <div style={{
        background: isDark
          ? 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)'
          : C.bg,
        border: `1px solid ${isDark ? '#3b82f620' : C.border}`,
        borderLeft: `4px solid #3b82f6`,
        borderRadius: 12,
        padding: '16px 20px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        flexWrap: 'wrap',
        gap: 12,
        animation: isDark ? 'auditHeaderGlow 4s ease-in-out infinite' : undefined,
      }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 8,
              background: '#3b82f620',
              border: '1px solid #3b82f630',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <FileSearchOutlined style={{ color: '#3b82f6', fontSize: 18 }} />
            </div>
            <div>
              <div style={{ color: C.text, fontWeight: 700, fontSize: 16 }}>
                {t('audit.title')}
                <Text style={{ color: C.dim, fontSize: 13, fontWeight: 400, marginLeft: 8 }}>({data?.total || 0})</Text>
              </div>
              <div style={{ color: C.muted, fontSize: 12 }}>Tüm kullanıcı aksiyonlarının denetim kaydı</div>
            </div>
          </div>
        </div>

        <Space wrap>
          <Input.Search
            placeholder={t('audit.search_placeholder')}
            style={{ width: 180 }}
            allowClear
            onSearch={setSearch}
            onChange={(e) => !e.target.value && setSearch('')}
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
            style={{ width: 330 }}
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
              width: 110,
              render: (v) => <Text strong style={{ fontSize: 12, color: C.text }}>{v}</Text>,
            },
            {
              title: 'Aksiyon',
              dataIndex: 'action',
              render: (v, r) => {
                const hex = ACTION_HEX[v] || '#64748b'
                return (
                  <Space size={4}>
                    <Tag
                      style={{
                        fontSize: 11,
                        color: hex,
                        borderColor: hex + '50',
                        background: hex + '18',
                      }}
                    >
                      {v}
                    </Tag>
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
              render: (_, r) => r.resource_type
                ? <Text style={{ fontSize: 12, color: C.text }}>{r.resource_type}/{r.resource_name || r.resource_id}</Text>
                : <Text style={{ color: C.dim }}>—</Text>,
            },
            {
              title: 'IP',
              dataIndex: 'client_ip',
              width: 120,
              render: (v) => v
                ? <Space size={4}>
                    <GlobalOutlined style={{ fontSize: 11, color: C.dim }} />
                    <Text style={{ fontSize: 12, color: C.muted, fontFamily: 'monospace' }}>{v}</Text>
                  </Space>
                : <Text style={{ color: C.dim }}>—</Text>,
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

      {selected && <DetailModal record={selected} onClose={() => setSelected(null)} isDark={isDark} />}
    </div>
  )
}
