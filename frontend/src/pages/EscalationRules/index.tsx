import { useState } from 'react'
import {
  Table, Button, Space, Switch, Tag, Tooltip, Drawer, Form,
  Input, Select, InputNumber, Divider, Popconfirm, Badge,
  Alert, Tabs, Empty,
} from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined,
  PlayCircleOutlined, BellOutlined, CheckCircleOutlined,
  CloseCircleOutlined, ExperimentOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  escalationApi,
  type EscalationRule, type EscalationRulePayload,
} from '@/api/escalation'
import dayjs from 'dayjs'

const { Option } = Select

// ── Visual helpers ────────────────────────────────────────────────────────────

const WEBHOOK_COLOR: Record<string, string> = {
  slack:   '#4a154b',
  jira:    '#0052cc',
  generic: '#334155',
}

const SEV_COLOR: Record<string, string> = {
  critical: 'error',
  warning:  'warning',
  info:     'processing',
}

const STATUS_ICON = {
  sent:    <CheckCircleOutlined style={{ color: '#22c55e' }} />,
  failed:  <CloseCircleOutlined style={{ color: '#ef4444' }} />,
  dry_run: <ExperimentOutlined  style={{ color: '#94a3b8' }} />,
}

function HumanDuration({ secs }: { secs: number }) {
  if (secs < 60) return <span>{secs}s</span>
  if (secs < 3600) return <span>{Math.round(secs / 60)}dk</span>
  return <span>{Math.round(secs / 3600)}sa</span>
}

// ── Rule form drawer ──────────────────────────────────────────────────────────

const SEVERITIES   = ['critical', 'warning', 'info']
const EVENT_TYPES  = ['device_offline', 'port_down', 'threshold_alert', 'stp_event',
                      'routing_change', 'bgp_peer_down', 'config_change', 'device_restart']
const SOURCES      = ['snmp_trap', 'syslog', 'synthetic', 'agent_health']
const STATES       = ['OPEN', 'DEGRADED', 'RECOVERING']
const WEBHOOK_TYPES = ['slack', 'jira', 'generic'] as const

interface RuleDrawerProps {
  rule: EscalationRule | null
  onClose: () => void
  onSaved: () => void
}

