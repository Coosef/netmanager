import React, { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import {
  Typography, Switch, Divider, Tag, Table, Button, Modal, Form,
  Input, Select, Space, message, Popconfirm, Tooltip, InputNumber, Alert, DatePicker,
  Checkbox, Row, Col,
} from 'antd'
import {
  GlobalOutlined, BgColorsOutlined, SunOutlined, MoonOutlined,
  CheckOutlined, BellOutlined, PlusOutlined, EditOutlined,
  DeleteOutlined, ThunderboltOutlined, SendOutlined, AlertOutlined, ToolOutlined, SafetyOutlined,
  LockOutlined, CheckCircleOutlined, CloseCircleOutlined, SyncOutlined, PlayCircleOutlined,
  ClockCircleOutlined, RiseOutlined, WifiOutlined, KeyOutlined, CopyOutlined, ExclamationCircleOutlined,
  CodeOutlined, RobotOutlined,
} from '@ant-design/icons'
import DriverTemplatesPage from '@/pages/DriverTemplates'
import SystemSettingsTab from '@/pages/Settings/SystemSettingsTab'
import PasswordPolicyTab from '@/pages/Settings/PasswordPolicyTab'
// MfaTab artık /profile sayfasında reuse ediliyor; Settings tab'ı kaldırıldı.
import { apiTokensApi, ApiToken } from '@/api/apiTokens'
import dayjs from 'dayjs'
import { useTheme } from '@/contexts/ThemeContext'
import i18n from '@/i18n'
import {
  notificationsApi, NotificationChannel, ChannelType, NOTIFY_ON_OPTIONS,
} from '@/api/notifications'
import { alertRulesApi, AlertRule, AlertRulePayload, METRIC_OPTIONS, SEVERITY_OPTIONS } from '@/api/alertRules'
import { maintenanceWindowsApi, MaintenanceWindow } from '@/api/maintenanceWindows'
import { credentialProfilesApi, CredentialProfile, RotationPolicy } from '@/api/credentialProfiles'
import { devicesApi } from '@/api/devices'
import { slaApi, SlaPolicy, SlaPolicyCreate } from '@/api/sla'
import { snmpApi, BulkSshResult, BulkSshDeviceResult } from '@/api/snmp'
import { aiAssistantApi, type AIProviderSettings } from '@/api/aiAssistant'

const { Text } = Typography

// T9 follow-up — i18n auto-discovery. LANGUAGES artık locales/*.json
// dosyalarından üretilir; yeni dil eklemek için sadece JSON kopyalanıp
// çevrilir, kod değişikliği yok.
import { availableLanguages } from '@/i18n'
const LANGUAGES = availableLanguages.map((l) => ({
  code: l.code,
  label: l.name,
  flag: l.flag || '🌐',
  region: l.region || '',
}))

function SectionHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
      <span style={{ fontSize: 16, opacity: 0.7 }}>{icon}</span>
      <Text style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', opacity: 0.5, textTransform: 'uppercase' }}>
        {title}
      </Text>
    </div>
  )
}

// ── Notification Channels CRUD ──────────────────────────────────────────────

function ChannelTypeConfig({ type }: { type: ChannelType }) {
  const { t } = useTranslation()
  if (type === 'email') return (
    <>
      <Form.Item label="SMTP Host" name={['config', 'smtp_host']} rules={[{ required: true }]}>
        <Input placeholder="smtp.example.com" />
      </Form.Item>
      <Form.Item label="SMTP Port" name={['config', 'smtp_port']}>
        <Input type="number" placeholder="587" />
      </Form.Item>
      <Form.Item label="TLS" name={['config', 'smtp_use_tls']} valuePropName="checked">
        <Switch />
      </Form.Item>
      <Form.Item label={t('common.username')} name={['config', 'smtp_username']}>
        <Input />
      </Form.Item>
      <Form.Item label={t('common.password')} name={['config', 'smtp_password']}>
        <Input.Password />
      </Form.Item>
      <Form.Item label={t('settings.notifications.email.recipients_label')} name={['config', 'recipients']} extra={t('settings.notifications.email.recipients_extra')}>
        <Select mode="tags" tokenSeparators={[',']} placeholder="user@example.com" />
      </Form.Item>
    </>
  )
  if (type === 'slack') return (
    <Form.Item label="Webhook URL" name={['config', 'webhook_url']} rules={[{ required: true }]}>
      <Input placeholder="https://hooks.slack.com/services/..." />
    </Form.Item>
  )
  if (type === 'teams') return (
    <Form.Item label="Webhook URL" name={['config', 'webhook_url']} rules={[{ required: true }]}
      extra={t('settings.notifications.teams.webhook_extra')}>
      <Input placeholder="https://outlook.office.com/webhook/..." />
    </Form.Item>
  )
  if (type === 'webhook') return (
    <>
      <Form.Item label={t('settings.notifications.webhook.url_label')} name={['config', 'url']} rules={[{ required: true }]}>
        <Input placeholder="https://example.com/hooks/netmanager" />
      </Form.Item>
      <Form.Item label={t('settings.notifications.webhook.headers_label')} name={['config', 'headers']}
        extra={t('settings.notifications.webhook.headers_extra')}>
        <Input.TextArea rows={3} placeholder='{"Authorization": "Bearer ..."}' />
      </Form.Item>
    </>
  )
  if (type === 'telegram') return (
    <>
      <Form.Item label={t('settings.notifications.telegram.bot_token_label')} name={['config', 'bot_token']} rules={[{ required: true }]}>
        <Input.Password placeholder="123456:ABC..." />
      </Form.Item>
      <Form.Item label={t('settings.notifications.telegram.chat_id_label')} name={['config', 'chat_id']} rules={[{ required: true }]}>
        <Input placeholder="-1001234567890" />
      </Form.Item>
    </>
  )
  if (type === 'jira') return (
    <>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12, fontSize: 12 }}
        message={t('settings.notifications.jira.info_alert')}
      />
      <Form.Item
        label={t('settings.notifications.jira.url_label')}
        name={['config', 'jira_url']}
        rules={[{ required: true }]}
        extra={t('settings.notifications.jira.url_extra')}
      >
        <Input placeholder="https://mycompany.atlassian.net" />
      </Form.Item>
      <Form.Item
        label={t('settings.notifications.jira.email_label')}
        name={['config', 'jira_email']}
        rules={[{ required: true }]}
      >
        <Input placeholder="user@example.com" />
      </Form.Item>
      <Form.Item
        label={t('settings.notifications.jira.api_token_label')}
        name={['config', 'jira_api_token']}
        rules={[{ required: true }]}
        extra={t('settings.notifications.jira.api_token_extra')}
      >
        <Input.Password placeholder="ATATT3xFfGF0..." />
      </Form.Item>
      <Form.Item
        label={t('settings.notifications.jira.project_key_label')}
        name={['config', 'jira_project_key']}
        rules={[{ required: true }]}
        extra={t('settings.notifications.jira.project_key_extra')}
      >
        <Input placeholder="NET" style={{ width: 160 }} />
      </Form.Item>
      <Form.Item
        label={t('settings.notifications.jira.issue_type_label')}
        name={['config', 'jira_issue_type']}
        initialValue="Bug"
        extra={t('settings.notifications.jira.issue_type_extra')}
      >
        <Select style={{ width: 200 }}>
          <Select.Option value="Bug">Bug</Select.Option>
          <Select.Option value="Task">Task</Select.Option>
          <Select.Option value="Incident">Incident</Select.Option>
          <Select.Option value="Story">Story</Select.Option>
          <Select.Option value="Epic">Epic</Select.Option>
        </Select>
      </Form.Item>
    </>
  )
  return null
}

// ── Alert Rules CRUD ──────────────────────────────────────────────────────────

