import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Col, Row, Space, Table, Select, Tabs, Typography, Tag, Tooltip, Badge, Progress, Button,
} from 'antd'
import { useTranslation } from 'react-i18next'
import { exportToExcel } from '@/utils/exportExcel'
import {
  DownloadOutlined, LaptopOutlined, WarningOutlined, FileExcelOutlined,
  DatabaseOutlined, BarChartOutlined, CheckCircleOutlined,
  CloseCircleOutlined, CodeOutlined, RiseOutlined, FilePdfOutlined,
} from '@ant-design/icons'
import { reportsApi, type ReportSummary } from '@/api/reports'
import { useTheme } from '@/contexts/ThemeContext'
import { useSite } from '@/contexts/SiteContext'
import dayjs from 'dayjs'

const { Text } = Typography

const REPORTS_CSS = `
@keyframes reportCardIn {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes reportCardGlow {
  0%, 100% { box-shadow: 0 4px 16px var(--rc-color, #3b82f6)12; }
  50%       { box-shadow: 0 6px 24px var(--rc-color, #3b82f6)22; }
}
`

function mkColors(isDark: boolean) {
  return {
    bg: isDark ? '#1e293b' : '#ffffff',
    bg2: isDark ? '#162032' : '#f5f5f5',
    border: isDark ? '#334155' : '#e5e7eb',
    text: isDark ? '#f1f5f9' : '#111827',
    muted: isDark ? '#64748b' : '#6b7280',
    dim: isDark ? '#475569' : '#9ca3af',
    primary: '#3b82f6', success: '#22c55e', warning: '#f59e0b',
    danger: '#ef4444', info: '#06b6d4',
    isDark,
  }
}

type Colors = ReturnType<typeof mkColors>

function SummaryCard({ icon, color, label, value, sub, C }: {
  icon: React.ReactNode; color: string; label: string; value: number | string; sub?: string; C: Colors
}) {
  return (
    <div style={{
      background: C.isDark
        ? `linear-gradient(135deg, ${color}0d 0%, ${C.bg} 60%)`
        : C.bg,
      border: `1px solid ${C.isDark ? color + '28' : C.border}`,
      borderTop: C.isDark ? `2px solid ${color}55` : `2px solid ${color}`,
      borderRadius: 12,
      padding: '16px 20px',
      position: 'relative',
      overflow: 'hidden',
      animation: 'reportCardIn 0.4s ease-out',
      boxShadow: C.isDark ? `0 4px 20px ${color}10` : '0 1px 3px rgba(0,0,0,0.06)',
      transition: 'box-shadow 0.2s',
    }}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLElement
        el.style.boxShadow = C.isDark ? `0 6px 28px ${color}25` : `0 4px 14px ${color}25`
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLElement
        el.style.boxShadow = C.isDark ? `0 4px 20px ${color}10` : '0 1px 3px rgba(0,0,0,0.06)'
      }}
    >
      {C.isDark && (
        <div style={{
          position: 'absolute', inset: 0,
          background: `radial-gradient(ellipse at top left, ${color}10 0%, transparent 60%)`,
          pointerEvents: 'none',
        }} />
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, position: 'relative' }}>
        <div style={{
          width: 42, height: 42, borderRadius: 10,
          background: C.isDark ? `${color}20` : `${color}15`,
          border: C.isDark ? `1px solid ${color}30` : undefined,
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          boxShadow: C.isDark ? `0 0 12px ${color}20` : undefined,
        }}>
          <span style={{ color, fontSize: 20 }}>{icon}</span>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: C.muted, fontSize: 11, fontWeight: 500, letterSpacing: 0.5, textTransform: 'uppercase' }}>{label}</div>
          <div
            key={String(value)}
            style={{ color: C.text, fontSize: 22, fontWeight: 800, lineHeight: 1.2 }}
          >
            {value}
          </div>
          {sub && <div style={{ color: C.dim, fontSize: 11, marginTop: 2 }}>{sub}</div>}
        </div>
      </div>
    </div>
  )
}

function DownloadBtn({ href, label, C }: { href: string; label: string; C: Colors }) {
  return (
    <a href={href} download style={{ textDecoration: 'none' }}>
      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        background: C.primary, color: '#fff', borderRadius: 7,
        padding: '6px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
      }}>
        <DownloadOutlined /> {label}
      </div>
    </a>
  )
}

function UptimeBars({ daily, muted }: { daily: { date: string; online: number; offline: number; total: number }[]; muted: string }) {
  const maxVal = Math.max(...daily.map((x) => x.total), 1)
  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 200, padding: '0 8px', minWidth: daily.length * 44 }}>
        {daily.map((d) => {
          const onlinePct = (d.online / maxVal) * 100
          const offlinePct = (d.offline / maxVal) * 100
          return (
            <Tooltip key={d.date} title={`Online: ${d.online} / Offline: ${d.offline}`}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, cursor: 'default' }}>
                <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 2, height: 180, justifyContent: 'flex-end' }}>
                  <div style={{ width: '100%', height: `${offlinePct}%`, background: '#ef4444', borderRadius: '3px 3px 0 0', minHeight: d.offline > 0 ? 2 : 0 }} />
                  <div style={{ width: '100%', height: `${onlinePct}%`, background: '#22c55e', borderRadius: '3px 3px 0 0', minHeight: d.online > 0 ? 2 : 0 }} />
                </div>
                <div style={{ fontSize: 10, color: muted, whiteSpace: 'nowrap' }}>{d.date}</div>
              </div>
            </Tooltip>
          )
        })}
      </div>
      <div style={{ display: 'flex', gap: 16, justifyContent: 'center', marginTop: 8 }}>
        <span style={{ fontSize: 12, color: muted }}><span style={{ display: 'inline-block', width: 12, height: 12, background: '#22c55e', borderRadius: 2, marginRight: 4 }} />Online</span>
        <span style={{ fontSize: 12, color: muted }}><span style={{ display: 'inline-block', width: 12, height: 12, background: '#ef4444', borderRadius: 2, marginRight: 4 }} />Offline</span>
      </div>
    </div>
  )
}

