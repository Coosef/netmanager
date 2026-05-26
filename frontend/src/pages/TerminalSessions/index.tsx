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
import { useState } from 'react'
import {
  Alert, Badge, Button, Card, Drawer, Input, message, Select, Space, Table,
  Tag, Typography,
} from 'antd'
import {
  CodeOutlined, DesktopOutlined, RobotOutlined,
  ReloadOutlined, SafetyOutlined, UserOutlined,
} from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { terminalSessionsApi, TerminalSessionListItem } from '@/api/terminalSessions'
import dayjs from 'dayjs'

const { Text, Paragraph } = Typography

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

function ExitTag({ reason }: { reason: string | null }) {
  if (!reason) return <Tag color="orange">Devam ediyor</Tag>
  const colorMap: Record<string, string> = {
    user_closed: 'default',
    idle_timeout: 'warning',
    agent_disconnected: 'error',
    paramiko_error: 'error',
    ws_error: 'error',
  }
  return <Tag color={colorMap[reason] || 'default'}>{reason}</Tag>
}

export default function TerminalSessionsPage() {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'closed'>('all')
  const [page, setPage] = useState(0)
  const [pageSize] = useState(50)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // T9 Tur 3B — AI özet trigger
  const summarizeMut = useMutation({
    mutationFn: (sid: string) => terminalSessionsApi.summarize(sid),
    onSuccess: (data) => {
      message.success(
        data.status === 'completed'
          ? `AI özet hazırlandı (${data.provider || '?'} / ${data.tokens_used || 0} token)`
          : `Status: ${data.status}`,
      )
      // Re-fetch detail to pick up ai_summary
      qc.invalidateQueries({ queryKey: ['terminal-session-detail', selectedId] })
      qc.invalidateQueries({ queryKey: ['terminal-sessions-list'] })
    },
    onError: (e: any) => message.error(
      e?.response?.data?.detail || 'AI özet üretilemedi',
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
      title: 'BAŞLANGIÇ',
      dataIndex: 'started_at',
      width: 150,
      render: (v: string) => v ? dayjs(v).format('DD.MM.YY HH:mm:ss') : '—',
    },
    {
      title: 'KULLANICI',
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
      title: 'CİHAZ',
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
      title: 'YOL',
      dataIndex: 'connection_path',
      width: 110,
      render: (v: string | null) => v === 'agent_relay'
        ? <Tag color="cyan">Agent</Tag>
        : v === 'direct_paramiko'
          ? <Tag color="purple">Direkt</Tag>
          : <Tag>—</Tag>,
    },
    {
      title: 'KOMUT',
      dataIndex: 'commands_count',
      width: 75,
      align: 'right' as const,
      render: (v: number) => (
        <Badge count={v} showZero style={{ backgroundColor: v > 0 ? 'var(--accent)' : '#999' }} />
      ),
    },
    {
      title: 'SÜRE',
      dataIndex: 'duration_ms',
      width: 90,
      render: (v: number | null) => formatDuration(v),
    },
    {
      title: 'I/O',
      width: 130,
      render: (_: any, r: TerminalSessionListItem) => (
        <Text style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--fg-3)' }}>
          ↓{formatBytes(r.output_bytes)} · ↑{formatBytes(r.input_bytes)}
        </Text>
      ),
    },
    {
      title: 'DURUM',
      dataIndex: 'exit_reason',
      width: 140,
      render: (v: string | null) => <ExitTag reason={v} />,
    },
    {
      title: 'IP',
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
          <div className="nm-crumbs"><span>Güvenlik</span><span>SSH Oturum Audit</span></div>
          <h1 className="nm-page-title">
            <CodeOutlined style={{ marginRight: 8 }} />
            SSH Oturum Audit
            <span className="nm-pill mono">{total} kayıt</span>
          </h1>
          <div className="nm-page-sub">
            Browser üzerinden açılan interaktif SSH terminal session'ları ·
            çıkartılan komutlar, IO bytes, çıktı özeti · forensik audit.
          </div>
        </div>
      </div>

      <div className="nm-statbar">
        <div className="nm-stat">
          <div className="nm-stat-label">SON 24SA OTURUM</div>
          <div className="nm-stat-val">{statsQ.data?.sessions_24h ?? '—'}</div>
        </div>
        <div className="nm-stat">
          <div className="nm-stat-label">SON 24SA KOMUT</div>
          <div className="nm-stat-val">{statsQ.data?.commands_24h ?? '—'}</div>
        </div>
        <div className="nm-stat">
          <div className="nm-stat-label">ORT. SÜRE</div>
          <div className="nm-stat-val">{formatDuration(statsQ.data?.avg_duration_ms ?? null)}</div>
        </div>
        <div className={`nm-stat ${statsQ.data?.active_now ? 'warn' : 'ok'}`}>
          <div className="nm-stat-label">ŞU AN AKTİF</div>
          <div className="nm-stat-val">{statsQ.data?.active_now ?? '—'}</div>
        </div>
      </div>

      <Alert
        type="info" showIcon
        icon={<SafetyOutlined />}
        message="AI özet özelliği yakında (T9 Tur 3B)"
        description={
          <span style={{ fontSize: 12 }}>
            Şu an her session'ın komut listesi + IO bytes + son ~10KB çıktısı kaydediliyor.
            AI ile session özetleme (Claude API) bir sonraki increment'te aktif olacak.
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
              placeholder="Kullanıcı veya cihaz ara…"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0) }}
              style={{ width: 280 }}
              allowClear
            />
            <Select
              value={statusFilter}
              onChange={(v) => { setStatusFilter(v); setPage(0) }}
              options={[
                { label: 'Tüm durumlar', value: 'all' },
                { label: 'Sadece aktif', value: 'active' },
                { label: 'Sadece kapalı', value: 'closed' },
              ]}
              style={{ width: 160 }}
            />
            <Button icon={<ReloadOutlined />} onClick={() => listQ.refetch()}>Yenile</Button>
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
            Oturum Detayı
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
            <Card size="small" title="Genel">
              <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: 8, fontSize: 12 }}>
                <Text strong>Kullanıcı</Text>
                <Text>{detailQ.data.username || `#${detailQ.data.user_id}`}</Text>
                <Text strong>Cihaz</Text>
                <Text>
                  {detailQ.data.device_hostname || `#${detailQ.data.device_id}`}
                  {detailQ.data.device_ip && (
                    <Text style={{ marginLeft: 8, fontFamily: 'monospace', color: 'var(--fg-3)' }}>
                      {detailQ.data.device_ip}
                    </Text>
                  )}
                </Text>
                <Text strong>Yol</Text>
                <Text>{detailQ.data.connection_path || '—'}</Text>
                {detailQ.data.agent_id && (<>
                  <Text strong>Agent</Text>
                  <Text style={{ fontFamily: 'monospace' }}>{detailQ.data.agent_id}</Text>
                </>)}
                <Text strong>Başlangıç</Text>
                <Text>{detailQ.data.started_at ? dayjs(detailQ.data.started_at).format('DD.MM.YYYY HH:mm:ss') : '—'}</Text>
                <Text strong>Bitiş</Text>
                <Text>{detailQ.data.ended_at ? dayjs(detailQ.data.ended_at).format('DD.MM.YYYY HH:mm:ss') : '—'}</Text>
                <Text strong>Süre</Text>
                <Text>{formatDuration(detailQ.data.duration_ms)}</Text>
                <Text strong>Çıkış Nedeni</Text>
                <ExitTag reason={detailQ.data.exit_reason} />
                <Text strong>Client IP</Text>
                <Text style={{ fontFamily: 'monospace' }}>{detailQ.data.client_ip || '—'}</Text>
                <Text strong>I/O</Text>
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
                  AI Özet
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
                    {detailQ.data.ai_summary ? 'Yeniden Üret' : 'Özet Üret'}
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
                  AI özet üretiliyor… (3-8 saniye)
                </Text>
              ) : (
                <Space direction="vertical" size={6}>
                  <Text style={{ color: 'var(--fg-3)' }}>
                    Bu session için henüz AI özet üretilmedi.
                  </Text>
                  <Text style={{ fontSize: 11, color: 'var(--fg-3)' }}>
                    AI Asistanı aktif provider'ı kullanır (Settings → AI Asistanı).
                    Provider configure değilse hata alırsınız.
                  </Text>
                </Space>
              )}
            </Card>

            {/* Commands */}
            <Card size="small" title={
              <Space>
                <CodeOutlined />
                Çıkartılan Komutlar
                <Badge count={detailQ.data.commands_extracted.length} showZero />
              </Space>
            }>
              {detailQ.data.commands_extracted.length === 0 ? (
                <Text style={{ color: 'var(--fg-3)' }}>Komut çıkarılmadı (boş input veya devam eden session)</Text>
              ) : (
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

            {/* Output excerpt */}
            <Card size="small" title="Çıktı Özeti (son ~10KB)">
              {detailQ.data.output_excerpt ? (
                <pre style={{
                  maxHeight: 300, overflow: 'auto', fontSize: 11,
                  fontFamily: 'monospace', background: '#0d1117', color: '#c9d1d9',
                  padding: 10, borderRadius: 4, margin: 0,
                  whiteSpace: 'pre-wrap',
                }}>{detailQ.data.output_excerpt}</pre>
              ) : (
                <Text style={{ color: 'var(--fg-3)' }}>Çıktı kaydedilmedi</Text>
              )}
            </Card>
          </Space>
        )}
      </Drawer>
    </div>
  )
}