function AlertRulesTab() {
  const qc = useQueryClient()
  const { t } = useTranslation()
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<AlertRule | null>(null)
  const [form] = Form.useForm()

  const { data: rules = [], isLoading } = useQuery({
    queryKey: ['alert-rules'],
    queryFn: alertRulesApi.list,
  })

  const { data: devices = [] } = useQuery({
    queryKey: ['devices-simple'],
    queryFn: () => devicesApi.list({ limit: 500 }).then((r) => r.items),
  })

  const saveMutation = useMutation({
    mutationFn: async (values: any) => {
      const payload: AlertRulePayload = {
        name: values.name,
        device_id: values.device_id ?? null,
        if_name_pattern: values.if_name_pattern || null,
        metric: values.metric,
        threshold_value: Number(values.threshold_value),
        consecutive_count: Number(values.consecutive_count ?? 2),
        severity: values.severity,
        cooldown_minutes: Number(values.cooldown_minutes ?? 60),
        enabled: values.enabled ?? true,
      }
      if (editing) return alertRulesApi.update(editing.id, payload)
      return alertRulesApi.create(payload)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alert-rules'] })
      setModalOpen(false)
      form.resetFields()
      setEditing(null)
      message.success(editing ? t('settings.alert_rules.toast.updated') : t('settings.alert_rules.toast.created'))
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || t('common.error_occurred')),
  })

  const deleteMutation = useMutation({
    mutationFn: alertRulesApi.delete,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alert-rules'] })
      message.success(t('settings.alert_rules.toast.deleted'))
    },
  })

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      alertRulesApi.update(id, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alert-rules'] }),
  })

  function openCreate() {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({ metric: 'max_util_pct', severity: 'warning', consecutive_count: 2, cooldown_minutes: 60, enabled: true })
    setModalOpen(true)
  }

  function openEdit(rule: AlertRule) {
    setEditing(rule)
    form.setFieldsValue({ ...rule, device_id: rule.device_id ?? undefined })
    setModalOpen(true)
  }

  const columns = [
    {
      title: t('settings.alert_rules.col.name'), dataIndex: 'name', render: (v: string, r: AlertRule) => (
        <Space>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: r.enabled ? '#22c55e' : '#475569', display: 'inline-block', marginRight: 2 }} />
          <strong>{v}</strong>
        </Space>
      ),
    },
    {
      title: t('settings.alert_rules.col.device'), dataIndex: 'device_id',
      render: (v: number | null) => v
        ? <Tag>{devices.find((d) => d.id === v)?.hostname || `#${v}`}</Tag>
        : <Tag color="default">{t('settings.alert_rules.all_devices')}</Tag>,
    },
    {
      title: t('settings.alert_rules.col.interface'), dataIndex: 'if_name_pattern',
      render: (v: string | null) => <code style={{ fontSize: 11 }}>{v || '*'}</code>,
    },
    {
      title: t('settings.alert_rules.col.metric_threshold'), render: (_: any, r: AlertRule) => (
        <Space>
          <Tag color="blue">{METRIC_OPTIONS.find((m) => m.value === r.metric)?.label || r.metric}</Tag>
          <Tag color={r.threshold_value >= 80 ? 'red' : r.threshold_value >= 60 ? 'orange' : 'green'}>
            {r.metric === 'error_rate' ? `>${r.threshold_value}/${t('settings.unit.min_short')}` : `≥ ${r.threshold_value}%`}
          </Tag>
        </Space>
      ),
    },
    {
      title: t('settings.alert_rules.col.consecutive_poll'), dataIndex: 'consecutive_count',
      render: (v: number) => <Tag>{v}x</Tag>,
      width: 90,
    },
    {
      title: t('settings.alert_rules.col.severity'), dataIndex: 'severity',
      render: (v: string) => <Tag color={v === 'critical' ? 'red' : 'orange'}>{v === 'critical' ? t('common.critical') : t('common.warning')}</Tag>,
      width: 80,
    },
    {
      title: t('settings.alert_rules.col.enabled'), dataIndex: 'enabled', width: 70,
      render: (v: boolean, r: AlertRule) => (
        <Switch
          size="small"
          checked={v}
          onChange={(val) => toggleMutation.mutate({ id: r.id, enabled: val })}
        />
      ),
    },
    {
      title: t('settings.col.action'), width: 90,
      render: (_: any, r: AlertRule) => (
        <Space>
          <Tooltip title={t('common.edit')}>
            <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} />
          </Tooltip>
          <Popconfirm title={t('settings.alert_rules.popconfirm.delete_title')} onConfirm={() => deleteMutation.mutate(r.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={t('settings.alert_rules.intro_message')}
        description={t('settings.alert_rules.intro_desc')}
      />
      <div style={{ marginBottom: 12 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          {t('settings.alert_rules.btn_new')}
        </Button>
      </div>
      <Table
        dataSource={rules}
        rowKey="id"
        columns={columns}
        loading={isLoading}
        size="small"
        pagination={false}
        locale={{ emptyText: t('settings.alert_rules.empty') }}
      />

      <Modal
        title={editing ? t('settings.alert_rules.modal.title_edit') : t('settings.alert_rules.modal.title_new')}
        open={modalOpen}
        onCancel={() => { setModalOpen(false); setEditing(null) }}
        onOk={() => form.submit()}
        confirmLoading={saveMutation.isPending}
        width={520}
      >
        <Form form={form} layout="vertical" onFinish={(v) => saveMutation.mutate(v)}>
          <Form.Item label={t('settings.alert_rules.form.name_label')} name="name" rules={[{ required: true }]}>
            <Input placeholder={t('settings.alert_rules.form.name_placeholder')} />
          </Form.Item>
          <Form.Item label={t('settings.alert_rules.form.device_label')} name="device_id" tooltip={t('settings.alert_rules.form.device_tooltip')}>
            <Select
              allowClear
              placeholder={t('settings.alert_rules.form.device_placeholder')}
              showSearch
              filterOption={(input, opt) =>
                (opt?.label as string ?? '').toLowerCase().includes(input.toLowerCase())
              }
              options={devices.map((d) => ({ label: `${d.hostname} (${d.ip_address})`, value: d.id }))}
            />
          </Form.Item>
          <Form.Item
            label={t('settings.alert_rules.form.interface_pattern_label')}
            name="if_name_pattern"
            tooltip={t('settings.alert_rules.form.interface_pattern_tooltip')}
          >
            <Input placeholder={t('settings.alert_rules.form.interface_pattern_placeholder')} />
          </Form.Item>
          <Form.Item label={t('settings.alert_rules.form.metric_label')} name="metric" rules={[{ required: true }]}>
            <Select options={METRIC_OPTIONS} />
          </Form.Item>
          <Form.Item label={t('settings.alert_rules.form.threshold_label')} name="threshold_value" rules={[{ required: true }]}>
            <InputNumber min={0} max={100} step={5} style={{ width: '100%' }} addonAfter="%" />
          </Form.Item>
          <Form.Item label={t('settings.alert_rules.form.consecutive_label')} name="consecutive_count" tooltip={t('settings.alert_rules.form.consecutive_tooltip')}>
            <InputNumber min={1} max={10} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label={t('settings.alert_rules.form.severity_label')} name="severity" rules={[{ required: true }]}>
            <Select options={SEVERITY_OPTIONS} />
          </Form.Item>
          <Form.Item label={t('settings.alert_rules.form.cooldown_label')} name="cooldown_minutes" tooltip={t('settings.alert_rules.form.cooldown_tooltip')}>
            <InputNumber min={1} max={1440} style={{ width: '100%' }} addonAfter={t('settings.unit.min_short')} />
          </Form.Item>
          <Form.Item label={t('settings.alert_rules.form.enabled_label')} name="enabled" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

// ── Notification Channels CRUD ──────────────────────────────────────────────

function NotificationChannelsTab() {
  const qc = useQueryClient()
  const { t } = useTranslation()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editing, setEditing] = useState<NotificationChannel | null>(null)
  const [channelType, setChannelType] = useState<ChannelType>('email')
  const [form] = Form.useForm()

  const { data, isLoading } = useQuery({
    queryKey: ['notification-channels'],
    queryFn: notificationsApi.list,
  })

  const saveMutation = useMutation({
    mutationFn: async (values: any) => {
      const payload = {
        name: values.name,
        type: values.type,
        config: values.config || {},
        notify_on: values.notify_on || [],
        is_active: values.is_active ?? true,
      }
      if (editing) return notificationsApi.update(editing.id, payload)
      return notificationsApi.create(payload)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notification-channels'] })
      setDrawerOpen(false)
      form.resetFields()
      message.success(editing ? t('settings.notifications.toast.updated') : t('settings.notifications.toast.created'))
    },
    onError: () => message.error(t('common.action_failed')),
  })

  const deleteMutation = useMutation({
    mutationFn: notificationsApi.delete,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notification-channels'] })
      message.success(t('settings.notifications.toast.deleted'))
    },
  })

  const testMutation = useMutation({
    mutationFn: notificationsApi.test,
    onSuccess: (res) => {
      if (res.success) message.success(t('settings.notifications.toast.test_sent'))
      else message.error(t('settings.notifications.toast.test_failed', { error: res.error || t('common.unknown_error') }))
    },
  })

  const digestMutation = useMutation({
    mutationFn: notificationsApi.sendWeeklyDigest,
    onSuccess: () => message.success(t('settings.notifications.toast.digest_queued')),
  })

  function openCreate() {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({ type: 'email', is_active: true })
    setChannelType('email')
    setDrawerOpen(true)
  }

  function openEdit(ch: NotificationChannel) {
    setEditing(ch)
    form.setFieldsValue({
      name: ch.name,
      type: ch.type,
      config: ch.config,
      notify_on: ch.notify_on,
      is_active: ch.is_active,
    })
    setChannelType(ch.type)
    setDrawerOpen(true)
  }

  // KURAL-E1: backend ChannelType enum sabit; renkler teknik (AntD).
  const TYPE_COLORS: Record<ChannelType, string> = { email: 'blue', slack: 'purple', telegram: 'cyan', teams: 'geekblue', webhook: 'volcano', jira: 'blue' }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Text style={{ fontSize: 13, opacity: 0.6 }}>
          {t('settings.notifications.intro')}
        </Text>
        <Space>
          <Popconfirm title={t('settings.notifications.popconfirm.send_digest_title')} onConfirm={() => digestMutation.mutate()}>
            <Button icon={<SendOutlined />} loading={digestMutation.isPending}>
              {t('settings.notifications.btn_send_digest')}
            </Button>
          </Popconfirm>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            {t('settings.notifications.btn_add')}
          </Button>
        </Space>
      </div>

      <Table
        dataSource={data?.items}
        loading={isLoading}
        rowKey="id"
        size="small"
        pagination={false}
        columns={[
          { title: t('settings.notifications.col.name'), dataIndex: 'name', render: (v: string, r: NotificationChannel) => (
            <div>
              <Text strong style={{ fontSize: 13 }}>{v}</Text>
              {!r.is_active && <Tag color="default" style={{ marginLeft: 6, fontSize: 10 }}>{t('settings.notifications.status_inactive')}</Tag>}
            </div>
          )},
          { title: t('settings.notifications.col.type'), dataIndex: 'type', width: 90, render: (v: ChannelType) => <Tag color={TYPE_COLORS[v]}>{v.toUpperCase()}</Tag> },
          { title: t('settings.notifications.col.triggers'), dataIndex: 'notify_on', render: (v: string[]) => (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {v.map((on) => {
                const opt = NOTIFY_ON_OPTIONS.find((o) => o.value === on)
                return <Tag key={on} style={{ fontSize: 11, margin: 0 }}>{opt?.label || on}</Tag>
              })}
            </div>
          )},
          { title: t('settings.notifications.col.status'), dataIndex: 'is_active', width: 80, render: (v: boolean) => (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: v ? '#22c55e' : '#475569', display: 'inline-block' }} />
              <Text style={{ fontSize: 12, color: v ? '#22c55e' : '#64748b' }}>{v ? t('settings.notifications.status_active') : t('settings.notifications.status_inactive')}</Text>
            </span>
          )},
          { title: t('settings.col.action'), width: 140, render: (_: any, r: NotificationChannel) => (
            <Space size={4}>
              <Tooltip title={t('settings.notifications.tooltip_test_send')}>
                <Button
                  size="small" icon={<ThunderboltOutlined />}
                  loading={testMutation.isPending && testMutation.variables === r.id}
                  onClick={() => testMutation.mutate(r.id)}
                />
              </Tooltip>
              <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} />
              <Popconfirm title={t('settings.notifications.popconfirm.delete_title')} onConfirm={() => deleteMutation.mutate(r.id)}>
                <Button size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            </Space>
          )},
        ]}
      />

      <Modal
        open={drawerOpen}
        onCancel={() => setDrawerOpen(false)}
        title={editing ? t('settings.notifications.modal.title_edit') : t('settings.notifications.modal.title_new')}
        width={560}
        onOk={() => form.submit()}
        okText={editing ? t('common.update') : t('common.create')}
        confirmLoading={saveMutation.isPending}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) => saveMutation.mutate(values)}
          style={{ marginTop: 16 }}
        >
          <Form.Item label={t('settings.notifications.form.name_label')} name="name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label={t('settings.notifications.form.type_label')} name="type" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'email', label: t('settings.notifications.channel.email') },
                { value: 'slack', label: 'Slack' },
                { value: 'teams', label: 'Microsoft Teams' },
                { value: 'telegram', label: 'Telegram' },
                { value: 'webhook', label: t('settings.notifications.channel.webhook') },
                { value: 'jira', label: t('settings.notifications.channel.jira') },
              ]}
              onChange={(v) => {
                setChannelType(v as ChannelType)
                form.setFieldValue('config', {})
              }}
            />
          </Form.Item>

          <ChannelTypeConfig type={channelType} />

          <Form.Item label={t('settings.notifications.col.triggers')} name="notify_on">
            <Select
              mode="multiple"
              options={NOTIFY_ON_OPTIONS}
              placeholder={t('settings.notifications.form.triggers_placeholder')}
            />
          </Form.Item>
          <Form.Item label={t('settings.notifications.form.active_label')} name="is_active" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

// ── Credential Profiles (Vault) ─────────────────────────────────────────────

