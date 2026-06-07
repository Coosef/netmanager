/**
 * TerminalSessions — Interaktif SSH session audit görüntüleyici.
 *
 * T9 Tur 3A + 3C. Backend her browser→cihaz terminal session'ını
 * `terminal_session_logs` tablosuna kaydeder (input/output bytes,
 * çıkartılan komutlar, output excerpt). Bu sayfa o veriyi listeler.
 *
 * 3B (AI özet) sonraki increment'te eklenecek — ai_summary alanı
 * şu an çoğunlukla null/pending; göstergesi var.
 */
import { useMemo, useState } from 'react'
import {
  Alert, Badge, Button, Card, Drawer, Input, message, Select, Space, Table,
  Tag, Typography,
} from 'antd'
import {
  CodeOutlined, DesktopOutlined, RobotOutlined,
  ReloadOutlined, SafetyOutlined, UserOutlined,
} from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { terminalSessionsApi, TerminalSessionListItem } from '@/api/terminalSessions'
import dayjs from 'dayjs'

const { Text, Paragraph } = Typography

// formatDuration / formatBytes: SI/IEC tabanlı teknik birim (B/KB/MB/ms/s/dk/sa)
// — KURAL-E3 backend numeric helpers, kullanıcı bu unit'leri çevirmedi (uluslararası
// kısaltma). Eğer ileride dk/sa → min/hr istenirse ayrı bir issue açılır.
function formatDuration(ms: number | null): string {
  if (!ms) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}dk`
  return `${(ms / 3_600_000).toFixed(1)}sa`
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b}B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`
  return `${(b / 1024 / 1024).toFixed(1)}MB`
}

// KURAL-E1 + E3: exit_reason backend enum sabit kalır; renkler de teknik
// (AntD enum) module-level sözlük. UI label hook scope'unda useMemo + t()
// ile çözülür (TerminalSessionsPage içinde EXIT_LABEL).
const EXIT_COLOR: Record<string, string> = {
  user_closed: 'default',
  idle_timeout: 'warning',
  agent_disconnected: 'error',
  paramiko_error: 'error',
  ws_error: 'error',
  stale_cleanup: 'warning',
}

// connection_path için aynı pattern: backend enum sabit, renk teknik,
// label i18n.
const PATH_COLOR: Record<string, string> = {
  agent_relay: 'cyan',
  direct_paramiko: 'purple',
}