function RuleDrawer({ rule, onClose, onSaved }: RuleDrawerProps) {
  const [form] = Form.useForm()
  const qc = useQueryClient()
  const isEdit = !!rule

  const save = useMutation({
    mutationFn: async (values: Record<string, unknown>) => {
      const payload: EscalationRulePayload = {
        name:              values.name as string,
        enabled:           values.enabled as boolean ?? true,
        description:       (values.description as string) || null,
        webhook_type:      values.webhook_type as 'slack' | 'jira' | 'generic',
        webhook_url:       values.webhook_url as string,
        cooldown_secs:     (values.cooldown_secs as number) ?? 3600,
        match_severity:    (values.match_severity as string[])?.length ? values.match_severity as string[] : null,
        match_event_types: (values.match_event_types as string[])?.length ? values.match_event_types as string[] : null,
        match_sources:     (values.match_sources as string[])?.length ? values.match_sources as string[] : null,
        match_states:      (values.match_states as string[])?.length ? values.match_states as string[] : null,
        min_duration_secs: (values.min_duration_secs as number) || null,
        webhook_headers:   null,
      }
      // Parse extra headers as JSON
      if (values.webhook_headers_raw) {
        try { payload.webhook_headers = JSON.parse(values.webhook_headers_raw as string) }
        catch { /* ignore invalid JSON */ }
      }
      return isEdit
        ? escalationApi.update(rule!.id, payload)
        : escalationApi.create(payload)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['escalation-rules'] })
      onSaved()
    },
  })

  const initial = rule ? {
    name:              rule.name,
    enabled:           rule.enabled,
    description:       rule.description,
    webhook_type:      rule.webhook_type,
    webhook_url:       rule.webhook_url,
    cooldown_secs:     rule.cooldown_secs,
    match_severity:    rule.match_severity ?? [],
    match_event_types: rule.match_event_types ?? [],
    match_sources:     rule.match_sources ?? [],
    match_states:      rule.match_states ?? [],
    min_duration_secs: rule.min_duration_secs,
    webhook_headers_raw: rule.webhook_header_keys.length
      ? `{${rule.webhook_header_keys.map(k => `"${k}": "***"`).join(', ')}}`
      : '',
  } : {
    enabled: true,
    cooldown_secs: 3600,
    webhook_type: 'slack',
    match_severity: [], match_event_types: [], match_sources: [], match_states: [],
  }

  return (
    <Drawer
      title={isEdit ? `Kural Düzenle — ${rule!.name}` : 'Yeni Escalation Kuralı'}
      open
      onClose={onClose}
      width={520}
      destroyOnHidden
      footer={
        <Space style={{ float: 'right' }}>
          <Button onClick={onClose}>İptal</Button>
          <Button type="primary" loading={save.isPending} onClick={() => form.submit()}>
            {isEdit ? 'Güncelle' : 'Oluştur'}
          </Button>
        </Space>
      }
    >
      <Form form={form} layout="vertical" initialValues={initial}
        onFinish={(v) => save.mutate(v)}>

        <Form.Item name="name" label="Kural Adı" rules={[{ required: true }]}>
          <Input placeholder="Kritik Cihaz Offline → Slack" />
        </Form.Item>
        <Form.Item name="description" label="Açıklama">
          <Input.TextArea rows={2} />
        </Form.Item>
        <Form.Item name="enabled" label="Etkin" valuePropName="checked">
          <Switch />
        </Form.Item>

        <Divider orientation="left" plain style={{ fontSize: 12, color: '#94a3b8' }}>Eşleştirme Koşulları</Divider>

        <Form.Item name="match_severity" label="Severity (boş = tümü)">
          <Select mode="multiple" allowClear>
            {SEVERITIES.map(s => <Option key={s} value={s}>{s}</Option>)}
          </Select>
        </Form.Item>
        <Form.Item name="match_event_types" label="Olay Tipi (boş = tümü)">
          <Select mode="multiple" allowClear>
            {EVENT_TYPES.map(e => <Option key={e} value={e}>{e}</Option>)}
          </Select>
        </Form.Item>
        <Form.Item name="match_sources" label="Kaynak (boş = tümü)">
          <Select mode="multiple" allowClear>
            {SOURCES.map(s => <Option key={s} value={s}>{s}</Option>)}
          </Select>
        </Form.Item>
        <Form.Item name="match_states" label="İncident Durumu (boş = OPEN + DEGRADED)">
          <Select mode="multiple" allowClear>
            {STATES.map(s => <Option key={s} value={s}>{s}</Option>)}
          </Select>
        </Form.Item>
        <Form.Item name="min_duration_secs" label="Min. Süre (saniye, boş = anlık)">
          <InputNumber min={0} style={{ width: '100%' }} placeholder="Örn: 300 (5 dk)" />
        </Form.Item>

        <Divider orientation="left" plain style={{ fontSize: 12, color: '#94a3b8' }}>Webhook</Divider>

        <Form.Item name="webhook_type" label="Tip" rules={[{ required: true }]}>
          <Select>
            {WEBHOOK_TYPES.map(t => <Option key={t} value={t}>{t}</Option>)}
          </Select>
        </Form.Item>
        <Form.Item name="webhook_url" label="URL" rules={[{ required: true, type: 'url', message: 'Geçerli bir URL girin' }]}>
          <Input placeholder="https://hooks.slack.com/services/..." />
        </Form.Item>
        <Form.Item name="webhook_headers_raw" label={
          <span>Ek Header'lar <span style={{ color: '#64748b', fontSize: 11 }}>(JSON, opsiyonel)</span></span>
        }>
          <Input.TextArea rows={2} placeholder={'{"Authorization": "Bearer token"}'} />
        </Form.Item>

        <Divider orientation="left" plain style={{ fontSize: 12, color: '#94a3b8' }}>Cooldown</Divider>

        <Form.Item name="cooldown_secs" label="Tekrar Bildirim Süresi (saniye)"
          tooltip="Aynı incident için bu süre dolmadan ikinci bildirim gönderilmez">
          <InputNumber min={60} style={{ width: '100%' }} />
        </Form.Item>
      </Form>
    </Drawer>
  )
}