function CredentialProfilesTab() {
  const qc = useQueryClient()
  const { t } = useTranslation()
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<CredentialProfile | null>(null)
  const [form] = Form.useForm()

  const { data: profiles = [], isLoading } = useQuery({
    queryKey: ['credential-profiles'],
    queryFn: credentialProfilesApi.list,
  })

  const saveMutation = useMutation({
    mutationFn: async (values: any) => {
      const payload: any = {
        name: values.name,
        description: values.description || null,
        ssh_username: values.ssh_username || null,
        ssh_port: values.ssh_port || 22,
        snmp_enabled: !!values.snmp_enabled,
        snmp_community: values.snmp_community || null,
        snmp_version: values.snmp_version || 'v2c',
        snmp_port: values.snmp_port || 161,
        snmp_v3_username: values.snmp_v3_username || null,
        snmp_v3_auth_protocol: values.snmp_v3_auth_protocol || null,
        snmp_v3_priv_protocol: values.snmp_v3_priv_protocol || null,
      }
      if (values.ssh_password) payload.ssh_password = values.ssh_password
      if (values.enable_secret !== undefined) payload.enable_secret = values.enable_secret
      if (values.snmp_v3_auth_passphrase) payload.snmp_v3_auth_passphrase = values.snmp_v3_auth_passphrase
      if (values.snmp_v3_priv_passphrase) payload.snmp_v3_priv_passphrase = values.snmp_v3_priv_passphrase

      if (editing) return credentialProfilesApi.update(editing.id, payload)
      return credentialProfilesApi.create(payload)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['credential-profiles'] })
      setModalOpen(false)
      form.resetFields()
      setEditing(null)
      message.success(editing ? t('settings.credentials.toast.updated') : t('settings.credentials.toast.created'))
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || t('common.error_occurred')),
  })

  const deleteMutation = useMutation({
    mutationFn: credentialProfilesApi.delete,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['credential-profiles'] })
      message.success(t('settings.credentials.toast.deleted'))
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || t('common.delete_failed')),
  })

  function openCreate() {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({ ssh_port: 22, snmp_version: 'v2c', snmp_port: 161, snmp_enabled: false })
    setModalOpen(true)
  }

  function openEdit(p: CredentialProfile) {
    setEditing(p)
    form.setFieldsValue({
      name: p.name,
      description: p.description,
      ssh_username: p.ssh_username,
      ssh_port: p.ssh_port,
      snmp_enabled: p.snmp_enabled,
      snmp_version: p.snmp_version,
      snmp_port: p.snmp_port,
      snmp_v3_username: p.snmp_v3_username,
      snmp_v3_auth_protocol: p.snmp_v3_auth_protocol,
      snmp_v3_priv_protocol: p.snmp_v3_priv_protocol,
      // passwords intentionally left blank — only fill if changing
    })
    setModalOpen(true)
  }

  function PasswordStatusIcon({ isSet }: { isSet: boolean }) {
    return isSet
      ? <CheckCircleOutlined style={{ color: '#52c41a', fontSize: 13 }} />
      : <CloseCircleOutlined style={{ color: '#d9d9d9', fontSize: 13 }} />
  }

  const columns = [
    {
      title: t('settings.credentials.col.profile_name'), dataIndex: 'name',
      render: (v: string, r: CredentialProfile) => (
        <Space>
          <LockOutlined style={{ opacity: 0.4 }} />
          <strong>{v}</strong>
          {r.description && <Text type="secondary" style={{ fontSize: 12 }}>{r.description}</Text>}
        </Space>
      ),
    },
    {
      title: 'SSH', render: (_: any, r: CredentialProfile) => (
        <Space size={4}>
          <Tag style={{ fontSize: 11 }}>{r.ssh_username || '—'}</Tag>
          <Text type="secondary" style={{ fontSize: 11 }}>:{r.ssh_port}</Text>
          <PasswordStatusIcon isSet={r.ssh_password_set} />
        </Space>
      ),
    },
    {
      title: 'Enable', dataIndex: 'enable_secret_set', width: 80,
      render: (v: boolean) => <PasswordStatusIcon isSet={v} />,
    },
    {
      title: 'SNMP', render: (_: any, r: CredentialProfile) => {
        if (!r.snmp_enabled) return <Tag color="default">{t('common.disabled')}</Tag>
        if (r.snmp_version === 'v3') return <Tag color="purple">v3 / {r.snmp_v3_username || '—'}</Tag>
        return <Tag color="blue">{r.snmp_version} / {r.snmp_community_set ? '••••••••' : '—'}</Tag>
      },
    },
    {
      title: t('settings.col.action'), width: 90,
      render: (_: any, r: CredentialProfile) => (
        <Space>
          <Tooltip title={t('common.edit')}>
            <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} />
          </Tooltip>
          <Popconfirm
            title={t('settings.credentials.popconfirm.delete_title')}
            description={t('settings.credentials.popconfirm.delete_desc')}
            onConfirm={() => deleteMutation.mutate(r.id)}
          >
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={t('settings.credentials.intro_message')}
        description={t('settings.credentials.intro_desc')}
      />
      <div style={{ marginBottom: 12 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          {t('settings.credentials.btn_new')}
        </Button>
      </div>
      <Table
        dataSource={profiles}
        rowKey="id"
        columns={columns}
        loading={isLoading}
        size="small"
        pagination={false}
        locale={{ emptyText: t('settings.credentials.empty') }}
      />

      <Modal
        title={editing ? t('settings.credentials.modal.title_edit') : t('settings.credentials.modal.title_new')}
        open={modalOpen}
        onCancel={() => { setModalOpen(false); setEditing(null) }}
        onOk={() => form.submit()}
        confirmLoading={saveMutation.isPending}
        width={560}
      >
        <Form form={form} layout="vertical" onFinish={(v) => saveMutation.mutate(v)}>
          <Form.Item label={t('settings.credentials.form.name_label')} name="name" rules={[{ required: true }]}>
            <Input placeholder={t('settings.credentials.form.name_placeholder')} />
          </Form.Item>
          <Form.Item label={t('settings.credentials.form.description_label')} name="description">
            <Input placeholder={t('settings.credentials.form.description_placeholder')} />
          </Form.Item>

          <Divider orientation="left" style={{ fontSize: 12, opacity: 0.6 }}>SSH</Divider>
          <Form.Item label={t('settings.credentials.form.ssh_username_label')} name="ssh_username">
            <Input placeholder="admin" />
          </Form.Item>
          <Form.Item
            label={editing ? t('settings.credentials.form.ssh_password_edit_label') : t('settings.credentials.form.ssh_password_label')}
            name="ssh_password"
          >
            <Input.Password placeholder={editing ? t('settings.credentials.form.password_edit_placeholder') : ''} />
          </Form.Item>
          <Form.Item label={t('settings.credentials.form.ssh_port_label')} name="ssh_port">
            <InputNumber min={1} max={65535} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            label={editing ? t('settings.credentials.form.enable_secret_edit_label') : t('settings.credentials.form.enable_secret_label')}
            name="enable_secret"
            tooltip={t('settings.credentials.form.enable_secret_tooltip')}
          >
            <Input.Password placeholder={editing ? t('settings.credentials.form.password_edit_placeholder') : ''} />
          </Form.Item>

          <Divider orientation="left" style={{ fontSize: 12, opacity: 0.6 }}>SNMP</Divider>
          <Form.Item name="snmp_enabled" valuePropName="checked" label={t('settings.credentials.form.snmp_enabled_label')}>
            <Switch />
          </Form.Item>
          <Form.Item
            noStyle
            shouldUpdate={(prev, cur) => prev.snmp_enabled !== cur.snmp_enabled}
          >
            {({ getFieldValue }) => getFieldValue('snmp_enabled') && (
              <>
                <Form.Item label={t('settings.credentials.form.snmp_version_label')} name="snmp_version">
                  <Select
                    options={[
                      { value: 'v1', label: 'v1' },
                      { value: 'v2c', label: 'v2c' },
                      { value: 'v3', label: 'v3 (USM)' },
                    ]}
                  />
                </Form.Item>
                <Form.Item label={t('settings.credentials.form.snmp_port_label')} name="snmp_port">
                  <InputNumber min={1} max={65535} style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item
                  noStyle
                  shouldUpdate={(prev, cur) => prev.snmp_version !== cur.snmp_version}
                >
                  {({ getFieldValue: gfv }) => gfv('snmp_version') !== 'v3'
                    ? (
                      <Form.Item label="Community String" name="snmp_community">
                        <Input placeholder="public" />
                      </Form.Item>
                    )
                    : (
                      <>
                        <Form.Item label={t('settings.credentials.form.v3_username_label')} name="snmp_v3_username">
                          <Input />
                        </Form.Item>
                        <Form.Item label={t('settings.credentials.form.v3_auth_proto_label')} name="snmp_v3_auth_protocol">
                          <Select allowClear placeholder={t('settings.credentials.form.empty_select')} options={[
                            { value: 'md5', label: 'MD5' },
                            { value: 'sha1', label: 'SHA-1' },
                          ]} />
                        </Form.Item>
                        <Form.Item label={t('settings.credentials.form.v3_auth_pass_label')} name="snmp_v3_auth_passphrase">
                          <Input.Password />
                        </Form.Item>
                        <Form.Item label={t('settings.credentials.form.v3_priv_proto_label')} name="snmp_v3_priv_protocol">
                          <Select allowClear placeholder={t('settings.credentials.form.empty_select')} options={[
                            { value: 'des', label: 'DES' },
                            { value: 'aes128', label: 'AES-128' },
                          ]} />
                        </Form.Item>
                        <Form.Item label={t('settings.credentials.form.v3_priv_pass_label')} name="snmp_v3_priv_passphrase">
                          <Input.Password />
                        </Form.Item>
                      </>
                    )
                  }
                </Form.Item>
              </>
            )}
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

// ── Secret Rotation ─────────────────────────────────────────────────────────

// KURAL-E1: STATUS_CONFIG'in teknik kısmı (color/hex/icon) module-level kalır;
// label hook scope'unda t() ile çözülür (SecretRotationTab içinde STATUS_LABEL).
const STATUS_CONFIG: Record<string, { color: string; hex: string; icon: React.ReactNode }> = {
  idle:    { color: 'default',    hex: '#64748b', icon: <ClockCircleOutlined /> },
  running: { color: 'processing', hex: '#3b82f6', icon: <SyncOutlined spin /> },
  success: { color: 'success',    hex: '#22c55e', icon: <CheckCircleOutlined /> },
  failed:  { color: 'error',      hex: '#ef4444', icon: <CloseCircleOutlined /> },
}

// ── SLA Policies Tab ───────────────────────────────────────────────────────

function SlaPoliciesTab() {
  const qc = useQueryClient()
  const { t } = useTranslation()
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<SlaPolicy | null>(null)
  const [form] = Form.useForm()

  const { data: policies = [], isLoading } = useQuery({
    queryKey: ['sla-policies'],
    queryFn: slaApi.listPolicies,
  })

  const { data: devices = [] } = useQuery({
    queryKey: ['devices-simple'],
    queryFn: () => devicesApi.list({ limit: 500 }).then((r) => r.items),
  })

  const saveMutation = useMutation({
    mutationFn: (values: SlaPolicyCreate) =>
      editing ? slaApi.updatePolicy(editing.id, values) : slaApi.createPolicy(values),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sla-policies'] })
      setModalOpen(false)
      form.resetFields()
      setEditing(null)
      message.success(editing ? t('settings.sla.toast.updated') : t('settings.sla.toast.created'))
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || t('common.error_occurred')),
  })

  const deleteMutation = useMutation({
    mutationFn: slaApi.deletePolicy,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sla-policies'] })
      message.success(t('settings.sla.toast.deleted'))
    },
  })

  function openCreate() {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({
      target_uptime_pct: 99.0,
      measurement_window_days: 30,
      notify_on_breach: true,
      device_ids: [],
      group_ids: [],
    })
    setModalOpen(true)
  }

  function openEdit(p: SlaPolicy) {
    setEditing(p)
    form.setFieldsValue({
      name: p.name,
      target_uptime_pct: p.target_uptime_pct,
      measurement_window_days: p.measurement_window_days,
      device_ids: p.device_ids,
      group_ids: p.group_ids,
      notify_on_breach: p.notify_on_breach,
    })
    setModalOpen(true)
  }

  const columns = [
    {
      title: t('settings.sla.col.policy_name'), dataIndex: 'name',
      render: (v: string) => <strong>{v}</strong>,
    },
    {
      title: t('settings.sla.col.target_uptime'),
      dataIndex: 'target_uptime_pct',
      render: (v: number) => (
        <Tag color={v >= 99.9 ? 'red' : v >= 99 ? 'orange' : 'blue'}>%{v}</Tag>
      ),
    },
    {
      title: t('settings.sla.col.measurement_window'),
      dataIndex: 'measurement_window_days',
      render: (v: number) => t('settings.sla.days_value', { count: v }),
    },
    {
      title: t('settings.sla.col.scope'),
      render: (_: unknown, r: SlaPolicy) => {
        if (!r.device_ids?.length && !r.group_ids?.length) return <Tag>{t('settings.alert_rules.all_devices')}</Tag>
        return (
          <Space>
            {r.device_ids?.length > 0 && <Tag color="blue">{t('settings.sla.scope.devices', { count: r.device_ids.length })}</Tag>}
            {r.group_ids?.length > 0 && <Tag color="green">{t('settings.sla.scope.groups', { count: r.group_ids.length })}</Tag>}
          </Space>
        )
      },
    },
    {
      title: t('settings.sla.col.notification'),
      dataIndex: 'notify_on_breach',
      render: (v: boolean) => v
        ? <Tag icon={<BellOutlined />} color="orange">{t('settings.notifications.status_active')}</Tag>
        : <Tag>{t('settings.notifications.status_inactive')}</Tag>,
    },
    {
      title: '',
      render: (_: unknown, r: SlaPolicy) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} />
          <Popconfirm title={t('settings.sla.popconfirm.delete_title')} onConfirm={() => deleteMutation.mutate(r.id)}>
            <Button size="small" icon={<DeleteOutlined />} danger />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Text type="secondary" style={{ fontSize: 13 }}>
          {t('settings.sla.intro')}
        </Text>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>{t('settings.sla.btn_new')}</Button>
      </div>

      <Table
        dataSource={policies}
        columns={columns}
        rowKey="id"
        loading={isLoading}
        size="small"
        pagination={false}
      />

      <Modal
        title={editing ? t('settings.sla.modal.title_edit') : t('settings.sla.modal.title_new')}
        open={modalOpen}
        onCancel={() => { setModalOpen(false); setEditing(null) }}
        onOk={() => form.submit()}
        confirmLoading={saveMutation.isPending}
        width={500}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) => saveMutation.mutate(values as SlaPolicyCreate)}
        >
          <Form.Item label={t('settings.sla.form.name_label')} name="name" rules={[{ required: true }]}>
            <Input placeholder={t('settings.sla.form.name_placeholder')} />
          </Form.Item>
          <Form.Item label={t('settings.sla.form.target_uptime_label')} name="target_uptime_pct" rules={[{ required: true }]}>
            <InputNumber min={0} max={100} step={0.1} precision={2} style={{ width: '100%' }}
              addonAfter="%" />
          </Form.Item>
          <Form.Item label={t('settings.sla.form.measurement_window_label')} name="measurement_window_days" rules={[{ required: true }]}>
            <Select>
              {[7, 14, 30, 60, 90].map((d) => (
                <Select.Option key={d} value={d}>{t('settings.sla.days_value', { count: d })}</Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item
            label={t('settings.sla.form.scope_devices_label')}
            name="device_ids"
            extra={t('settings.sla.form.scope_devices_extra')}
          >
            <Select
              mode="multiple"
              showSearch
              optionFilterProp="label"
              placeholder={t('settings.sla.form.scope_devices_placeholder')}
              options={devices.map((d: any) => ({ value: d.id, label: d.hostname }))}
            />
          </Form.Item>
          <Form.Item label={t('settings.sla.form.notify_on_breach_label')} name="notify_on_breach" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

// ── SNMP Configuration Tab ──────────────────────────────────────────────────

function SnmpConfigTab() {
  const qc = useQueryClient()
  const { t } = useTranslation()
  const [form] = Form.useForm()
  const [confirmAll, setConfirmAll] = useState(false)
  const [sshResult, setSshResult] = useState<BulkSshResult | null>(null)

  const { data: status, isLoading: statusLoading } = useQuery({
    queryKey: ['snmp-status'],
    queryFn: snmpApi.getStatus,
    refetchInterval: 15_000,
  })

  const pollMutation = useMutation({
    mutationFn: snmpApi.triggerPoll,
    onSuccess: () => {
      message.success(t('settings.snmp.toast.poll_queued'))
      setTimeout(() => qc.invalidateQueries({ queryKey: ['snmp-status'] }), 31_000)
    },
    onError: () => message.error(t('settings.snmp.toast.poll_failed')),
  })

  const sshMutation = useMutation({
    mutationFn: snmpApi.bulkSshConfigure,
    onSuccess: (data) => {
      setSshResult(data)
      qc.invalidateQueries({ queryKey: ['snmp-status'] })
      form.resetFields()
      setConfirmAll(false)
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || t('settings.snmp.toast.ssh_config_failed')),
  })

  const onApply = (values: any) => {
    if (!values.community) return message.error(t('settings.snmp.toast.community_required'))
    sshMutation.mutate({
      community: values.community,
      version: values.version || 'v2c',
      port: values.port || 161,
    })
  }

  const sshResultColumns = [
    {
      title: t('settings.snmp.col.device'),
      dataIndex: 'hostname',
      key: 'hostname',
      render: (hostname: string, row: BulkSshDeviceResult) => (
        <span>
          <Text strong>{hostname}</Text>
          <br />
          <Text type="secondary" style={{ fontSize: 11 }}>{row.ip}</Text>
        </span>
      ),
    },
    {
      title: t('common.status'),
      dataIndex: 'success',
      key: 'success',
      width: 90,
      render: (ok: boolean) =>
        ok
          ? <Tag color="success">{t('common.success')}</Tag>
          : <Tag color="error">{t('common.error')}</Tag>,
    },
    {
      title: t('common.error'),
      dataIndex: 'error',
      key: 'error',
      render: (err?: string) => err ? <Text type="danger" style={{ fontSize: 12 }}>{err}</Text> : null,
    },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Status cards */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {[
          { label: t('settings.snmp.stat.total_devices'), value: status?.total_devices ?? '—', color: '#3b82f6' },
          { label: t('settings.snmp.stat.snmp_enabled'), value: status?.snmp_enabled ?? '—', color: (status?.snmp_enabled ?? 0) > 0 ? '#22c55e' : '#64748b' },
          { label: t('settings.snmp.stat.poll_records'), value: status?.poll_results ?? '—', color: '#8b5cf6' },
          { label: t('settings.snmp.stat.last_poll'), value: status?.last_poll_at ? dayjs(status.last_poll_at).fromNow() : t('settings.snmp.stat.not_yet'), color: '#06b6d4' },
        ].map((s) => (
          <div key={s.label} style={{
            flex: 1, minWidth: 130,
            border: `1px solid ${s.color}33`,
            borderTop: `2px solid ${s.color}88`,
            borderRadius: 8, padding: '10px 14px',
          }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: s.color, lineHeight: 1 }}>{statusLoading ? '…' : s.value}</div>
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>{s.label}</div>
          </div>
        ))}
      </div>

      <Divider orientation="left" plain style={{ fontSize: 13 }}>{t('settings.snmp.bulk_section_title')}</Divider>

      <Alert
        type="warning"
        showIcon
        message={t('settings.snmp.alert_ruijie_title')}
        description={t('settings.snmp.alert_ruijie_desc')}
        style={{ marginBottom: 8 }}
      />

      <Alert
        type="info"
        showIcon
        message={t('settings.snmp.alert_ssh_title')}
        description={t('settings.snmp.alert_ssh_desc')}
        style={{ marginBottom: 8 }}
      />

      <Form form={form} layout="vertical" onFinish={onApply} style={{ maxWidth: 480 }}>
        <Form.Item
          label={t('settings.snmp.form.community_label')}
          name="community"
          rules={[{ required: true, message: t('common.required_field') }]}
          extra={t('settings.snmp.form.community_extra')}
        >
          <Input placeholder="Charon1" />
        </Form.Item>
        <Form.Item label={t('settings.snmp.form.version_label')} name="version" initialValue="v2c">
          <Select options={[
            { value: 'v1', label: 'SNMPv1' },
            { value: 'v2c', label: t('settings.snmp.form.version_v2c_recommended') },
          ]} style={{ width: 220 }} />
        </Form.Item>
        <Form.Item label="Port" name="port" initialValue={161}>
          <InputNumber min={1} max={65535} style={{ width: 120 }} />
        </Form.Item>
        <Form.Item>
          {!confirmAll ? (
            <Button type="primary" icon={<SendOutlined />} onClick={() => setConfirmAll(true)}>
              {t('settings.snmp.btn_apply_to_all')}
            </Button>
          ) : (
            <Space>
              <Text type="warning">{t('settings.snmp.confirm_apply_all', { count: status?.total_devices ?? 0 })}</Text>
              <Button
                danger
                loading={sshMutation.isPending}
                onClick={() => form.submit()}
              >
                {sshMutation.isPending ? t('settings.snmp.btn_configuring') : t('settings.snmp.btn_yes_apply')}
              </Button>
              <Button onClick={() => setConfirmAll(false)} disabled={sshMutation.isPending}>{t('common.cancel')}</Button>
            </Space>
          )}
        </Form.Item>
      </Form>

      <Divider orientation="left" plain style={{ fontSize: 13 }}>{t('settings.snmp.manual_poll_section')}</Divider>

      <Space>
        <Button
          type="default"
          icon={<ThunderboltOutlined />}
          loading={pollMutation.isPending}
          onClick={() => pollMutation.mutate()}
        >
          {t('settings.snmp.btn_poll_now')}
        </Button>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('settings.snmp.manual_poll_hint')}
        </Text>
      </Space>

      {/* SSH Results Modal */}
      <Modal
        open={sshResult !== null}
        title={
          sshResult
            ? t('settings.snmp.result_modal_title', { succeeded: sshResult.succeeded, attempted: sshResult.attempted })
            : ''
        }
        onCancel={() => setSshResult(null)}
        footer={
          <Button type="primary" onClick={() => setSshResult(null)}>{t('common.close')}</Button>
        }
        width={700}
      >
        {sshResult && (
          <>
            <Space style={{ marginBottom: 16 }}>
              <Tag color="success">{t('settings.snmp.result_succeeded', { count: sshResult.succeeded })}</Tag>
              {sshResult.failed > 0 && <Tag color="error">{t('settings.snmp.result_failed', { count: sshResult.failed })}</Tag>}
            </Space>
            {sshResult.failed > 0 && (
              <Alert
                type="warning"
                showIcon
                message={t('settings.snmp.result_failed_hint')}
                style={{ marginBottom: 12 }}
              />
            )}
            <Table
              dataSource={sshResult.results}
              columns={sshResultColumns}
              rowKey="device_id"
              size="small"
              pagination={{ pageSize: 20 }}
              scroll={{ y: 400 }}
            />
          </>
        )}
      </Modal>
    </div>
  )
}

function SecretRotationTab() {
  const qc = useQueryClient()
  const { t } = useTranslation()
  const [policyModal, setPolicyModal] = useState<{ open: boolean; profileId?: number; policy?: RotationPolicy | null }>({ open: false })
  const [resultModal, setResultModal] = useState<RotationPolicy | null>(null)
  const [policyForm] = Form.useForm()

  // KURAL-E1: status label hook scope'unda useMemo + t().
  const STATUS_LABEL = React.useMemo<Record<string, string>>(() => ({
    idle:    t('settings.rotation.status.idle'),
    running: t('settings.rotation.status.running'),
    success: t('settings.rotation.status.success'),
    failed:  t('settings.rotation.status.failed'),
  }), [t])

  const { data: profiles = [] } = useQuery({ queryKey: ['credential-profiles'], queryFn: credentialProfilesApi.list })
  const { data: policies = [], isLoading } = useQuery({
    queryKey: ['rotation-policies'],
    queryFn: credentialProfilesApi.listRotationPolicies,
    refetchInterval: 10_000,
  })

  const saveMutation = useMutation({
    mutationFn: async (values: { interval_days: number; is_active: boolean }) => {
      const { profileId, policy } = policyModal
      if (!profileId) return
      if (policy) return credentialProfilesApi.updateRotationPolicy(profileId, values)
      return credentialProfilesApi.createRotationPolicy(profileId, values)
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['rotation-policies'] }); setPolicyModal({ open: false }) },
  })

  const deleteMutation = useMutation({
    mutationFn: (profileId: number) => credentialProfilesApi.deleteRotationPolicy(profileId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rotation-policies'] }),
  })

  const rotateMutation = useMutation({
    mutationFn: (profileId: number) => credentialProfilesApi.rotateNow(profileId),
    onSuccess: () => {
      message.success(t('settings.rotation.toast.started'))
      setTimeout(() => qc.invalidateQueries({ queryKey: ['rotation-policies'] }), 2000)
    },
  })

  // Profiles without a policy
  const policiedIds = new Set(policies.map((p) => p.credential_profile_id))
  const unassigned = profiles.filter((p) => !policiedIds.has(p.id))

  const openCreate = (profileId: number) => {
    policyForm.setFieldsValue({ interval_days: 90, is_active: true })
    setPolicyModal({ open: true, profileId, policy: null })
  }

  const openEdit = (policy: RotationPolicy) => {
    policyForm.setFieldsValue({ interval_days: policy.interval_days, is_active: policy.is_active })
    setPolicyModal({ open: true, profileId: policy.credential_profile_id, policy })
  }

  const columns = [
    {
      title: t('settings.rotation.col.profile'), dataIndex: 'profile_name', key: 'profile_name',
      render: (name: string) => <Text strong>{name}</Text>,
    },
    {
      title: t('settings.rotation.col.interval'), dataIndex: 'interval_days', key: 'interval_days',
      render: (d: number) => t('settings.sla.days_value', { count: d }),
    },
    {
      title: t('common.status'), dataIndex: 'status', key: 'status',
      render: (s: string, row: RotationPolicy) => (
        <Space size={4}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: STATUS_CONFIG[s]?.hex ?? '#64748b', display: 'inline-block' }} />
          <Text>{STATUS_LABEL[s] ?? s}</Text>
          {!row.is_active && <Tag>{t('settings.notifications.status_inactive')}</Tag>}
        </Space>
      ),
    },
    {
      title: t('settings.rotation.col.last_rotation'), dataIndex: 'last_rotated_at', key: 'last_rotated_at',
      render: (v: string | null) => v ? dayjs(v).format('DD.MM.YYYY HH:mm') : <Text type="secondary">—</Text>,
    },
    {
      title: t('settings.rotation.col.next_rotation'), dataIndex: 'next_rotate_at', key: 'next_rotate_at',
      render: (v: string | null) => {
        if (!v) return <Text type="secondary">—</Text>
        const diff = dayjs(v).diff(dayjs(), 'day')
        const color = diff <= 7 ? 'red' : diff <= 30 ? 'orange' : undefined
        return <Text style={{ color }}>{dayjs(v).format('DD.MM.YYYY')}</Text>
      },
    },
    {
      title: t('settings.col.actions'), key: 'actions',
      render: (_: unknown, row: RotationPolicy) => (
        <Space>
          {row.last_result && (
            <Tooltip title={t('settings.rotation.tooltip.last_result')}>
              <Button size="small" icon={<CheckCircleOutlined />} onClick={() => setResultModal(row)} />
            </Tooltip>
          )}
          <Tooltip title={t('settings.rotation.tooltip.rotate_now')}>
            <Button
              size="small" icon={<PlayCircleOutlined />} type="primary"
              loading={rotateMutation.isPending}
              disabled={row.status === 'running'}
              onClick={() => rotateMutation.mutate(row.credential_profile_id)}
            />
          </Tooltip>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)} />
          <Popconfirm title={t('settings.rotation.popconfirm.delete_title')} onConfirm={() => deleteMutation.mutate(row.credential_profile_id)}>
            <Button size="small" icon={<DeleteOutlined />} danger />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <Alert
        showIcon type="warning"
        message={t('settings.rotation.intro_message')}
        description={t('settings.rotation.intro_desc')}
        style={{ marginBottom: 16 }}
      />

      {unassigned.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <Text type="secondary">{t('settings.rotation.unassigned_label')}</Text>
          <Space wrap>
            {unassigned.map((p) => (
              <Button key={p.id} size="small" icon={<PlusOutlined />} onClick={() => openCreate(p.id)}>
                {p.name}
              </Button>
            ))}
          </Space>
        </div>
      )}

      <Table
        dataSource={policies}
        rowKey="id"
        loading={isLoading}
        size="small"
        columns={columns}
        pagination={false}
        locale={{ emptyText: t('settings.rotation.empty') }}
      />

      {/* Create/Edit Policy Modal */}
      <Modal
        title={policyModal.policy ? t('settings.rotation.modal.title_edit') : t('settings.rotation.modal.title_new')}
        open={policyModal.open}
        onCancel={() => setPolicyModal({ open: false })}
        onOk={() => policyForm.submit()}
        confirmLoading={saveMutation.isPending}
      >
        {policyModal.profileId && (
          <Alert
            type="info" showIcon style={{ marginBottom: 16 }}
            message={t('settings.rotation.modal.profile_label', { name: profiles.find((p) => p.id === policyModal.profileId)?.name ?? '' })}
          />
        )}
        <Form form={policyForm} layout="vertical" onFinish={(v) => saveMutation.mutate(v)}>
          <Form.Item name="interval_days" label={t('settings.rotation.form.interval_label')} rules={[{ required: true }]}>
            <InputNumber min={1} max={365} style={{ width: '100%' }} addonAfter={t('settings.unit.day')} />
          </Form.Item>
          <Form.Item name="is_active" label={t('settings.notifications.form.active_label')} valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      {/* Last Result Modal */}
      <Modal
        title={t('settings.rotation.modal.last_result_title')}
        open={!!resultModal}
        onCancel={() => setResultModal(null)}
        footer={<Button onClick={() => setResultModal(null)}>{t('common.close')}</Button>}
        width={560}
      >
        {resultModal?.last_result && (
          <div>
            {resultModal.last_result.rotated_at && (
              <Text type="secondary">
                {t('settings.rotation.modal.executed_at', { date: dayjs(resultModal.last_result.rotated_at).format('DD.MM.YYYY HH:mm') })}
              </Text>
            )}
            {resultModal.last_result.message && (
              <Alert type="info" message={resultModal.last_result.message} style={{ marginTop: 8 }} />
            )}
            {(resultModal.last_result.device_results || []).map((r) => (
              <div key={r.device_id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                {r.success
                  ? <CheckCircleOutlined style={{ color: '#52c41a' }} />
                  : <CloseCircleOutlined style={{ color: '#f5222d' }} />}
                <Text strong>{r.hostname}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>{r.message}</Text>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  )
}

// ── Maintenance Windows CRUD ────────────────────────────────────────────────

function MaintenanceWindowsTab() {
  const qc = useQueryClient()
  const { t } = useTranslation()
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<MaintenanceWindow | null>(null)
  const [form] = Form.useForm()

  // KURAL-E1: gün adları hook scope'unda useMemo.
  const DAY_LABELS_SHORT = React.useMemo<string[]>(() => [
    t('settings.maintenance.day.mon_short'),
    t('settings.maintenance.day.tue_short'),
    t('settings.maintenance.day.wed_short'),
    t('settings.maintenance.day.thu_short'),
    t('settings.maintenance.day.fri_short'),
    t('settings.maintenance.day.sat_short'),
    t('settings.maintenance.day.sun_short'),
  ], [t])
  const DAY_LABELS_LONG = React.useMemo<string[]>(() => [
    t('settings.maintenance.day.mon'),
    t('settings.maintenance.day.tue'),
    t('settings.maintenance.day.wed'),
    t('settings.maintenance.day.thu'),
    t('settings.maintenance.day.fri'),
    t('settings.maintenance.day.sat'),
    t('settings.maintenance.day.sun'),
  ], [t])

  const { data: windows = [], isLoading } = useQuery({
    queryKey: ['maintenance-windows'],
    queryFn: () => maintenanceWindowsApi.list(false),
  })

  const { data: devices = [] } = useQuery({
    queryKey: ['devices-simple'],
    queryFn: () => devicesApi.list({ limit: 500 }).then((r) => r.items),
  })

  const saveMutation = useMutation({
    mutationFn: async (values: any) => {
      const [start, end] = values.time_range
      const recurrence = (values.recurrence ?? null) as ('daily' | 'weekly' | 'monthly' | null)
      const payload: any = {
        name: values.name,
        description: values.description || null,
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        applies_to_all: !!values.applies_to_all,
        device_ids: values.applies_to_all ? [] : (values.device_ids || []),
        recurrence,
        recur_days_of_week: recurrence === 'weekly' ? (values.recur_days_of_week || []) : null,
        recur_day_of_month: recurrence === 'monthly' ? (values.recur_day_of_month ?? null) : null,
        recur_count_max: recurrence ? (values.recur_count_max ?? null) : null,
        recur_until: recurrence && values.recur_until ? values.recur_until.toISOString() : null,
      }
      if (editing) return maintenanceWindowsApi.update(editing.id, payload)
      return maintenanceWindowsApi.create(payload)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['maintenance-windows'] })
      setModalOpen(false)
      form.resetFields()
      setEditing(null)
      message.success(editing ? t('settings.maintenance.toast.updated') : t('settings.maintenance.toast.created'))
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || t('common.error_occurred')),
  })

  const deleteMutation = useMutation({
    mutationFn: maintenanceWindowsApi.delete,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['maintenance-windows'] })
      message.success(t('settings.maintenance.toast.deleted'))
    },
  })

  function openCreate() {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({ applies_to_all: false })
    setModalOpen(true)
  }

  function openEdit(w: MaintenanceWindow) {
    setEditing(w)
    form.setFieldsValue({
      name: w.name,
      description: w.description,
      time_range: [dayjs(w.start_time), dayjs(w.end_time)],
      applies_to_all: w.applies_to_all,
      device_ids: w.device_ids,
      recurrence: w.recurrence,
      recur_days_of_week: w.recur_days_of_week,
      recur_day_of_month: w.recur_day_of_month,
      recur_count_max: w.recur_count_max,
      recur_until: w.recur_until ? dayjs(w.recur_until) : null,
    })
    setModalOpen(true)
  }

  function recurrenceLabel(w: MaintenanceWindow): string {
    if (!w.recurrence) return ''
    if (w.recurrence === 'daily') return t('settings.maintenance.recurrence.daily')
    if (w.recurrence === 'weekly') {
      const days = (w.recur_days_of_week || []).map((d) => DAY_LABELS_SHORT[d]).join('/')
      return t('settings.maintenance.recurrence.weekly_value', { days })
    }
    if (w.recurrence === 'monthly') return t('settings.maintenance.recurrence.monthly_value', { day: w.recur_day_of_month })
    return w.recurrence
  }

  const columns = [
    {
      title: t('settings.maintenance.col.name'), dataIndex: 'name',
      render: (v: string, r: MaintenanceWindow) => (
        <Space>
          {r.is_active
            ? <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#f97316', display: 'inline-block' }} />
            : <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#475569', display: 'inline-block' }} />}
          <strong>{v}</strong>
          {r.is_recurrence_template && (
            <Tag color="purple" style={{ fontSize: 10 }}>
              {t('settings.maintenance.recurrence.template_label', { label: recurrenceLabel(r), count: r.recur_instances_spawned })}
            </Tag>
          )}
          {r.description && <Text type="secondary" style={{ fontSize: 12 }}>{r.description}</Text>}
        </Space>
      ),
    },
    {
      title: t('settings.maintenance.col.start'), dataIndex: 'start_time',
      render: (v: string) => dayjs(v).format('DD.MM.YYYY HH:mm'),
      width: 160,
    },
    {
      title: t('settings.maintenance.col.end'), dataIndex: 'end_time',
      render: (v: string) => dayjs(v).format('DD.MM.YYYY HH:mm'),
      width: 160,
    },
    {
      title: t('settings.maintenance.col.scope'), render: (_: any, r: MaintenanceWindow) => r.applies_to_all
        ? <Tag color="red">{t('settings.alert_rules.all_devices')}</Tag>
        : (
          <Space size={4} wrap>
            {(r.device_ids || []).map((id) => {
              const d = devices.find((x) => x.id === id)
              return <Tag key={id} style={{ fontSize: 11 }}>{d?.hostname || `#${id}`}</Tag>
            })}
            {(!r.device_ids || r.device_ids.length === 0) && <Tag color="default">—</Tag>}
          </Space>
        ),
    },
    {
      title: t('common.status'), dataIndex: 'is_active', width: 100,
      render: (v: boolean) => v
        ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 7, height: 7, borderRadius: '50%', background: '#f97316', display: 'inline-block' }} /><Text style={{ fontSize: 12, color: '#f97316' }}>{t('settings.notifications.status_active')}</Text></span>
        : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 7, height: 7, borderRadius: '50%', background: '#475569', display: 'inline-block' }} /><Text style={{ fontSize: 12, color: '#64748b' }}>{t('settings.notifications.status_inactive')}</Text></span>,
    },
    {
      title: t('settings.col.action'), width: 90,
      render: (_: any, r: MaintenanceWindow) => (
        <Space>
          <Tooltip title={t('common.edit')}>
            <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} />
          </Tooltip>
          <Popconfirm title={t('settings.maintenance.popconfirm.delete_title')} onConfirm={() => deleteMutation.mutate(r.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const activeCount = windows.filter((w) => w.is_active).length

  return (
    <div>
      <Alert
        type={activeCount > 0 ? 'warning' : 'info'}
        showIcon
        style={{ marginBottom: 16 }}
        message={
          activeCount > 0
            ? t('settings.maintenance.alert_active', { count: activeCount })
            : t('settings.maintenance.alert_idle')
        }
        description={t('settings.maintenance.alert_desc')}
      />
      <div style={{ marginBottom: 12 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          {t('settings.maintenance.btn_new')}
        </Button>
      </div>
      <Table
        dataSource={windows}
        rowKey="id"
        columns={columns}
        loading={isLoading}
        size="small"
        pagination={false}
        locale={{ emptyText: t('settings.maintenance.empty') }}
      />

      <Modal
        title={editing ? t('settings.maintenance.modal.title_edit') : t('settings.maintenance.modal.title_new')}
        open={modalOpen}
        onCancel={() => { setModalOpen(false); setEditing(null) }}
        onOk={() => form.submit()}
        confirmLoading={saveMutation.isPending}
        width={520}
      >
        <Form form={form} layout="vertical" onFinish={(v) => saveMutation.mutate(v)}>
          <Form.Item label={t('settings.maintenance.form.name_label')} name="name" rules={[{ required: true }]}>
            <Input placeholder={t('settings.maintenance.form.name_placeholder')} />
          </Form.Item>
          <Form.Item label={t('settings.maintenance.form.description_label')} name="description">
            <Input placeholder={t('settings.credentials.form.description_placeholder')} />
          </Form.Item>
          <Form.Item label={t('settings.maintenance.form.time_range_label')} name="time_range" rules={[{ required: true }]}>
            <DatePicker.RangePicker
              showTime={{ format: 'HH:mm' }}
              format="DD.MM.YYYY HH:mm"
              style={{ width: '100%' }}
            />
          </Form.Item>
          <Form.Item name="applies_to_all" valuePropName="checked" label={t('settings.maintenance.col.scope')}>
            <Switch checkedChildren={t('settings.alert_rules.all_devices')} unCheckedChildren={t('settings.maintenance.scope.selected_devices')} />
          </Form.Item>
          <Form.Item
            noStyle
            shouldUpdate={(prev, cur) => prev.applies_to_all !== cur.applies_to_all}
          >
            {({ getFieldValue }) => !getFieldValue('applies_to_all') && (
              <Form.Item label={t('settings.maintenance.form.devices_label')} name="device_ids" tooltip={t('settings.maintenance.form.devices_tooltip')}>
                <Select
                  mode="multiple"
                  placeholder={t('settings.maintenance.form.devices_placeholder')}
                  showSearch
                  filterOption={(input, opt) =>
                    (opt?.label as string ?? '').toLowerCase().includes(input.toLowerCase())
                  }
                  options={devices.map((d) => ({ label: `${d.hostname} (${d.ip_address})`, value: d.id }))}
                />
              </Form.Item>
            )}
          </Form.Item>

          {/* T9 Tur 6A — Cyclic recurrence (only editable on templates) */}
          {(!editing || !editing.parent_window_id) && (
            <>
              <Divider orientation="left" plain style={{ fontSize: 12, marginTop: 8, marginBottom: 8 }}>
                {t('settings.maintenance.recurrence.section_title')}
              </Divider>
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 10, fontSize: 12 }}
                message={t('settings.maintenance.recurrence.info_message')}
                description={t('settings.maintenance.recurrence.info_desc')}
              />
              <Form.Item label={t('settings.maintenance.recurrence.label')} name="recurrence">
                <Select
                  allowClear
                  placeholder={t('settings.maintenance.recurrence.placeholder_once')}
                  options={[
                    { value: 'daily', label: t('settings.maintenance.recurrence.daily') },
                    { value: 'weekly', label: t('settings.maintenance.recurrence.weekly') },
                    { value: 'monthly', label: t('settings.maintenance.recurrence.monthly') },
                  ]}
                />
              </Form.Item>
              <Form.Item
                noStyle
                shouldUpdate={(prev, cur) => prev.recurrence !== cur.recurrence}
              >
                {({ getFieldValue }) => {
                  const rec = getFieldValue('recurrence')
                  return (
                    <>
                      {rec === 'weekly' && (
                        <Form.Item
                          label={t('settings.maintenance.recurrence.which_days_label')}
                          name="recur_days_of_week"
                          rules={[{ required: true, message: t('settings.maintenance.recurrence.which_days_required') }]}
                        >
                          <Checkbox.Group>
                            <Space wrap>
                              {DAY_LABELS_LONG.map((label, i) => (
                                <Checkbox key={i} value={i}>{label}</Checkbox>
                              ))}
                            </Space>
                          </Checkbox.Group>
                        </Form.Item>
                      )}
                      {rec === 'monthly' && (
                        <Form.Item
                          label={t('settings.maintenance.recurrence.day_of_month_label')}
                          name="recur_day_of_month"
                          rules={[{ required: true, type: 'number', min: 1, max: 28 }]}
                        >
                          <InputNumber min={1} max={28} style={{ width: 120 }} />
                        </Form.Item>
                      )}
                      {rec && (
                        <Row gutter={12}>
                          <Col span={12}>
                            <Form.Item label={t('settings.maintenance.recurrence.end_date_label')} name="recur_until">
                              <DatePicker style={{ width: '100%' }} format="DD.MM.YYYY" />
                            </Form.Item>
                          </Col>
                          <Col span={12}>
                            <Form.Item label={t('settings.maintenance.recurrence.max_count_label')} name="recur_count_max">
                              <InputNumber min={1} max={1000} style={{ width: '100%' }} placeholder={t('settings.maintenance.recurrence.unlimited')} />
                            </Form.Item>
                          </Col>
                        </Row>
                      )}
                    </>
                  )
                }}
              </Form.Item>
            </>
          )}
        </Form>
      </Modal>
    </div>
  )
}

// ── API Tokens Tab ──────────────────────────────────────────────────────────

function ApiTokensTab() {
  const qc = useQueryClient()
  const { t } = useTranslation()
  const { isDark } = useTheme()
  const [createOpen, setCreateOpen] = useState(false)
  const [createdToken, setCreatedToken] = useState<string | null>(null)
  const [form] = Form.useForm()
  const [msgApi, msgCtx] = message.useMessage()

  const { data: tokens, isLoading } = useQuery<ApiToken[]>({
    queryKey: ['api-tokens'],
    queryFn: apiTokensApi.list,
  })

  const createMut = useMutation({
    mutationFn: ({ name, days }: { name: string; days?: number }) =>
      apiTokensApi.create(name, days),
    onSuccess: (data) => {
      setCreatedToken(data.token)
      qc.invalidateQueries({ queryKey: ['api-tokens'] })
      form.resetFields()
    },
    onError: () => msgApi.error(t('settings.api_tokens.toast.create_failed')),
  })

  const revokeMut = useMutation({
    mutationFn: (id: number) => apiTokensApi.revoke(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['api-tokens'] })
      msgApi.success(t('settings.api_tokens.toast.revoked'))
    },
  })

  const C = isDark
    ? { bg: '#1e293b', border: '#334155', text: '#f1f5f9', muted: '#64748b', codeBg: '#0f172a' }
    : { bg: '#ffffff', border: '#e2e8f0', text: '#1e293b', muted: '#94a3b8', codeBg: '#f1f5f9' }

  const columns = [
    {
      title: t('settings.api_tokens.col.name'),
      dataIndex: 'name',
      key: 'name',
      render: (name: string) => <Text style={{ fontWeight: 600, color: C.text }}>{name}</Text>,
    },
    {
      title: t('settings.api_tokens.col.prefix'),
      dataIndex: 'prefix',
      key: 'prefix',
      render: (p: string) => (
        <code style={{ background: C.codeBg, padding: '2px 6px', borderRadius: 4, fontSize: 12, color: '#22c55e' }}>
          {p}…
        </code>
      ),
    },
    {
      title: t('settings.api_tokens.col.last_used'),
      dataIndex: 'last_used_at',
      key: 'last_used_at',
      render: (d?: string) => d ? (
        <Tooltip title={dayjs(d).format('DD.MM.YYYY HH:mm:ss')}>
          <Text style={{ color: C.muted, fontSize: 12 }}>{dayjs(d).fromNow()}</Text>
        </Tooltip>
      ) : <Text style={{ color: C.muted, fontSize: 12 }}>{t('settings.api_tokens.never_used')}</Text>,
    },
    {
      title: t('settings.api_tokens.col.expires_at'),
      dataIndex: 'expires_at',
      key: 'expires_at',
      render: (d?: string) => d ? (
        <Tag color={dayjs(d).isBefore(dayjs()) ? 'red' : dayjs(d).diff(dayjs(), 'day') < 7 ? 'orange' : 'default'}>
          {dayjs(d).format('DD.MM.YYYY')}
        </Tag>
      ) : <Tag color="green">{t('settings.api_tokens.never_expires')}</Tag>,
    },
    {
      title: t('common.created_at'),
      dataIndex: 'created_at',
      key: 'created_at',
      render: (d: string) => <Text style={{ color: C.muted, fontSize: 12 }}>{dayjs(d).format('DD.MM.YYYY HH:mm')}</Text>,
    },
    {
      title: '',
      key: 'action',
      render: (_: unknown, rec: ApiToken) => (
        <Popconfirm
          title={t('settings.api_tokens.popconfirm.revoke_title')}
          description={t('settings.api_tokens.popconfirm.revoke_desc')}
          okText={t('settings.api_tokens.btn_revoke')}
          cancelText={t('common.give_up')}
          okButtonProps={{ danger: true }}
          onConfirm={() => revokeMut.mutate(rec.id)}
        >
          <Button size="small" danger type="text" icon={<DeleteOutlined />} loading={revokeMut.isPending}>
            {t('settings.api_tokens.btn_revoke')}
          </Button>
        </Popconfirm>
      ),
    },
  ]

  return (
    <div>
      {msgCtx}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <Text style={{ fontWeight: 600, fontSize: 15 }}>{t('settings.api_tokens.section_title')}</Text>
          <br />
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('settings.api_tokens.section_subtitle')}
          </Text>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          {t('settings.api_tokens.btn_new')}
        </Button>
      </div>

      <Table
        dataSource={tokens || []}
        columns={columns}
        rowKey="id"
        loading={isLoading}
        size="small"
        locale={{ emptyText: t('settings.api_tokens.empty') }}
        pagination={false}
      />

      {/* Create modal */}
      <Modal
        open={createOpen && !createdToken}
        title={<Space><KeyOutlined style={{ color: '#3b82f6' }} /> {t('settings.api_tokens.modal.title_new')}</Space>}
        onCancel={() => { setCreateOpen(false); form.resetFields() }}
        onOk={() => form.submit()}
        okText={t('common.create')}
        confirmLoading={createMut.isPending}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(vals) => createMut.mutate({ name: vals.name, days: vals.expires_in_days || undefined })}
          style={{ marginTop: 16 }}
        >
          <Form.Item label={t('settings.api_tokens.form.name_label')} name="name" rules={[{ required: true, message: t('settings.api_tokens.form.name_required') }]}>
            <Input placeholder={t('settings.api_tokens.form.name_placeholder')} />
          </Form.Item>
          <Form.Item label={t('settings.api_tokens.form.expires_label')} name="expires_in_days" help={t('settings.api_tokens.form.expires_help')}>
            <Select allowClear placeholder={t('settings.api_tokens.never_expires')}>
              <Select.Option value={30}>{t('settings.sla.days_value', { count: 30 })}</Select.Option>
              <Select.Option value={90}>{t('settings.sla.days_value', { count: 90 })}</Select.Option>
              <Select.Option value={180}>{t('settings.sla.days_value', { count: 180 })}</Select.Option>
              <Select.Option value={365}>{t('settings.api_tokens.one_year')}</Select.Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>

      {/* Show created token */}
      <Modal
        open={!!createdToken}
        title={<Space><KeyOutlined style={{ color: '#22c55e' }} /> {t('settings.api_tokens.modal.created_title')}</Space>}
        onCancel={() => { setCreatedToken(null); setCreateOpen(false) }}
        footer={[
          <Button key="close" type="primary" onClick={() => { setCreatedToken(null); setCreateOpen(false) }}>
            {t('settings.api_tokens.modal.saved_btn')}
          </Button>,
        ]}
      >
        <Alert
          type="warning"
          showIcon
          icon={<ExclamationCircleOutlined />}
          message={t('settings.api_tokens.modal.warn_title')}
          description={t('settings.api_tokens.modal.warn_desc')}
          style={{ marginBottom: 16 }}
        />
        <div style={{
          background: C.codeBg, border: `1px solid ${C.border}`, borderRadius: 8,
          padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <code style={{ flex: 1, fontSize: 13, wordBreak: 'break-all', color: '#22c55e', fontFamily: 'monospace' }}>
            {createdToken}
          </code>
          <Tooltip title={t('common.copy')}>
            <Button
              icon={<CopyOutlined />}
              size="small"
              onClick={() => {
                navigator.clipboard.writeText(createdToken!)
                msgApi.success(t('settings.api_tokens.toast.copied'))
              }}
            />
          </Tooltip>
        </div>
        <Text type="secondary" style={{ fontSize: 12, marginTop: 8, display: 'block' }}>
          {t('settings.api_tokens.usage_hint')} <code>Authorization: Bearer {createdToken?.slice(0, 16)}…</code>
        </Text>
      </Modal>
    </div>
  )
}