export default function TerminalSessionsPage() {
  const qc = useQueryClient()
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'closed'>('all')
  const [page, setPage] = useState(0)
  const [pageSize] = useState(50)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // KURAL-E1 — exit_reason label ve connection_path label hook scope'unda
  // useMemo. Backend enum sabit kalır (EXIT_COLOR / PATH_COLOR module-level).
  const EXIT_LABEL = useMemo<Record<string, string>>(() => ({
    user_closed:        t('terminal_sessions.status.user_closed'),
    idle_timeout:       t('terminal_sessions.status.idle_timeout'),
    agent_disconnected: t('terminal_sessions.status.agent_disconnected'),
    paramiko_error:     t('terminal_sessions.status.paramiko_error'),
    ws_error:           t('terminal_sessions.status.ws_error'),
    stale_cleanup:      t('terminal_sessions.status.stale_cleanup'),
  }), [t])

  const PATH_LABEL = useMemo<Record<string, string>>(() => ({
    agent_relay:     t('terminal_sessions.path.agent_relay'),
    direct_paramiko: t('terminal_sessions.path.direct_paramiko'),
  }), [t])

  const renderExitTag = (reason: string | null) => {
    if (!reason) return <Tag color="orange">{t('terminal_sessions.status.in_progress')}</Tag>
    return <Tag color={EXIT_COLOR[reason] || 'default'}>{EXIT_LABEL[reason] || reason}</Tag>
  }

  // T9 Tur 3B — AI özet trigger
  const summarizeMut = useMutation({
    mutationFn: (sid: string) => terminalSessionsApi.summarize(sid),
    onSuccess: (data) => {
      message.success(
        data.status === 'completed'
          ? t('terminal_sessions.toast.ai_ready', { provider: data.provider || '?', tokens: data.tokens_used || 0 })
          : t('terminal_sessions.toast.ai_status_other', { status: data.status }),
      )
      // Re-fetch detail to pick up ai_summary
      qc.invalidateQueries({ queryKey: ['terminal-session-detail', selectedId] })
      qc.invalidateQueries({ queryKey: ['terminal-sessions-list'] })
    },
    onError: (e: any) => message.error(
      e?.response?.data?.detail || t('terminal_sessions.toast.ai_failed'),
    ),
  })

  const statsQ = useQuery({
    queryKey: ['terminal-sessions-stats'],
    queryFn: terminalSessionsApi.stats,
    refetchInterval: 30000,
  })

  const listQ = useQuery({
    queryKey: ['terminal-sessions-list', page, search, statusFilter],
    queryFn: () => terminalSessionsApi.list({
      limit: pageSize,
      offset: page * pageSize,
      search: search.trim() || undefined,
      status: statusFilter === 'all' ? undefined : statusFilter,
    }),
    refetchInterval: 15000,
  })

  const detailQ = useQuery({
    queryKey: ['terminal-session-detail', selectedId],
    queryFn: () => terminalSessionsApi.get(selectedId!),
    enabled: !!selectedId,
  })

  const columns = [
    {
      title: t('terminal_sessions.col.started_at'),
      dataIndex: 'started_at',
      width: 150,
      render: (v: string) => v ? dayjs(v).format('DD.MM.YY HH:mm:ss') : '—',
    },
    {
      title: t('terminal_sessions.col.username'),
      dataIndex: 'username',
      width: 130,
      render: (v: string | null, r: TerminalSessionListItem) => (
        <Space size={4}>
          <UserOutlined style={{ color: 'var(--fg-3)', fontSize: 11 }} />
          <Text style={{ fontSize: 12 }}>{v || `#${r.user_id || '?'}`}</Text>
        </Space>
      ),
    },
    {
      title: t('terminal_sessions.col.device'),
      dataIndex: 'device_hostname',
      width: 180,
      render: (v: string | null, r: TerminalSessionListItem) => (
        <div>
          <div style={{ fontWeight: 500, fontSize: 12 }}>{v || `#${r.device_id || '?'}`}</div>
          {r.device_ip && (
            <div style={{ fontSize: 10, color: 'var(--fg-3)', fontFamily: 'monospace' }}>
              {r.device_ip}
            </div>
          )}
        </div>
      ),
    },
    {
      title: t('terminal_sessions.col.connection_path'),
      dataIndex: 'connection_path',
      width: 110,
      render: (v: string | null) => v && PATH_LABEL[v]
        ? <Tag color={PATH_COLOR[v] || 'default'}>{PATH_LABEL[v]}</Tag>
        : <Tag>—</Tag>,
    },
    {
      title: t('terminal_sessions.col.commands'),
      dataIndex: 'commands_count',
      width: 75,
      align: 'right' as const,
      render: (v: number) => (
        <Badge count={v} showZero style={{ backgroundColor: v > 0 ? 'var(--accent)' : '#999' }} />
      ),
    },
    {
      title: t('terminal_sessions.col.duration'),
      dataIndex: 'duration_ms',
      width: 90,
      render: (v: number | null) => formatDuration(v),
    },
    {
      title: t('terminal_sessions.col.io'),
      width: 130,
      render: (_: any, r: TerminalSessionListItem) => (
        <Text style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--fg-3)' }}>
          ↓{formatBytes(r.output_bytes)} · ↑{formatBytes(r.input_bytes)}
        </Text>
      ),
    },
    {
      title: t('terminal_sessions.col.status'),
      dataIndex: 'exit_reason',
      width: 140,
      render: (v: string | null) => renderExitTag(v),
    },
    {
      title: t('terminal_sessions.col.client_ip'),
      dataIndex: 'client_ip',
      width: 120,
      render: (v: string | null) => v
        ? <Text style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--fg-3)' }}>{v}</Text>
        : '—',
    },
  ]

  const total = listQ.data?.total || 0
  const items = listQ.data?.items || []

  return (
    <div className="nm-page" style={{ padding: '4px 2px' }}>
      <div className="nm-page-hd">
        <div className="title-block">
          <div className="nm-crumbs"><span>{t('terminal_sessions.crumb_security')}</span><span>{t('terminal_sessions.crumb_audit')}</span></div>
          <h1 className="nm-page-title">
            <CodeOutlined style={{ marginRight: 8 }} />
            {t('terminal_sessions.page_title')}
            <span className="nm-pill mono">{t('terminal_sessions.records_count', { count: total })}</span>
          </h1>
          <div className="nm-page-sub">
            {t('terminal_sessions.page_subtitle')}
          </div>
        </div>
      </div>

      <div className="nm-statbar">
        <div className="nm-stat">
          <div className="nm-stat-label">{t('terminal_sessions.stat.sessions_24h')}</div>
          <div className="nm-stat-val">{statsQ.data?.sessions_24h ?? '—'}</div>
        </div>
        <div className="nm-stat">
          <div className="nm-stat-label">{t('terminal_sessions.stat.commands_24h')}</div>
          <div className="nm-stat-val">{statsQ.data?.commands_24h ?? '—'}</div>
        </div>
        <div className="nm-stat">
          <div className="nm-stat-label">{t('terminal_sessions.stat.avg_duration')}</div>
          <div className="nm-stat-val">{formatDuration(statsQ.data?.avg_duration_ms ?? null)}</div>
        </div>
        <div className={`nm-stat ${statsQ.data?.active_now ? 'warn' : 'ok'}`}>
          <div className="nm-stat-label">{t('terminal_sessions.stat.active_now')}</div>
          <div className="nm-stat-val">{statsQ.data?.active_now ?? '—'}</div>
        </div>
      </div>

      <Alert
        type="info" showIcon
        icon={<SafetyOutlined />}
        message={t('terminal_sessions.alert.ai_coming_title')}
        description={
          <span style={{ fontSize: 12 }}>
            {t('terminal_sessions.alert.ai_coming_desc')}
          </span>
        }
        style={{ marginBottom: 12 }}
        closable
      />

      <Card
        bodyStyle={{ padding: 0 }}
        title={
          <Space>
            <Input
              placeholder={t('terminal_sessions.toolbar.search_placeholder')}
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0) }}
              style={{ width: 280 }}
              allowClear
            />
            <Select
              value={statusFilter}
              onChange={(v) => { setStatusFilter(v); setPage(0) }}
              options={[
                { label: t('terminal_sessions.toolbar.status_all'), value: 'all' },
                { label: t('terminal_sessions.toolbar.status_active_only'), value: 'active' },
                { label: t('terminal_sessions.toolbar.status_closed_only'), value: 'closed' },
              ]}
              style={{ width: 160 }}
            />
            <Button icon={<ReloadOutlined />} onClick={() => listQ.refetch()}>{t('common.refresh')}</Button>
          </Space>
        }
      >
        <Table
          rowKey="session_id"
          loading={listQ.isLoading}
          dataSource={items}
          columns={columns}
          size="small"
          pagination={{
            current: page + 1,
            pageSize,
            total,
            showSizeChanger: false,
            onChange: (p) => setPage(p - 1),
          }}
          onRow={(record) => ({
            onClick: () => setSelectedId(record.session_id),
            style: { cursor: 'pointer' },
          })}
        />
      </Card>

      {/* Detail drawer */}
      <Drawer
        open={!!selectedId}
        onClose={() => setSelectedId(null)}
        title={
          <Space>
            <DesktopOutlined />
            {t('terminal_sessions.drawer.title')}
            {detailQ.data?.session_id && (
              <Tag style={{ fontFamily: 'monospace', fontSize: 10 }}>
                {detailQ.data.session_id.slice(0, 12)}…
              </Tag>
            )}
          </Space>
        }
        width={760}
      >
        {detailQ.data && (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            {/* Meta */}
            <Card size="small" title={t('terminal_sessions.general.title')}>
              <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: 8, fontSize: 12 }}>
                <Text strong>{t('terminal_sessions.general.label_user')}</Text>
                <Text>{detailQ.data.username || `#${detailQ.data.user_id}`}</Text>
                <Text strong>{t('terminal_sessions.general.label_device')}</Text>
                <Text>
                  {detailQ.data.device_hostname || `#${detailQ.data.device_id}`}
                  {detailQ.data.device_ip && (
                    <Text style={{ marginLeft: 8, fontFamily: 'monospace', color: 'var(--fg-3)' }}>
                      {detailQ.data.device_ip}
                    </Text>
                  )}
                </Text>
                <Text strong>{t('terminal_sessions.general.label_path')}</Text>
                <Text>
                  {detailQ.data.connection_path && PATH_LABEL[detailQ.data.connection_path]
                    ? PATH_LABEL[detailQ.data.connection_path]
                    : (detailQ.data.connection_path || '—')}
                </Text>
                {detailQ.data.agent_id && (<>
                  <Text strong>{t('terminal_sessions.general.label_agent')}</Text>
                  <Text style={{ fontFamily: 'monospace' }}>{detailQ.data.agent_id}</Text>
                </>)}
                <Text strong>{t('terminal_sessions.general.label_started')}</Text>
                <Text>{detailQ.data.started_at ? dayjs(detailQ.data.started_at).format('DD.MM.YYYY HH:mm:ss') : '—'}</Text>
                <Text strong>{t('terminal_sessions.general.label_ended')}</Text>
                <Text>{detailQ.data.ended_at ? dayjs(detailQ.data.ended_at).format('DD.MM.YYYY HH:mm:ss') : '—'}</Text>
                <Text strong>{t('terminal_sessions.general.label_duration')}</Text>
                <Text>{formatDuration(detailQ.data.duration_ms)}</Text>
                <Text strong>{t('terminal_sessions.general.label_exit_reason')}</Text>
                {renderExitTag(detailQ.data.exit_reason)}
                <Text strong>{t('terminal_sessions.general.label_client_ip')}</Text>
                <Text style={{ fontFamily: 'monospace' }}>{detailQ.data.client_ip || '—'}</Text>
                <Text strong>{t('terminal_sessions.general.label_io')}</Text>
                <Text style={{ fontFamily: 'monospace' }}>
                  ↑{formatBytes(detailQ.data.input_bytes)} · ↓{formatBytes(detailQ.data.output_bytes)}
                </Text>
              </div>
            </Card>

            {/* T9 Tur 3B — AI özet kartı */}
            <Card
              size="small"
              title={
                <Space>
                  <RobotOutlined style={{ color: 'var(--accent)' }} />
                  {t('terminal_sessions.ai.card_title')}
                  {detailQ.data.ai_summary_status && (
                    <Tag color={
                      detailQ.data.ai_summary_status === 'completed' ? 'green' :
                      detailQ.data.ai_summary_status === 'running' ? 'processing' :
                      detailQ.data.ai_summary_status === 'failed' ? 'red' : 'default'
                    }>
                      {detailQ.data.ai_summary_status}
                    </Tag>
                  )}
                </Space>
              }
              extra={
                detailQ.data.session_id && (
                  <Button
                    type="primary" size="small"
                    icon={<RobotOutlined />}
                    loading={summarizeMut.isPending}
                    disabled={detailQ.data.ai_summary_status === 'running'}
                    onClick={() => summarizeMut.mutate(detailQ.data.session_id)}
                  >
                    {detailQ.data.ai_summary ? t('terminal_sessions.ai.btn_regenerate') : t('terminal_sessions.ai.btn_generate')}
                  </Button>
                )
              }
            >
              {detailQ.data.ai_summary ? (
                <Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>
                  {detailQ.data.ai_summary}
                </Paragraph>
              ) : detailQ.data.ai_summary_status === 'running' ? (
                <Text style={{ color: 'var(--fg-3)' }}>
                  {t('terminal_sessions.ai.status_running_text')}
                </Text>
              ) : (
                <Space direction="vertical" size={6}>
                  <Text style={{ color: 'var(--fg-3)' }}>
                    {t('terminal_sessions.ai.empty_title')}
                  </Text>
                  <Text style={{ fontSize: 11, color: 'var(--fg-3)' }}>
                    {t('terminal_sessions.ai.empty_provider_hint')}
                  </Text>
                </Space>
              )}
            </Card>

            {/* Commands */}
            <Card size="small" title={
              <Space>
                <CodeOutlined />
                {t('terminal_sessions.commands.card_title')}
                <Badge count={detailQ.data.commands_extracted.length} showZero />
              </Space>
            }>
              {detailQ.data.commands_extracted.length === 0 ? (
                <Text style={{ color: 'var(--fg-3)' }}>{t('terminal_sessions.commands.empty')}</Text>
              ) : (
                // KURAL-E2: Terminal komutları (c.cmd) çevrilmez — CLI literal.
                <div style={{
                  maxHeight: 280, overflow: 'auto',
                  fontFamily: 'monospace', fontSize: 12,
                  background: 'var(--bg-2)', padding: 8, borderRadius: 4,
                }}>
                  {detailQ.data.commands_extracted.map((c, i) => (
                    <div key={i} style={{ marginBottom: 4 }}>
                      <Text style={{ color: 'var(--fg-3)', fontSize: 10, marginRight: 8 }}>
                        +{formatDuration(c.t)}
                      </Text>
                      <Text style={{ color: 'var(--accent)' }}>$</Text>{' '}
                      <Text>{c.cmd}</Text>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            {/* Output excerpt — KURAL-E2: ham terminal output çevrilmez */}
            <Card size="small" title={t('terminal_sessions.output.card_title')}>
              {detailQ.data.output_excerpt ? (
                <pre style={{
                  maxHeight: 300, overflow: 'auto', fontSize: 11,
                  fontFamily: 'monospace', background: '#0d1117', color: '#c9d1d9',
                  padding: 10, borderRadius: 4, margin: 0,
                  whiteSpace: 'pre-wrap',
                }}>{detailQ.data.output_excerpt}</pre>
              ) : (
                <Text style={{ color: 'var(--fg-3)' }}>{t('terminal_sessions.output.empty')}</Text>
              )}
            </Card>
          </Space>
        )}
      </Drawer>
    </div>
  )
}