// ── Logs tab ──────────────────────────────────────────────────────────────────

function LogsTab({ ruleId }: { ruleId?: number }) {
  const { data, isLoading } = useQuery({
    queryKey: ['escalation-logs', ruleId],
    queryFn: () => escalationApi.getLogs({ rule_id: ruleId, limit: 50 }),
    refetchInterval: 30_000,
  })

  const cols = [
    { title: 'Incident', dataIndex: 'incident_id', width: 80 },
    {
      title: 'Durum', dataIndex: 'status', width: 90,
      render: (s: string) => (
        <Space size={4}>
          {STATUS_ICON[s as keyof typeof STATUS_ICON]}
          <span style={{ fontSize: 12 }}>{s}</span>
        </Space>
      ),
    },
    { title: 'HTTP', dataIndex: 'response_code', width: 60,
      render: (v: number | null) => v ? <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{v}</span> : '—' },
    { title: 'Hata', dataIndex: 'error_msg', ellipsis: true,
      render: (v: string | null) => v
        ? <Tooltip title={v}><span style={{ color: '#ef4444', fontSize: 12 }}>{v.slice(0, 40)}…</span></Tooltip>
        : '—' },
    { title: 'Zaman', dataIndex: 'sent_at',
      render: (v: string) => <span style={{ fontSize: 12 }}>{dayjs(v).format('DD.MM HH:mm:ss')}</span> },
  ]

  return (
    <Table
      size="small"
      loading={isLoading}
      dataSource={data?.items ?? []}
      columns={cols as any}
      rowKey="id"
      pagination={{ pageSize: 10, size: 'small' }}
      locale={{ emptyText: <Empty description="Henüz bildirim yok" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
    />
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function EscalationRulesPage() {
  const qc = useQueryClient()
  const [drawerRule, setDrawerRule] = useState<EscalationRule | 'new' | null>(null)
  const [testResult, setTestResult] = useState<Record<number, { loading: boolean; result?: string }>>({})

  const { data: rules = [], isLoading } = useQuery({
    queryKey: ['escalation-rules'],
    queryFn: escalationApi.list,
    refetchInterval: 60_000,
  })

  const toggleEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      escalationApi.update(id, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['escalation-rules'] }),
  })

  const deleteRule = useMutation({
    mutationFn: (id: number) => escalationApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['escalation-rules'] }),
  })

  const runTest = async (rule: EscalationRule) => {
    setTestResult(p => ({ ...p, [rule.id]: { loading: true } }))
    try {
      const res = await escalationApi.test(rule.id, true)
      const msg = !res.matched
        ? 'Eşleşen aktif incident bulunamadı'
        : `Dry-run başarılı — incident #${res.incident_id}`
      setTestResult(p => ({ ...p, [rule.id]: { loading: false, result: msg } }))
    } catch {
      setTestResult(p => ({ ...p, [rule.id]: { loading: false, result: 'Test başarısız' } }))
    }
  }

  const columns = [
    {
      title: 'Etkin', dataIndex: 'enabled', width: 60,
      render: (v: boolean, r: EscalationRule) => (
        <Switch
          checked={v} size="small"
          loading={toggleEnabled.isPending}
          onChange={(val) => toggleEnabled.mutate({ id: r.id, enabled: val })}
        />
      ),
    },
    {
      title: 'Kural Adı', dataIndex: 'name',
      render: (v: string, r: EscalationRule) => (
        <div>
          <span style={{ fontWeight: 500 }}>{v}</span>
          {r.description && (
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{r.description}</div>
          )}
        </div>
      ),
    },
    {
      title: 'Koşullar', key: 'matchers',
      render: (_: unknown, r: EscalationRule) => (
        <Space size={4} wrap>
          {r.match_severity?.map(s => <Tag key={s} color={SEV_COLOR[s]}>{s}</Tag>)}
          {r.match_event_types?.map(e => <Tag key={e} style={{ fontSize: 11 }}>{e}</Tag>)}
          {r.min_duration_secs && (
            <Tooltip title="Minimum incident süresi">
              <Tag color="default">≥<HumanDuration secs={r.min_duration_secs} /></Tag>
            </Tooltip>
          )}
          {!r.match_severity?.length && !r.match_event_types?.length && !r.min_duration_secs && (
            <span style={{ color: '#94a3b8', fontSize: 12 }}>Tümü</span>
          )}
        </Space>
      ),
    },
    {
      title: 'Webhook', key: 'webhook',
      render: (_: unknown, r: EscalationRule) => (
        <Space direction="vertical" size={2}>
          <Tag style={{
            background: WEBHOOK_COLOR[r.webhook_type] + '30',
            border: `1px solid ${WEBHOOK_COLOR[r.webhook_type]}40`,
            color: '#f1f5f9',
            fontSize: 11,
          }}>
            {r.webhook_type.toUpperCase()}
          </Tag>
          <Tooltip title={r.webhook_url}>
            <span style={{ fontSize: 11, color: '#64748b' }}>
              {r.webhook_url.length > 35 ? r.webhook_url.slice(0, 35) + '…' : r.webhook_url}
            </span>
          </Tooltip>
        </Space>
      ),
    },
    {
      title: 'Cooldown', key: 'cooldown', width: 90,
      render: (_: unknown, r: EscalationRule) => <HumanDuration secs={r.cooldown_secs} />,
    },
    {
      title: '', key: 'actions', width: 120,
      render: (_: unknown, r: EscalationRule) => (
        <Space size={2}>
          <Tooltip title="Dry-run test">
            <Button
              size="small" type="text"
              icon={<PlayCircleOutlined style={{ color: '#22c55e' }} />}
              loading={testResult[r.id]?.loading}
              onClick={() => runTest(r)}
            />
          </Tooltip>
          <Tooltip title="Düzenle">
            <Button size="small" type="text" icon={<EditOutlined />} onClick={() => setDrawerRule(r)} />
          </Tooltip>
          <Popconfirm title="Kural silinsin mi?" onConfirm={() => deleteRule.mutate(r.id)} okText="Sil" cancelText="İptal">
            <Button size="small" type="text" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Space>
          <BellOutlined style={{ fontSize: 18, color: '#f59e0b' }} />
          <span style={{ fontSize: 16, fontWeight: 600 }}>Escalation Kuralları</span>
          <Badge count={rules.filter(r => r.enabled).length} color="#22c55e"
            title={`${rules.filter(r => r.enabled).length} etkin kural`} />
        </Space>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setDrawerRule('new')}>
          Yeni Kural
        </Button>
      </div>

      {/* Dry-run result alerts */}
      {Object.entries(testResult).map(([ruleId, { loading, result }]) =>
        !loading && result ? (
          <Alert
            key={ruleId}
            message={`Kural #${ruleId}: ${result}`}
            type={result.includes('başarılı') ? 'success' : 'warning'}
            closable
            onClose={() => setTestResult(p => { const n = { ...p }; delete n[Number(ruleId)]; return n })}
            style={{ marginBottom: 8 }}
          />
        ) : null
      )}

      <Tabs
        items={[
          {
            key: 'rules',
            label: 'Kurallar',
            children: (
              <Table
                loading={isLoading}
                dataSource={rules}
                columns={columns as any}
                rowKey="id"
                size="middle"
                pagination={{ pageSize: 20, size: 'small' }}
                locale={{ emptyText: (
                  <Empty
                    description="Henüz escalation kuralı yok"
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                  >
                    <Button type="primary" icon={<PlusOutlined />} onClick={() => setDrawerRule('new')}>
                      İlk Kuralı Oluştur
                    </Button>
                  </Empty>
                )}}
              />
            ),
          },
          {
            key: 'logs',
            label: 'Bildirim Geçmişi',
            children: <LogsTab />,
          },
        ]}
      />

      {drawerRule !== null && (
        <RuleDrawer
          rule={drawerRule === 'new' ? null : drawerRule}
          onClose={() => setDrawerRule(null)}
          onSaved={() => setDrawerRule(null)}
        />
      )}
    </div>
  )
}