// ── AI Settings Tab ─────────────────────────────────────────────────────────

const PROVIDER_COLORS: Record<string, string> = {
  claude: '#cc785c',
  openai: '#10a37f',
  gemini: '#4285f4',
  ollama: '#7c3aed',
}

const CLAUDE_MODELS = ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001']
const OPENAI_MODELS = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo']
const GEMINI_MODELS = ['gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-2.0-flash-exp']

function AISettingsTab() {
  const qc = useQueryClient()
  const { t } = useTranslation()
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({})

  const { data: settings, isLoading } = useQuery<AIProviderSettings>({
    queryKey: ['ai-settings'],
    queryFn: aiAssistantApi.getSettings,
  })

  React.useEffect(() => {
    if (settings) {
      form.setFieldsValue({
        active_provider: settings.active_provider ?? '',
        claude_model: settings.claude_model,
        openai_model: settings.openai_model,
        gemini_model: settings.gemini_model,
        ollama_base_url: settings.ollama_base_url,
        ollama_model: settings.ollama_model,
      })
    }
  }, [settings, form])

  const activeProvider = Form.useWatch('active_provider', form)

  const save = async () => {
    const vals = form.getFieldsValue()
    setSaving(true)
    try {
      const payload: Record<string, any> = { active_provider: vals.active_provider || null }
      if (vals.claude_model) payload.claude_model = vals.claude_model
      if (vals.claude_api_key) payload.claude_api_key = vals.claude_api_key
      if (vals.openai_model) payload.openai_model = vals.openai_model
      if (vals.openai_api_key) payload.openai_api_key = vals.openai_api_key
      if (vals.gemini_model) payload.gemini_model = vals.gemini_model
      if (vals.gemini_api_key) payload.gemini_api_key = vals.gemini_api_key
      if (vals.ollama_base_url !== undefined) payload.ollama_base_url = vals.ollama_base_url
      if (vals.ollama_model !== undefined) payload.ollama_model = vals.ollama_model
      await aiAssistantApi.updateSettings(payload)
      qc.invalidateQueries({ queryKey: ['ai-settings'] })
      message.success(t('settings.ai.toast.saved'))
    } catch {
      message.error(t('common.save_failed'))
    } finally {
      setSaving(false)
    }
  }

  const { isDark } = useTheme()
  const C = { bg2: isDark ? '#0f172a' : '#f8fafc', border: isDark ? '#334155' : '#e2e8f0', text: isDark ? '#f1f5f9' : '#1e293b', muted: isDark ? '#64748b' : '#94a3b8' }

  // KURAL: 'Anthropic Claude', 'OpenAI GPT', 'Google Gemini' vendor markaları —
  // çevrilmez (KURAL-vendor). 'Ollama (Yerel)' içindeki "Yerel" sadece bir UI
  // suffix; t() ile çözülür.
  const providers: { id: string; name: string; keyField?: string; modelField?: string; models?: string[]; configured?: boolean }[] = [
    { id: 'claude', name: 'Anthropic Claude', keyField: 'claude_api_key', modelField: 'claude_model', models: CLAUDE_MODELS, configured: settings?.claude_configured },
    { id: 'openai', name: 'OpenAI GPT', keyField: 'openai_api_key', modelField: 'openai_model', models: OPENAI_MODELS, configured: settings?.openai_configured },
    { id: 'gemini', name: 'Google Gemini', keyField: 'gemini_api_key', modelField: 'gemini_model', models: GEMINI_MODELS, configured: settings?.gemini_configured },
    { id: 'ollama', name: t('settings.ai.provider_ollama_local'), configured: true },
  ]

  return (
    <div style={{ maxWidth: 720 }}>
      <Alert
        type="info"
        showIcon
        message={t('settings.ai.security_message')}
        style={{ marginBottom: 20 }}
      />

      <Form form={form} layout="vertical">
        <Form.Item label={t('settings.ai.active_provider_label')} name="active_provider">
          <Select placeholder={t('settings.ai.active_provider_placeholder')} allowClear style={{ width: 280 }}>
            {providers.map(p => (
              <Select.Option key={p.id} value={p.id}>
                <span style={{ color: PROVIDER_COLORS[p.id], fontWeight: 600 }}>● </span>
                {p.name}
                {p.configured && p.id !== 'ollama' && <CheckCircleOutlined style={{ color: '#22c55e', marginLeft: 8 }} />}
              </Select.Option>
            ))}
          </Select>
        </Form.Item>

        {providers.filter(p => p.id !== 'ollama').map(p => (
          <div key={p.id} style={{
            background: C.bg2, border: `1px solid ${activeProvider === p.id ? PROVIDER_COLORS[p.id] : C.border}`,
            borderRadius: 10, padding: '16px 20px', marginBottom: 16,
            opacity: activeProvider && activeProvider !== p.id ? 0.6 : 1,
            transition: 'all 0.2s',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <span style={{ color: PROVIDER_COLORS[p.id], fontWeight: 700, fontSize: 14 }}>
                {p.name}
              </span>
              {p.configured
                ? <Tag color="success" icon={<CheckCircleOutlined />}>{t('settings.ai.tag_configured')}</Tag>
                : <Tag color="default">{t('settings.ai.tag_no_key')}</Tag>}
            </div>
            <Space direction="vertical" style={{ width: '100%' }} size={8}>
              <Form.Item name={p.keyField} noStyle>
                <Input.Password
                  placeholder={p.configured
                    ? t('settings.ai.api_key_placeholder_change', { name: p.name })
                    : t('settings.ai.api_key_placeholder', { name: p.name })}
                  style={{ width: '100%' }}
                  visibilityToggle={{
                    visible: showKeys[p.id!] ?? false,
                    onVisibleChange: v => setShowKeys(prev => ({ ...prev, [p.id!]: v })),
                  }}
                />
              </Form.Item>
              <Form.Item name={p.modelField} noStyle>
                <Select style={{ width: 280 }} placeholder={t('settings.ai.model_placeholder')}>
                  {(p.models ?? []).map(m => (
                    <Select.Option key={m} value={m}>{m}</Select.Option>
                  ))}
                </Select>
              </Form.Item>
            </Space>
          </div>
        ))}

        {/* Ollama */}
        <div style={{
          background: C.bg2, border: `1px solid ${activeProvider === 'ollama' ? PROVIDER_COLORS['ollama'] : C.border}`,
          borderRadius: 10, padding: '16px 20px', marginBottom: 16,
          opacity: activeProvider && activeProvider !== 'ollama' ? 0.6 : 1,
          transition: 'all 0.2s',
        }}>
          <div style={{ fontWeight: 700, color: PROVIDER_COLORS['ollama'], marginBottom: 12, fontSize: 14 }}>
            {t('settings.ai.ollama_section_title')}
            <Tag color="purple" style={{ marginLeft: 8 }}>{t('settings.ai.tag_no_api_key')}</Tag>
          </div>
          <Space>
            <Form.Item name="ollama_base_url" noStyle>
              <Input placeholder="http://localhost:11434" style={{ width: 280 }} />
            </Form.Item>
            <Form.Item name="ollama_model" noStyle>
              <Input placeholder="llama3.2" style={{ width: 160 }} />
            </Form.Item>
          </Space>
        </div>

        <Button type="primary" loading={saving || isLoading} onClick={save} icon={<CheckOutlined />}>
          {t('common.save')}
        </Button>
      </Form>
    </div>
  )
}

// ── Main Settings Page ──────────────────────────────────────────────────────

export default function SettingsPage() {
  const { t } = useTranslation()
  const { isDark, toggle } = useTheme()
  const currentLang = i18n.language

  // ── nm-statbar gerçek değerler — diğer sayfalar gibi ────────────────────
  // Her API'nin list endpoint'i var; parallel useQuery'le çekiyoruz.
  // Hata/loading durumunda 0 gösteriyoruz (sayfa açılınca hemen render olsun).
  const { data: channels = [] } = useQuery({
    queryKey: ['settings-stat-channels'],
    queryFn: () => notificationsApi.list().then((d) => d.items),
    staleTime: 60_000,
  })
  const { data: profiles = [] } = useQuery({
    queryKey: ['settings-stat-cred-profiles'],
    queryFn: credentialProfilesApi.list,
    staleTime: 60_000,
  })
  const { data: tokens = [] } = useQuery({
    queryKey: ['settings-stat-tokens'],
    queryFn: apiTokensApi.list,
    staleTime: 60_000,
  })
  const { data: rules = [] } = useQuery({
    queryKey: ['settings-stat-alert-rules'],
    queryFn: alertRulesApi.list,
    staleTime: 60_000,
  })
  const { data: slaPolicies = [] } = useQuery({
    queryKey: ['settings-stat-sla'],
    queryFn: slaApi.listPolicies,
    staleTime: 60_000,
  })

  function handleLangChange(code: string) {
    i18n.changeLanguage(code)
    localStorage.setItem('nm-lang', code)
  }

  const generalContent = (
    <div style={{ maxWidth: 640, display: 'flex', flexDirection: 'column', gap: 28 }}>
      {/* Language */}
      <div>
        <SectionHeader icon={<GlobalOutlined />} title={t('settings.section_general')} />
        <div style={{ marginBottom: 8 }}>
          <Text style={{ fontWeight: 600, fontSize: 14 }}>{t('settings.language')}</Text>
          <br />
          <Text type="secondary" style={{ fontSize: 12 }}>{t('settings.language_desc')}</Text>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
          {LANGUAGES.map((lang) => {
            const isActive = currentLang === lang.code
            return (
              <div
                key={lang.code}
                onClick={() => handleLangChange(lang.code)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '14px 16px',
                  borderRadius: 10,
                  border: isActive
                    ? '2px solid #3b82f6'
                    : `2px solid ${isDark ? '#334155' : '#e2e8f0'}`,
                  background: isActive
                    ? (isDark ? '#1d4ed815' : '#eff6ff')
                    : (isDark ? '#1e293b' : '#ffffff'),
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                  position: 'relative',
                }}
              >
                <span style={{ fontSize: 28, lineHeight: 1 }}>{lang.flag}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: isActive ? 700 : 500, fontSize: 14 }}>{lang.label}</div>
                  <div style={{ fontSize: 11, opacity: 0.5 }}>{lang.region}</div>
                </div>
                {isActive && (
                  <div style={{
                    width: 22, height: 22, borderRadius: '50%',
                    background: '#3b82f6',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0,
                  }}>
                    <CheckOutlined style={{ color: '#fff', fontSize: 11 }} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <Divider style={{ margin: '4px 0' }} />

      {/* Appearance */}
      <div>
        <SectionHeader icon={<BgColorsOutlined />} title={t('settings.section_appearance')} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <Text style={{ fontWeight: 600, fontSize: 14 }}>{t('settings.theme')}</Text>
            <br />
            <Text type="secondary" style={{ fontSize: 12 }}>{t('settings.theme_desc')}</Text>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Tag icon={isDark ? <MoonOutlined /> : <SunOutlined />} color={isDark ? 'blue' : 'default'}>
              {isDark ? t('settings.theme_dark') : t('settings.theme_light')}
            </Tag>
            <Switch
              checked={isDark}
              onChange={toggle}
              checkedChildren={<MoonOutlined />}
              unCheckedChildren={<SunOutlined />}
            />
          </div>
        </div>
      </div>

      <Divider style={{ margin: '4px 0' }} />

      <div>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('settings.version')}: 1.0.0
        </Text>
      </div>
    </div>
  )

  const [searchParams, setSearchParams] = useSearchParams()
  const activeTab = searchParams.get('tab') || 'general'

  return (
    <div className="nm-page" style={{ padding: '4px 2px' }}>
      <div className="nm-page-hd">
        <div className="title-block">
          <div className="nm-crumbs"><span>{t('settings.crumb_admin')}</span><span>{t('settings.title')}</span></div>
          <h1 className="nm-page-title">
            {t('settings.title')}
            <span className="nm-pill mono">Charon v1.0</span>
          </h1>
          <div className="nm-page-sub">{t('settings.page_subtitle')}</div>
        </div>
      </div>

      <div className="nm-statbar">
        <div className="nm-stat">
          <div className="nm-stat-label">{t('settings.stat.notification_channels')}</div>
          <div className="nm-stat-val">{channels.length}</div>
          <div className="nm-stat-delta">{t('settings.stat.n_active', { count: channels.filter((c) => c.is_active).length })}</div>
        </div>
        <div className="nm-stat">
          <div className="nm-stat-label">{t('settings.stat.alert_rules')}</div>
          <div className="nm-stat-val">{rules.length}</div>
          <div className="nm-stat-delta">{t('settings.stat.n_active', { count: rules.filter((r) => r.enabled).length })}</div>
        </div>
        <div className="nm-stat">
          <div className="nm-stat-label">{t('settings.stat.sla_policies')}</div>
          <div className="nm-stat-val">{slaPolicies.length}</div>
        </div>
        <div className="nm-stat">
          <div className="nm-stat-label">{t('settings.stat.credential_profiles')}</div>
          <div className="nm-stat-val">{profiles.length}</div>
        </div>
        <div className="nm-stat">
          <div className="nm-stat-label">{t('settings.stat.api_tokens')}</div>
          <div className="nm-stat-val">{tokens.length}</div>
        </div>
        <div className="nm-stat ok">
          <div className="nm-stat-label">{t('settings.theme')}</div>
          <div className="nm-stat-val mono" style={{ fontSize: 18 }}>{isDark ? t('settings.theme_dark') : t('settings.theme_light')}</div>
          <div className="nm-stat-delta">{currentLang.toUpperCase()} · v1.0.0</div>
        </div>
      </div>

      {/* Mockup tasarımı: sol dikey nav (220px) + sağ aktif sekme içeriği card */}
      {(() => {
        const TABS: { key: string; label: string; icon: React.ReactNode; content: React.ReactNode }[] = [
          { key: 'general',          label: t('settings.tab.general'),           icon: <GlobalOutlined />, content: generalContent },
          { key: 'system',           label: t('settings.tab.system'),            icon: <ClockCircleOutlined />, content: <SystemSettingsTab /> },
          { key: 'password-policy',  label: t('settings.tab.password_policy'),   icon: <LockOutlined />,        content: <PasswordPolicyTab /> },
          // T8.4 — MFA artık kullanıcı bazlı /profile sayfasında (her
          // authenticated kullanıcı kendi MFA'sını yönetebilsin diye).
          // Settings org-admin gated; viewer/location_admin buradan kendi
          // MFA'sına ulaşamıyordu. Kaldırıldı.
          { key: 'notifications',    label: t('settings.tab.notifications'),     icon: <BellOutlined />,   content: <NotificationChannelsTab /> },
          { key: 'alert-rules',      label: t('settings.tab.alert_rules'),       icon: <AlertOutlined />,  content: <AlertRulesTab /> },
          { key: 'maintenance',      label: t('settings.tab.maintenance'),       icon: <ToolOutlined />,   content: <MaintenanceWindowsTab /> },
          { key: 'credentials',      label: t('settings.tab.credentials'),       icon: <SafetyOutlined />, content: <CredentialProfilesTab /> },
          { key: 'rotation',         label: t('settings.tab.rotation'),          icon: <SyncOutlined />,   content: <SecretRotationTab /> },
          { key: 'sla',              label: t('settings.tab.sla'),               icon: <RiseOutlined />,   content: <SlaPoliciesTab /> },
          { key: 'snmp',             label: t('settings.tab.snmp'),              icon: <WifiOutlined />,   content: <SnmpConfigTab /> },
          { key: 'api-tokens',       label: t('settings.tab.api_tokens'),        icon: <KeyOutlined />,    content: <ApiTokensTab /> },
          { key: 'driver-templates', label: t('settings.tab.driver_templates'),  icon: <CodeOutlined />,   content: <DriverTemplatesPage /> },
          { key: 'ai',               label: t('settings.tab.ai'),                icon: <RobotOutlined />,  content: <AISettingsTab /> },
        ]
        const active = TABS.find((t) => t.key === activeTab) ?? TABS[0]
        return (
          <div style={{ display: 'grid', gridTemplateColumns: '230px 1fr', gap: 14, flex: 1, minHeight: 0 }}>
            {/* Sol nav */}
            <div className="nm-card" style={{ padding: 6, height: 'fit-content', position: 'sticky', top: 8 }}>
              {TABS.map((tab) => {
                const isActive = tab.key === active.key
                return (
                  <div key={tab.key}
                    className={`nm-navitem ${isActive ? 'active' : ''}`}
                    onClick={() => setSearchParams({ tab: tab.key })}
                    style={{ cursor: 'pointer' }}>
                    <span className="nm-navicon">{tab.icon}</span>
                    <span>{tab.label}</span>
                  </div>
                )
              })}
            </div>
            {/* Sağ içerik */}
            <div className="nm-card" style={{ padding: 22, overflow: 'auto', minWidth: 0 }}>
              {active.content}
            </div>
          </div>
        )
      })()}
    </div>
  )
}