function exportExecutiveSummary(s: ReportSummary) {
  const now = new Date()
  const dateStr = now.toLocaleDateString('tr-TR', { year: 'numeric', month: 'long', day: 'numeric' })
  const timeStr = now.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })

  const onlinePct = s.devices.total > 0 ? Math.round((s.devices.online / s.devices.total) * 100) : 0
  const backupOkPct = s.devices.total > 0 ? Math.round((s.devices.backup_ok / s.devices.total) * 100) : 0
  const backupNeverPct = s.devices.total > 0 ? Math.round((s.devices.backup_never / s.devices.total) * 100) : 0
  const taskSuccessPct = s.tasks_7d.total > 0 ? Math.round((s.tasks_7d.success / s.tasks_7d.total) * 100) : 100

  const vendorRows = Object.entries(s.devices.by_vendor)
    .sort((a, b) => b[1] - a[1])
    .map(([v, count]) => {
      const pct = s.devices.total > 0 ? Math.round((count / s.devices.total) * 100) : 0
      const VCOLORS: Record<string, string> = { cisco: '#1d6fa4', aruba: '#ff8300', ruijie: '#e4002b', other: '#8c8c8c' }
      const color = VCOLORS[v] || '#8c8c8c'
      return `<tr>
        <td><span class="dot" style="background:${color}"></span>${v.charAt(0).toUpperCase() + v.slice(1)}</td>
        <td class="num">${count}</td>
        <td class="num">${pct}%</td>
        <td><div class="bar-wrap"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div></td>
      </tr>`
    }).join('')

  const riskLevel = s.devices.offline > 5 || s.events_24h.critical > 2
    ? { label: 'YÜKSEK', color: '#ef4444', bg: '#fef2f2' }
    : s.devices.offline > 0 || s.events_24h.warning > 5
    ? { label: 'ORTA', color: '#f59e0b', bg: '#fffbeb' }
    : { label: 'DÜŞÜK', color: '#22c55e', bg: '#f0fdf4' }

  const html = `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<title>NetManager — Yönetici Özet Raporu ${dateStr}</title>
<style>
  @page { margin: 18mm 15mm; size: A4 portrait; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 13px; color: #1e293b; background: #fff; }
  .page { max-width: 780px; margin: 0 auto; padding: 24px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #3b82f6; padding-bottom: 16px; margin-bottom: 24px; }
  .logo { font-size: 22px; font-weight: 800; color: #3b82f6; letter-spacing: -0.5px; }
  .logo span { color: #1e293b; }
  .header-right { text-align: right; font-size: 12px; color: #64748b; line-height: 1.6; }
  .header-right strong { color: #1e293b; }
  h2 { font-size: 15px; font-weight: 700; color: #1e293b; margin: 20px 0 12px; display: flex; align-items: center; gap: 6px; }
  h2::before { content: ''; display: inline-block; width: 4px; height: 16px; background: #3b82f6; border-radius: 2px; }
  .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
  .kpi { border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px 16px; position: relative; overflow: hidden; }
  .kpi::after { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px; background: var(--kc); }
  .kpi-val { font-size: 28px; font-weight: 800; color: var(--kc); line-height: 1; }
  .kpi-label { font-size: 11px; color: #64748b; margin-top: 4px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
  .kpi-sub { font-size: 11px; color: #94a3b8; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { background: #f8fafc; text-align: left; padding: 8px 10px; font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #e2e8f0; }
  td { padding: 8px 10px; border-bottom: 1px solid #f1f5f9; vertical-align: middle; }
  td.num { text-align: right; font-weight: 600; }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; }
  .bar-wrap { background: #f1f5f9; border-radius: 4px; height: 8px; width: 100%; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 4px; transition: width 0.3s; }
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 24px; }
  .stat-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #f1f5f9; font-size: 12px; }
  .stat-row:last-child { border: none; }
  .stat-val { font-weight: 700; font-size: 14px; }
  .risk-badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 700; background: ${riskLevel.bg}; color: ${riskLevel.color}; border: 1px solid ${riskLevel.color}33; }
  .section-box { border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px; margin-bottom: 24px; }
  .pct-bar { display: flex; height: 12px; border-radius: 6px; overflow: hidden; margin-top: 8px; }
  .footer { border-top: 1px solid #e2e8f0; padding-top: 12px; margin-top: 24px; font-size: 11px; color: #94a3b8; display: flex; justify-content: space-between; }
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .no-print { display: none !important; }
  }
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <div>
      <div class="logo">⬡ Net<span>Manager</span></div>
      <div style="font-size:14px;font-weight:700;color:#1e293b;margin-top:4px">Yönetici Özet Raporu</div>
      <div style="font-size:12px;color:#64748b;margin-top:2px">Ağ Görünürlük & Operasyon Platformu</div>
    </div>
    <div class="header-right">
      <strong>${dateStr}</strong><br>
      Saat: ${timeStr}<br>
      Risk Seviyesi: <span class="risk-badge">${riskLevel.label}</span>
    </div>
  </div>

  <h2>Genel Bakış</h2>
  <div class="kpi-grid">
    <div class="kpi" style="--kc:#3b82f6">
      <div class="kpi-val">${s.devices.total}</div>
      <div class="kpi-label">Toplam Cihaz</div>
      <div class="kpi-sub">${s.topology.links} bağlantı</div>
    </div>
    <div class="kpi" style="--kc:#22c55e">
      <div class="kpi-val">${s.devices.online}</div>
      <div class="kpi-label">Online</div>
      <div class="kpi-sub">%${onlinePct} erişilebilir</div>
    </div>
    <div class="kpi" style="--kc:${s.devices.offline > 0 ? '#ef4444' : '#22c55e'}">
      <div class="kpi-val">${s.devices.offline}</div>
      <div class="kpi-label">Offline</div>
      <div class="kpi-sub">${s.devices.unknown} bilinmiyor</div>
    </div>
    <div class="kpi" style="--kc:${s.events_24h.critical > 0 ? '#ef4444' : '#64748b'}">
      <div class="kpi-val">${s.events_24h.total}</div>
      <div class="kpi-label">Olay (24s)</div>
      <div class="kpi-sub">${s.events_24h.critical} kritik, ${s.events_24h.warning} uyarı</div>
    </div>
  </div>

  <div class="two-col">
    <div>
      <h2>Yedekleme Durumu</h2>
      <div class="section-box">
        <div class="stat-row"><span>Güncel Yedek</span><span class="stat-val" style="color:#22c55e">${s.devices.backup_ok}</span></div>
        <div class="stat-row"><span>Eski Yedek (7g+)</span><span class="stat-val" style="color:#f59e0b">${s.devices.backup_stale}</span></div>
        <div class="stat-row"><span>Hiç Yedek Alınmamış</span><span class="stat-val" style="color:#ef4444">${s.devices.backup_never}</span></div>
        <div class="pct-bar">
          <div style="width:${backupOkPct}%;background:#22c55e"></div>
          <div style="width:${s.devices.total > 0 ? Math.round((s.devices.backup_stale / s.devices.total) * 100) : 0}%;background:#f59e0b"></div>
          <div style="width:${backupNeverPct}%;background:#ef4444"></div>
        </div>
        <div style="font-size:11px;color:#64748b;margin-top:6px">%${backupOkPct} uyumlu yedekleme</div>
      </div>
    </div>
    <div>
      <h2>Otomasyon (7 Gün)</h2>
      <div class="section-box">
        <div class="stat-row"><span>Başarılı Görev</span><span class="stat-val" style="color:#22c55e">${s.tasks_7d.success}</span></div>
        <div class="stat-row"><span>Kısmen Başarılı</span><span class="stat-val" style="color:#f59e0b">${s.tasks_7d.partial}</span></div>
        <div class="stat-row"><span>Başarısız Görev</span><span class="stat-val" style="color:#ef4444">${s.tasks_7d.failed}</span></div>
        <div class="pct-bar">
          <div style="width:${taskSuccessPct}%;background:#22c55e"></div>
          <div style="width:${s.tasks_7d.total > 0 ? Math.round((s.tasks_7d.partial / s.tasks_7d.total) * 100) : 0}%;background:#f59e0b"></div>
          <div style="width:${s.tasks_7d.total > 0 ? Math.round((s.tasks_7d.failed / s.tasks_7d.total) * 100) : 0}%;background:#ef4444"></div>
        </div>
        <div style="font-size:11px;color:#64748b;margin-top:6px">%${taskSuccessPct} başarı oranı</div>
      </div>
    </div>
  </div>

  <h2>Vendor Dağılımı</h2>
  <table>
    <thead><tr><th>Vendor</th><th style="text-align:right">Cihaz</th><th style="text-align:right">Oran</th><th style="width:35%">Dağılım</th></tr></thead>
    <tbody>${vendorRows}</tbody>
  </table>

  <div class="footer">
    <span>NetManager Ağ Görünürlük Platformu — Otomatik oluşturuldu</span>
    <span>${dateStr} ${timeStr}</span>
  </div>
</div>
<script>window.onload = function(){ window.print(); }<\/script>
</body>
</html>`

  const w = window.open('', '_blank')
  if (w) {
    w.document.write(html)
    w.document.close()
  }
}

export default function ReportsPage() {
  const [eventHours, setEventHours] = useState(24)
  const [uptimeDays, setUptimeDays] = useState(7)
  const [problemDays, setProblemDays] = useState(7)
  const [activeTab, setActiveTab] = useState('devices')
  const { t } = useTranslation()
  const { isDark } = useTheme()
  const { activeSite } = useSite()
  const C = mkColors(isDark)

  const { data: summary } = useQuery({
    queryKey: ['report-summary', activeSite],
    queryFn: () => reportsApi.getSummary({ site: activeSite || undefined }),
    refetchInterval: 60000,
  })

  const { data: devicesData, isLoading: devLoading } = useQuery({
    queryKey: ['report-devices', activeSite],
    queryFn: () => reportsApi.getDevices({ site: activeSite || undefined }),
    enabled: activeTab === 'devices',
  })

  const { data: eventsData, isLoading: evLoading } = useQuery({
    queryKey: ['report-events', eventHours],
    queryFn: () => reportsApi.getEvents(eventHours),
    enabled: activeTab === 'events',
  })

  const { data: backupsData, isLoading: bkLoading } = useQuery({
    queryKey: ['report-backups', activeSite],
    queryFn: () => reportsApi.getBackups({ site: activeSite || undefined }),
    enabled: activeTab === 'backups',
  })

  const { data: firmwareData, isLoading: fwLoading } = useQuery({
    queryKey: ['report-firmware', activeSite],
    queryFn: () => reportsApi.getFirmware({ site: activeSite || undefined }),
    enabled: activeTab === 'firmware',
  })

  const { data: uptimeData, isLoading: upLoading } = useQuery({
    queryKey: ['report-uptime', uptimeDays, activeSite],
    queryFn: () => reportsApi.getUptime(uptimeDays, activeSite || undefined),
    enabled: activeTab === 'uptime',
  })

  const { data: problematicData, isLoading: probLoading } = useQuery({
    queryKey: ['report-problematic', problemDays, activeSite],
    queryFn: () => reportsApi.getProblematicDevices(problemDays, 25, activeSite || undefined),
    enabled: activeTab === 'problematic',
  })

  const { data: agentHealthData, isLoading: agentHealthLoading } = useQuery({
    queryKey: ['report-agent-health'],
    queryFn: reportsApi.getAgentHealth,
    enabled: activeTab === 'agent-health',
    refetchInterval: activeTab === 'agent-health' ? 30000 : false,
  })

  const s = summary

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <style>{REPORTS_CSS}</style>

      {/* Header */}
      <div style={{
        background: isDark
          ? 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)'
          : C.bg,
        border: `1px solid ${isDark ? '#3b82f620' : C.border}`,
        borderLeft: '4px solid #3b82f6',
        borderRadius: 12,
        padding: '16px 20px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10,
            background: '#3b82f620', border: '1px solid #3b82f630',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <BarChartOutlined style={{ color: C.primary, fontSize: 20 }} />
          </div>
          <div>
            <div style={{ color: C.text, fontWeight: 700, fontSize: 16 }}>{t('reports.title')}</div>
            <Text style={{ color: C.muted, fontSize: 12 }}>
              {s ? <span>{t('reports.last_updated')}: {dayjs(s.generated_at).format('HH:mm:ss')}</span> : 'Yükleniyor...'}
            </Text>
          </div>
        </div>
        <Tooltip title="Tüm özet verileri içeren A4 yönetici raporu oluşturur. Tarayıcı yazdır / PDF kaydet ile PDF yapabilirsiniz.">
          <Button
            icon={<FilePdfOutlined />}
            type="primary"
            disabled={!s}
            onClick={() => s && exportExecutiveSummary(s)}
            style={{ background: '#ef4444', borderColor: '#ef4444' }}
          >
            Yönetici Özeti
          </Button>
        </Tooltip>
      </div>

      {/* Summary cards */}
      {s && (
        <Row gutter={[12, 12]}>
          <Col xs={12} sm={8} lg={4}>
            <SummaryCard icon={<LaptopOutlined />} color={C.primary} label={t('reports.stat_total')} value={s.devices.total} sub={`${s.devices.online}`} C={C} />
          </Col>
          <Col xs={12} sm={8} lg={4}>
            <SummaryCard icon={<CheckCircleOutlined />} color={C.success} label={t('reports.stat_online')} value={s.devices.online} sub={`${s.devices.offline}`} C={C} />
          </Col>
          <Col xs={12} sm={8} lg={4}>
            <SummaryCard icon={<WarningOutlined />} color={C.warning} label={t('reports.stat_warning')} value={s.events_24h.total} sub={`${s.events_24h.critical} ${t('reports.stat_critical')}`} C={C} />
          </Col>
          <Col xs={12} sm={8} lg={4}>
            <SummaryCard icon={<DatabaseOutlined />} color="#10b981" label={t('reports.stat_backup_ok')} value={s.devices.backup_ok} sub={`${s.devices.backup_never}`} C={C} />
          </Col>
          <Col xs={12} sm={8} lg={4}>
            <SummaryCard icon={<CheckCircleOutlined />} color={C.success} label={t('reports.stat_task_ok')} value={s.tasks_7d.success} sub={`${s.tasks_7d.failed}`} C={C} />
          </Col>
          <Col xs={12} sm={8} lg={4}>
            <SummaryCard icon={<CloseCircleOutlined />} color={C.danger} label={t('reports.stat_backup_never')} value={s.devices.backup_never} sub={`${s.devices.backup_stale}`} C={C} />
          </Col>
        </Row>
      )}

      {/* Report tabs */}
      <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          style={{ padding: '0 20px' }}
          tabBarStyle={{ borderBottom: `1px solid ${C.border}`, marginBottom: 0 }}
          tabBarExtraContent={
            activeTab === 'devices' ? (
              <Space>
                <Button
                  size="small" icon={<FileExcelOutlined />} style={{ color: '#22c55e', borderColor: '#22c55e' }}
                  onClick={() => devicesData?.items && exportToExcel(
                    [{ name: 'Cihazlar', data: devicesData.items as Record<string, unknown>[] }],
                    'network-inventory'
                  )}
                  disabled={!devicesData?.items?.length}
                >Excel</Button>
                <DownloadBtn href={reportsApi.getDevicesCsvUrl()} label={t('reports.download_csv')} C={C} />
              </Space>
            ) :
            activeTab === 'events' ? (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <Select size="small" value={eventHours} onChange={setEventHours} style={{ width: 120 }}
                  options={[
                    { value: 24, label: '24h' }, { value: 72, label: '72h' },
                    { value: 168, label: '168h' }, { value: 720, label: '720h' },
                  ]}
                />
                <Button
                  size="small" icon={<FileExcelOutlined />} style={{ color: '#22c55e', borderColor: '#22c55e' }}
                  onClick={() => eventsData?.items && exportToExcel(
                    [{ name: 'Olaylar', data: eventsData.items as Record<string, unknown>[] }],
                    'events-report'
                  )}
                  disabled={!eventsData?.items?.length}
                >Excel</Button>
                <DownloadBtn href={reportsApi.getEventsCsvUrl(eventHours)} label={t('reports.download_csv')} C={C} />
              </div>
            ) :
            activeTab === 'backups' ? (
              <Space>
                <Button
                  size="small" icon={<FileExcelOutlined />} style={{ color: '#22c55e', borderColor: '#22c55e' }}
                  onClick={() => backupsData?.items && exportToExcel(
                    [{ name: 'Yedekler', data: backupsData.items as Record<string, unknown>[] }],
                    'backup-report'
                  )}
                  disabled={!backupsData?.items?.length}
                >Excel</Button>
                <DownloadBtn href={reportsApi.getBackupsZipUrl()} label="Tümünü ZIP İndir" C={C} />
                <DownloadBtn href={reportsApi.getBackupsCsvUrl()} label={t('reports.download_csv')} C={C} />
              </Space>
            ) :
            activeTab === 'firmware' ? <DownloadBtn href={reportsApi.getFirmwareCsvUrl()} label={t('reports.download_csv')} C={C} /> :
            activeTab === 'uptime' ? (
              <Select size="small" value={uptimeDays} onChange={setUptimeDays} style={{ width: 120 }}
                options={[
                  { value: 7, label: '7 Gün' }, { value: 14, label: '14 Gün' },
                  { value: 30, label: '30 Gün' },
                ]}
              />
            ) :
            activeTab === 'problematic' ? (
              <Select size="small" value={problemDays} onChange={setProblemDays} style={{ width: 120 }}
                options={[
                  { value: 1, label: '24 Saat' }, { value: 7, label: '7 Gün' },
                  { value: 14, label: '14 Gün' }, { value: 30, label: '30 Gün' },
                ]}
              />
            ) :
            null
          }
          items={[
            {
              key: 'devices',
              label: <span style={{ color: activeTab === 'devices' ? C.primary : C.muted }}><LaptopOutlined /> {t('reports.device_inventory')}</span>,
              children: (
                <div style={{ padding: '0 0 4px' }}>
                  <Table
                    dataSource={devicesData?.items}
                    loading={devLoading}
                    rowKey="hostname"
                    size="small"
                    pagination={{ pageSize: 20, showTotal: (total) => <span style={{ color: C.muted }}>{total} cihaz</span> }}
                    columns={[
                      { title: 'Hostname', dataIndex: 'hostname', sorter: (a: any, b: any) => a.hostname.localeCompare(b.hostname) },
                      { title: 'IP', dataIndex: 'ip_address', render: (v: string) => <code style={{ background: C.bg2, padding: '1px 6px', borderRadius: 4, fontSize: 11 }}>{v}</code> },
                      { title: 'Vendor', dataIndex: 'vendor', render: (v: string) => <Tag color="blue" style={{ textTransform: 'capitalize' }}>{v || '—'}</Tag> },
                      { title: 'OS', dataIndex: 'os_type', render: (v: string) => <Text style={{ color: C.muted, fontSize: 12 }}>{v || '—'}</Text> },
                      { title: 'Model', dataIndex: 'model', render: (v: string) => v || <Text style={{ color: C.dim }}>—</Text> },
                      { title: 'Firmware', dataIndex: 'firmware_version', render: (v: string) => v || <Text style={{ color: C.dim }}>—</Text> },
                      { title: 'Durum', dataIndex: 'status', render: (v: string) => <Badge status={v === 'online' ? 'success' : v === 'offline' ? 'error' : 'default'} text={v} /> },
                      { title: 'Son Görülme', dataIndex: 'last_seen', render: (v: string) => v ? <Tooltip title={dayjs(v).format('DD.MM.YYYY HH:mm')}><Text style={{ color: C.muted, fontSize: 12 }}>{dayjs(v).fromNow()}</Text></Tooltip> : '—' },
                      { title: 'Son Yedek', dataIndex: 'last_backup', render: (v: string) => v ? <Tooltip title={dayjs(v).format('DD.MM.YYYY HH:mm')}><Text style={{ color: C.muted, fontSize: 12 }}>{dayjs(v).fromNow()}</Text></Tooltip> : <Tag color="red">Hiç</Tag> },
                    ]}
                  />
                </div>
              ),
            },
            {
              key: 'events',
              label: <span style={{ color: activeTab === 'events' ? C.primary : C.muted }}><WarningOutlined /> {t('reports.event_history')}</span>,
              children: (
                <div style={{ padding: '0 0 4px' }}>
                  <Table
                    dataSource={eventsData?.items}
                    loading={evLoading}
                    rowKey={(_r, i) => `${i}`}
                    size="small"
                    pagination={{ pageSize: 20, showTotal: (total) => <span style={{ color: C.muted }}>{total} olay</span> }}
                    columns={[
                      { title: 'Zaman', dataIndex: 'created_at', width: 140, render: (v: string) => <Tooltip title={dayjs(v).format('DD.MM.YYYY HH:mm:ss')}><Text style={{ color: C.muted, fontSize: 12 }}>{dayjs(v).fromNow()}</Text></Tooltip> },
                      { title: 'Önem', dataIndex: 'severity', width: 90, render: (v: string) => <Tag color={v === 'critical' ? 'red' : v === 'warning' ? 'orange' : 'blue'}>{v}</Tag> },
                      { title: 'Tür', dataIndex: 'event_type', width: 160, render: (v: string) => <Text style={{ color: C.muted, fontSize: 12 }}>{v}</Text> },
                      { title: 'Başlık', dataIndex: 'title', ellipsis: true },
                      { title: 'Cihaz', dataIndex: 'device_hostname', width: 140, render: (v: string) => v || '—' },
                      { title: 'Durum', dataIndex: 'acknowledged', width: 90, render: (v: string) => v === 'True' ? <Badge status="success" text="Onandı" /> : <Badge status="warning" text="Bekliyor" /> },
                    ]}
                  />
                </div>
              ),
            },
            {
              key: 'backups',
              label: <span style={{ color: activeTab === 'backups' ? C.primary : C.muted }}><DatabaseOutlined /> {t('reports.backup_status')}</span>,
              children: (
                <div style={{ padding: '0 0 4px' }}>
                  <Table
                    dataSource={backupsData?.items}
                    loading={bkLoading}
                    rowKey="hostname"
                    size="small"
                    pagination={{ pageSize: 20, showTotal: (total) => <span style={{ color: C.muted }}>{total} cihaz</span> }}
                    columns={[
                      { title: 'Hostname', dataIndex: 'hostname', sorter: (a: any, b: any) => a.hostname.localeCompare(b.hostname) },
                      { title: 'IP', dataIndex: 'ip_address', render: (v: string) => <code style={{ background: C.bg2, padding: '1px 6px', borderRadius: 4, fontSize: 11 }}>{v}</code> },
                      { title: 'Vendor', dataIndex: 'vendor', render: (v: string) => <Tag color="blue" style={{ textTransform: 'capitalize' }}>{v || '—'}</Tag> },
                      { title: 'Yedek Sayısı', dataIndex: 'backup_count', width: 100, sorter: (a: any, b: any) => Number(a.backup_count) - Number(b.backup_count) },
                      { title: 'Son Yedek', dataIndex: 'latest_backup', render: (v: string) => v ? <Tooltip title={dayjs(v).format('DD.MM.YYYY HH:mm')}><Text style={{ color: C.muted, fontSize: 12 }}>{dayjs(v).fromNow()}</Text></Tooltip> : '—' },
                      { title: 'Yaş (gün)', dataIndex: 'age_days', width: 100, render: (v: string) => v === '' ? '—' : <Text style={{ color: Number(v) > 7 ? C.warning : C.success, fontWeight: 600 }}>{v}</Text> },
                      {
                        title: 'Durum', dataIndex: 'status', width: 100,
                        render: (v: string) => (
                          <Tag color={v === 'ok' ? 'green' : v === 'stale' ? 'orange' : 'red'}>
                            {v === 'ok' ? 'Güncel' : v === 'stale' ? 'Bayat' : 'Hiç Yok'}
                          </Tag>
                        ),
                        filters: [
                          { text: 'Güncel', value: 'ok' }, { text: 'Bayat', value: 'stale' }, { text: 'Hiç Yok', value: 'never' },
                        ],
                        onFilter: (value: any, record: any) => record.status === value,
                      },
                    ]}
                  />
                </div>
              ),
            },
            {
              key: 'firmware',
              label: <span style={{ color: activeTab === 'firmware' ? C.primary : C.muted }}><CodeOutlined /> Firmware</span>,
              children: (
                <div style={{ padding: '16px 0 4px' }}>
                  {firmwareData && (
                    <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
                      <Col span={8}>
                        <div style={{ background: C.bg2, borderRadius: 8, padding: '12px 16px', textAlign: 'center' }}>
                          <div style={{ color: C.muted, fontSize: 12 }}>Toplam Cihaz</div>
                          <div style={{ color: C.text, fontSize: 20, fontWeight: 700 }}>{firmwareData.total_devices}</div>
                        </div>
                      </Col>
                      <Col span={8}>
                        <div style={{ background: C.bg2, borderRadius: 8, padding: '12px 16px', textAlign: 'center' }}>
                          <div style={{ color: C.muted, fontSize: 12 }}>Firmware Bilgisi Var</div>
                          <div style={{ color: C.success, fontSize: 20, fontWeight: 700 }}>{firmwareData.with_firmware_info}</div>
                        </div>
                      </Col>
                      <Col span={8}>
                        <div style={{ background: C.bg2, borderRadius: 8, padding: '12px 16px', textAlign: 'center' }}>
                          <div style={{ color: C.muted, fontSize: 12 }}>Bilgi Yok</div>
                          <div style={{ color: C.warning, fontSize: 20, fontWeight: 700 }}>{firmwareData.without_firmware_info}</div>
                        </div>
                      </Col>
                    </Row>
                  )}
                  <Table
                    dataSource={firmwareData?.groups}
                    loading={fwLoading}
                    rowKey={(r) => `${r.vendor}-${r.firmware_version}`}
                    size="small"
                    expandable={{
                      expandedRowRender: (record) => (
                        <div style={{ padding: '8px 0' }}>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                            {record.devices.map((d: any) => (
                              <div key={d.id} style={{ background: C.bg2, borderRadius: 6, padding: '4px 10px', fontSize: 12 }}>
                                <Badge status={d.status === 'online' ? 'success' : 'error'} />
                                {' '}{d.hostname} <Text style={{ color: C.dim, fontSize: 11 }}>({d.ip})</Text>
                              </div>
                            ))}
                          </div>
                        </div>
                      ),
                    }}
                    columns={[
                      { title: 'Vendor', dataIndex: 'vendor', render: (v: string) => <Tag color="blue" style={{ textTransform: 'capitalize' }}>{v}</Tag>, filters: Array.from(new Set(firmwareData?.groups.map((g) => g.vendor) || [])).map((v) => ({ text: v, value: v })), onFilter: (value: any, r: any) => r.vendor === value },
                      { title: 'Firmware Versiyonu', dataIndex: 'firmware_version', render: (v: string, r: any) => (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <code style={{ background: C.bg2, padding: '1px 6px', borderRadius: 4, fontSize: 12 }}>{v}</code>
                          {r.is_latest && <Tag color="green" style={{ fontSize: 11 }}>Güncel</Tag>}
                        </div>
                      )},
                      { title: 'Cihaz Sayısı', dataIndex: 'device_count', width: 110, sorter: (a: any, b: any) => a.device_count - b.device_count, render: (v: number) => (
                        <Text style={{ fontWeight: 600, color: C.text }}>{v}</Text>
                      )},
                      { title: 'Uyumluluk', width: 160, render: (_: any, r: any) => {
                        const total = firmwareData?.total_devices || 1
                        return <Progress percent={Math.round(r.device_count / total * 100)} size="small" strokeColor={r.is_latest ? '#22c55e' : '#f59e0b'} />
                      }},
                    ]}
                  />
                </div>
              ),
            },
            {
              key: 'uptime',
              label: <span style={{ color: activeTab === 'uptime' ? C.primary : C.muted }}><RiseOutlined /> Uptime Trendi</span>,
              children: (
                <div style={{ padding: '16px 0 4px' }}>
                  {uptimeData && (
                    <>
                      <Row gutter={[12, 12]} style={{ marginBottom: 20 }}>
                        <Col span={6}>
                          <div style={{ background: C.bg2, borderRadius: 8, padding: '12px 16px', textAlign: 'center' }}>
                            <div style={{ color: C.muted, fontSize: 12 }}>Toplam Cihaz</div>
                            <div style={{ color: C.text, fontSize: 20, fontWeight: 700 }}>{uptimeData.total_devices}</div>
                          </div>
                        </Col>
                        <Col span={6}>
                          <div style={{ background: C.bg2, borderRadius: 8, padding: '12px 16px', textAlign: 'center' }}>
                            <div style={{ color: C.muted, fontSize: 12 }}>Şu An Online</div>
                            <div style={{ color: C.success, fontSize: 20, fontWeight: 700 }}>{uptimeData.current_online}</div>
                          </div>
                        </Col>
                        <Col span={6}>
                          <div style={{ background: C.bg2, borderRadius: 8, padding: '12px 16px', textAlign: 'center' }}>
                            <div style={{ color: C.muted, fontSize: 12 }}>Şu An Offline</div>
                            <div style={{ color: C.danger, fontSize: 20, fontWeight: 700 }}>{uptimeData.current_offline}</div>
                          </div>
                        </Col>
                        <Col span={6}>
                          <div style={{ background: C.bg2, borderRadius: 8, padding: '12px 16px', textAlign: 'center' }}>
                            <div style={{ color: C.muted, fontSize: 12 }}>Ort. Uptime</div>
                            <div style={{ color: uptimeData.avg_uptime_pct >= 90 ? C.success : uptimeData.avg_uptime_pct >= 70 ? C.warning : C.danger, fontSize: 20, fontWeight: 700 }}>
                              %{uptimeData.avg_uptime_pct}
                            </div>
                          </div>
                        </Col>
                      </Row>
                      <UptimeBars daily={uptimeData.daily} muted={C.muted} />
                    </>
                  )}
                  {upLoading && <div style={{ textAlign: 'center', padding: 40, color: C.muted }}>Yükleniyor...</div>}
                </div>
              ),
            },
            {
              key: 'problematic',
              label: <span style={{ color: activeTab === 'problematic' ? C.primary : C.muted }}><WarningOutlined /> En Sorunlu</span>,
              children: (
                <div style={{ padding: '16px 0 4px' }}>
                  {problematicData && (
                    <div style={{ marginBottom: 12, display: 'flex', gap: 12 }}>
                      <div style={{ background: C.bg2, borderRadius: 8, padding: '10px 16px', textAlign: 'center', minWidth: 100 }}>
                        <div style={{ color: C.muted, fontSize: 12 }}>Analiz Edilen</div>
                        <div style={{ color: C.text, fontSize: 18, fontWeight: 700 }}>{problematicData.total}</div>
                      </div>
                      <div style={{ background: C.bg2, borderRadius: 8, padding: '10px 16px', textAlign: 'center', minWidth: 100 }}>
                        <div style={{ color: C.muted, fontSize: 12 }}>Süre</div>
                        <div style={{ color: C.text, fontSize: 18, fontWeight: 700 }}>{problematicData.days}g</div>
                      </div>
                    </div>
                  )}
                  <Table
                    dataSource={problematicData?.items ?? []}
                    rowKey="device_id"
                    loading={probLoading}
                    size="small"
                    pagination={{ pageSize: 20, showSizeChanger: false }}
                    columns={[
                      {
                        title: 'Sıra', width: 50,
                        render: (_: any, __: any, idx: number) => (
                          <span style={{ fontWeight: 700, color: idx === 0 ? C.danger : idx < 3 ? C.warning : C.muted }}>{idx + 1}</span>
                        ),
                      },
                      {
                        title: 'Cihaz', dataIndex: 'hostname',
                        render: (v: string, r: any) => (
                          <div>
                            <div style={{ fontWeight: 600, color: C.text }}>{v}</div>
                            <div style={{ fontSize: 11, color: C.muted }}>{r.ip_address || '—'}</div>
                          </div>
                        ),
                      },
                      {
                        title: 'Toplam Olay', dataIndex: 'event_count', width: 110, sorter: (a: any, b: any) => a.event_count - b.event_count,
                        render: (v: number) => <Tag color="red" style={{ fontWeight: 700, fontSize: 13 }}>{v}</Tag>,
                      },
                      {
                        title: 'Kritik', dataIndex: 'critical_count', width: 80,
                        render: (v: number) => v > 0 ? <Tag color="error">{v}</Tag> : <span style={{ color: C.dim }}>0</span>,
                      },
                      {
                        title: 'Uyarı', dataIndex: 'warning_count', width: 80,
                        render: (v: number) => v > 0 ? <Tag color="warning">{v}</Tag> : <span style={{ color: C.dim }}>0</span>,
                      },
                      {
                        title: 'Vendor', dataIndex: 'vendor', width: 90,
                        render: (v: string) => v ? <Tag color="blue" style={{ textTransform: 'capitalize' }}>{v}</Tag> : '—',
                      },
                      {
                        title: 'Durum', dataIndex: 'status', width: 90,
                        render: (v: string) => <Badge status={v === 'online' ? 'success' : v === 'offline' ? 'error' : 'default'} text={v} />,
                      },
                      {
                        title: 'Son Olay', dataIndex: 'last_event', width: 130,
                        render: (v: string) => v ? dayjs(v).format('DD.MM.YY HH:mm') : '—',
                      },
                    ]}
                  />
                </div>
              ),
            },
            {
              key: 'agent-health',
              label: <span style={{ color: activeTab === 'agent-health' ? C.primary : C.muted }}><CheckCircleOutlined /> Agent Sağlık</span>,
              children: (
                <div style={{ padding: '16px 0 4px' }}>
                  {agentHealthData && (
                    <div style={{ marginBottom: 12, display: 'flex', gap: 12 }}>
                      {[
                        { label: 'Toplam Agent', val: agentHealthData.total, color: C.primary },
                        { label: 'Online', val: agentHealthData.online, color: C.success },
                        { label: 'Offline', val: agentHealthData.offline, color: C.danger },
                      ].map(({ label, val, color }) => (
                        <div key={label} style={{ background: C.bg2, borderRadius: 8, padding: '10px 16px', textAlign: 'center', minWidth: 100 }}>
                          <div style={{ color: C.muted, fontSize: 12 }}>{label}</div>
                          <div style={{ color, fontSize: 18, fontWeight: 700 }}>{val}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  <Table
                    dataSource={agentHealthData?.items ?? []}
                    rowKey="id"
                    loading={agentHealthLoading}
                    size="small"
                    pagination={false}
                    columns={[
                      {
                        title: 'Agent', dataIndex: 'name',
                        render: (v: string, r: any) => (
                          <div>
                            <div style={{ fontWeight: 600, color: C.text }}>{v}</div>
                            <div style={{ fontSize: 11, color: C.muted }}>{r.machine_hostname || r.id}</div>
                          </div>
                        ),
                      },
                      {
                        title: 'Durum', dataIndex: 'status', width: 90,
                        render: (v: string) => <Badge status={v === 'online' ? 'success' : 'error'} text={v === 'online' ? 'Online' : 'Offline'} />,
                      },
                      {
                        title: 'Son Heartbeat', dataIndex: 'heartbeat_age_s', width: 130,
                        render: (v: number | null, r: any) => {
                          if (!r.last_heartbeat) return <span style={{ color: C.dim }}>—</span>
                          if (v == null) return dayjs(r.last_heartbeat).format('DD.MM.YY HH:mm')
                          const mins = Math.floor(v / 60)
                          const color = v < 120 ? C.success : v < 600 ? C.warning : C.danger
                          return <span style={{ color }}>{mins < 1 ? `${v}s` : `${mins}d`} önce</span>
                        },
                      },
                      {
                        title: 'CPU / RAM', width: 160,
                        render: (_: any, r: any) => r.cpu_pct != null ? (
                          <Space size={4}>
                            <Progress type="circle" percent={Math.round(r.cpu_pct)} width={32} strokeColor={r.cpu_pct > 80 ? '#ef4444' : '#3b82f6'} format={(p) => <span style={{ fontSize: 9 }}>{p}%</span>} />
                            <Progress type="circle" percent={Math.round(r.mem_pct ?? 0)} width={32} strokeColor={r.mem_pct > 80 ? '#ef4444' : '#22c55e'} format={(p) => <span style={{ fontSize: 9 }}>{p}%</span>} />
                          </Space>
                        ) : <span style={{ color: C.dim }}>—</span>,
                      },
                      {
                        title: 'Komut Başarı/Hata', width: 140,
                        render: (_: any, r: any) => (
                          <span style={{ fontSize: 12 }}>
                            <span style={{ color: C.success, fontWeight: 600 }}>{r.cmd_success}</span>
                            <span style={{ color: C.dim }}> / </span>
                            <span style={{ color: r.cmd_fail > 0 ? C.danger : C.dim, fontWeight: r.cmd_fail > 0 ? 600 : 400 }}>{r.cmd_fail}</span>
                          </span>
                        ),
                      },
                      {
                        title: 'Ort. Gecikme', dataIndex: 'avg_latency_ms', width: 110,
                        render: (v: number | null) => v != null
                          ? <span style={{ color: v > 500 ? C.warning : C.success }}>{v.toFixed(0)} ms</span>
                          : <span style={{ color: C.dim }}>—</span>,
                      },
                      {
                        title: 'Cihaz', dataIndex: 'assigned_devices', width: 70,
                        render: (v: number) => <Tag>{v}</Tag>,
                      },
                      {
                        title: 'Versiyon', dataIndex: 'version', width: 80,
                        render: (v: string) => v ? <Tag color="geekblue">{v}</Tag> : <span style={{ color: C.dim }}>—</span>,
                      },
                    ]}
                  />
                </div>
              ),
            },
          ]}
        />
      </div>
    </div>
  )
}
