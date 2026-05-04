import { useState, useRef, useEffect, useMemo } from 'react'
import { Button, Input, Spin, Empty, Avatar, Tooltip, Tag } from 'antd'
import { useIsMobile } from '@/hooks/useIsMobile'
import {
  SendOutlined, RobotOutlined, UserOutlined, ClearOutlined,
  ThunderboltOutlined, CopyOutlined, CheckOutlined,
  AlertOutlined, DashboardOutlined, ApartmentOutlined,
  SafetyOutlined, BarChartOutlined, PlayCircleOutlined,
  BranchesOutlined, AimOutlined, ReloadOutlined, DownloadOutlined,
} from '@ant-design/icons'
import { useMutation, useQuery } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { aiAssistantApi, type ChatMessage } from '@/api/aiAssistant'
import { monitorApi } from '@/api/monitor'
import { useTheme } from '@/contexts/ThemeContext'
import { useNavigate } from 'react-router-dom'

/* ─── theme ─────────────────────────────────────────────────────────────── */
function mkC(isDark: boolean) {
  return {
    bg:       isDark ? '#030c1e' : '#f0f5fb',
    panel:    isDark ? '#07111f' : '#ffffff',
    card:     isDark ? '#0f172a' : '#f8fafc',
    border:   isDark ? '#1a3050' : '#e2e8f0',
    text:     isDark ? '#f1f5f9' : '#1e293b',
    muted:    isDark ? '#64748b' : '#94a3b8',
    userBg:   isDark ? '#1e40af' : '#dbeafe',
    userText: isDark ? '#e0f2fe' : '#1e3a8a',
    codeBg:   isDark ? '#0a1628' : '#f1f5f9',
    errBg:    isDark ? '#3b1212' : '#fee2e2',
    accent:   '#3b82f6',
  }
}

const PROVIDER_COLORS: Record<string, string> = {
  claude: '#cc785c', openai: '#10a37f', gemini: '#4285f4', ollama: '#7c3aed',
}
const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude', openai: 'OpenAI', gemini: 'Gemini', ollama: 'Ollama',
}

/* ─── modes ─────────────────────────────────────────────────────────────── */
const MODES = [
  { key: 'analyze',      label: 'Analiz',       icon: '🔍', color: '#3b82f6' },
  { key: 'troubleshoot', label: 'Sorun Gider',  icon: '🛠️', color: '#f59e0b' },
  { key: 'automate',    label: 'Otomasyon',    icon: '🤖', color: '#8b5cf6' },
  { key: 'security',    label: 'Güvenlik',     icon: '🛡️', color: '#ef4444' },
] as const
type Mode = typeof MODES[number]['key']

/* ─── suggested questions — dynamic, built inside component ─────────────── */
type SuggestedItem = { label: string; q: string }
function buildSuggested(
  mode: Mode,
  offline: number,
  unacked: number,
  health: number,
  criticalEvents: { title: string; device_hostname?: string | null }[],
): SuggestedItem[] {
  const firstCrit = criticalEvents[0]
  const critDevice = firstCrit?.device_hostname ?? 'kritik cihaz'
  switch (mode) {
    case 'analyze':
      return [
        offline > 0
          ? { label: `${offline} cihaz offline — kök neden?`, q: `Ağda ${offline} cihaz offline. Offline süreleri, konumları ve kök nedenini analiz et. En kritik olanı hangisi?` }
          : { label: 'Genel durum analizi', q: 'Ağın genel durumunu ve potansiyel riskleri analiz et.' },
        unacked > 0
          ? { label: `${unacked} aktif uyarı — öncelikli hangisi?`, q: `Sistemde ${unacked} onaylanmamış uyarı var. En kritiklerini öncelik sırasıyla listele ve ne yapmalıyım?` }
          : { label: 'Anomali taraması', q: 'Son 24 saatte anormal bir davranış veya topoloji değişikliği var mı?' },
        health < 80
          ? { label: `Sağlık skoru ${health}/100 — nasıl iyileşir?`, q: `Ağ sağlık skoru ${health}/100. Bu skoru düşüren faktörler neler ve nasıl iyileştirebilirim?` }
          : { label: 'Proaktif risk analizi', q: 'Şu an kritik sorun olmasa da gelecekte risk oluşturabilecek durumlar var mı?' },
        firstCrit
          ? { label: `Son kritik: ${critDevice}`, q: `${firstCrit.title} — bu olayı detaylıca analiz et ve etkisini değerlendir.` }
          : { label: 'Son 24 saat özeti', q: 'Son 24 saatte neler oldu? Dikkat çekmesi gereken bir durum var mı?' },
        { label: 'Topoloji bütünlüğü', q: 'Ağ topolojisinde beklenmedik değişiklik veya bağlantı kopması var mı?' },
        { label: 'Performans trendi', q: 'Son 6 saat ile önceki 6 saati karşılaştır — durum kötüleşiyor mu?' },
      ]
    case 'troubleshoot':
      return [
        offline > 0
          ? { label: `${offline} offline cihaz — adım adım çöz`, q: `${offline} cihaz offline. Olay zaman çizelgesine bakarak kök nedeni bul ve NetManager üzerinden adım adım çözüm yolunu göster.` }
          : { label: 'Periyodik bağlantı kopmaları', q: 'Son 24 saatte tekrarlayan bağlantı kopması yaşayan cihazlar var mı?' },
        { label: 'VLAN yapılandırma sorunu', q: 'VLAN yapılandırmasında tutarsızlık veya yanlış atama var mı? Etkilenen cihazlar hangileri?' },
        { label: 'STP / loop riski', q: 'Spanning-tree anomalisi veya loop riski var mı? Hangi portları kontrol etmeliyim?' },
        { label: 'Agent erişim sorunu', q: 'Agent üzerinden erişilemeyen cihazlar var mı? Agent sağlığını kontrol et.' },
      ]
    case 'automate':
      return [
        { label: 'Acil playbook öner', q: 'Mevcut durumdaki sorunlar için hangi playbook\'ları hemen çalıştırmalıyım?' },
        offline > 0
          ? { label: `${offline} offline için otomatik aksiyon`, q: `${offline} offline cihaz var. Bu cihazlar için otomatik tetiklenen bir playbook mevcut mu? Yoksa nasıl oluşturabilirim?` }
          : { label: 'Playbook ekle', q: 'Mevcut ağ durumu için hangi yeni playbook\'ları oluşturmalıyım?' },
        { label: 'Yedekleme kapsamı', q: 'Son 7 günde hangi cihazların yedeği alınmamış? Bu cihazları kapsayacak schedule nasıl oluşturabilirim?' },
        { label: 'Alert kuralı ekle', q: 'Mevcut sorunlar için eksik alert kuralları neler? Hangi metrikleri izlemeliyim?' },
      ]
    case 'security':
      return [
        offline > 0
          ? { label: `${offline} offline — fiziksel müdahale riski?`, q: `${offline} cihaz offline. Bu cihazların konumları ve offline süreleri güvenlik açısından risk oluşturuyor mu?` }
          : { label: 'Güvenlik taraması', q: 'Sistemde güvenlik açığı veya şüpheli aktivite var mı?' },
        { label: 'MAC/ARP anomalisi', q: 'Son 24 saatte MAC anomalisi veya yetkisiz cihaz bağlantısı var mı?' },
        { label: 'Yetkisiz erişim girişimi', q: 'SNMP veya SSH üzerinden yetkisiz erişim girişimi tespit edildi mi?' },
        { label: 'Compliance durumu', q: 'Uyumluluk açısından hangi cihazlar politikayı ihlal ediyor?' },
      ]
  }
}

/* ─── quick actions ─────────────────────────────────────────────────────── */
const QUICK_ACTIONS = [
  { icon: <AimOutlined />,        label: 'Diagnostics',    sub: 'Tanılama çalıştır',       path: '/diagnostics',       color: '#3b82f6' },
  { icon: <AlertOutlined />,      label: 'Olaylar',        sub: 'Aktif uyarılara git',     path: '/monitor',           color: '#ef4444' },
  { icon: <PlayCircleOutlined />, label: 'Playbook',       sub: 'Hazır playbook çalıştır', path: '/playbooks',         color: '#8b5cf6' },
  { icon: <BranchesOutlined />,   label: 'VLAN',           sub: 'VLAN yönetimine git',     path: '/vlan',              color: '#f59e0b' },
  { icon: <BarChartOutlined />,   label: 'Raporlar',       sub: 'Analiz raporu aç',        path: '/reports',           color: '#10a37f' },
  { icon: <SafetyOutlined />,     label: 'Güvenlik',       sub: 'Güvenlik denetimi',       path: '/security-audit',    color: '#ec4899' },
  { icon: <ApartmentOutlined />,  label: 'Topoloji',       sub: 'Ağ haritasını aç',        path: '/topology',          color: '#6366f1' },
  { icon: <DashboardOutlined />,  label: 'Dashboard',      sub: 'Ana ekrana dön',          path: '/',                  color: '#64748b' },
]

/* ─── storage ────────────────────────────────────────────────────────────── */
const STORAGE_KEY = 'ai_chat_v2'
const MAX_STORED  = 100

interface DisplayMessage extends ChatMessage {
  id: number
  provider?: string
  model?: string
  error?: boolean
  mode?: Mode
}

let _id = 0
const nextId = () => ++_id

function loadMessages(): DisplayMessage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const msgs = JSON.parse(raw) as DisplayMessage[]
    const maxId = msgs.reduce((m, x) => Math.max(m, x.id), 0)
    _id = maxId
    return msgs
  } catch { return [] }
}
function saveMessages(msgs: DisplayMessage[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(msgs.slice(-MAX_STORED))) } catch { }
}

/* ─── markdown renderer ─────────────────────────────────────────────────── */
function MdContent({ content, isDark, C }: { content: string; isDark: boolean; C: ReturnType<typeof mkC> }) {
  const sectionColors: Record<string, string> = {
    '🔍': '#3b82f6', '🎯': '#f59e0b', '📊': '#8b5cf6', '⚠️': '#ef4444', '✅': '#22c55e',
    '🛠️': '#f59e0b', '📋': '#6366f1', '💻': '#0ea5e9', '🔄': '#10a37f',
    '🤖': '#8b5cf6', '📜': '#6366f1', '⚙️': '#64748b',
    '🛡️': '#ef4444', '🚨': '#dc2626', '🔒': '#7c3aed', '📌': '#f97316',
  }

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h2: ({ children }) => {
          const text = String(children)
          const emoji = text.match(/^\p{Emoji}/u)?.[0] ?? ''
          const color = sectionColors[emoji] ?? C.accent
          return (
            <div style={{
              background: `${color}18`,
              border: `1px solid ${color}40`,
              borderLeft: `3px solid ${color}`,
              borderRadius: 8,
              padding: '8px 12px',
              margin: '12px 0 6px',
              color,
              fontWeight: 700,
              fontSize: 13,
            }}>{children}</div>
          )
        },
        h3: ({ children }) => (
          <div style={{ fontWeight: 600, fontSize: 13, margin: '10px 0 4px', color: C.text }}>{children}</div>
        ),
        p: ({ children }) => <p style={{ margin: '0 0 8px', lineHeight: 1.65 }}>{children}</p>,
        strong: ({ children }) => (
          <strong style={{ color: isDark ? '#93c5fd' : '#1d4ed8', fontWeight: 600 }}>{children}</strong>
        ),
        ul: ({ children }) => <ul style={{ margin: '4px 0 8px', paddingLeft: 20, lineHeight: 1.7 }}>{children}</ul>,
        ol: ({ children }) => <ol style={{ margin: '4px 0 8px', paddingLeft: 20, lineHeight: 1.7 }}>{children}</ol>,
        li: ({ children }) => <li style={{ marginBottom: 3 }}>{children}</li>,
        code: ({ children, className }) => {
          const isBlock = !!className?.includes('language-')
          return isBlock ? (
            <code style={{
              display: 'block', background: C.codeBg, border: `1px solid ${C.border}`,
              borderRadius: 6, padding: '10px 14px', fontSize: 12,
              fontFamily: 'monospace', overflowX: 'auto', margin: '8px 0', whiteSpace: 'pre',
            }}>{children}</code>
          ) : (
            <code style={{
              background: C.codeBg, border: `1px solid ${C.border}`, borderRadius: 4,
              padding: '1px 6px', fontSize: 12, fontFamily: 'monospace',
            }}>{children}</code>
          )
        },
        pre: ({ children }) => <>{children}</>,
        blockquote: ({ children }) => (
          <blockquote style={{
            borderLeft: `3px solid ${C.accent}`, margin: '8px 0', paddingLeft: 12,
            color: C.muted, fontStyle: 'italic',
          }}>{children}</blockquote>
        ),
        hr: () => <hr style={{ border: 'none', borderTop: `1px solid ${C.border}`, margin: '10px 0' }} />,
      }}
    >
      {content}
    </ReactMarkdown>
  )
}

/* ─── severity helpers ──────────────────────────────────────────────────── */
const SEV_COLOR: Record<string, string> = {
  critical: '#ef4444', warning: '#f59e0b', info: '#3b82f6',
}
const SEV_LABEL: Record<string, string> = {
  critical: 'Kritik', warning: 'Uyarı', info: 'Bilgi',
}

/* ─── page ──────────────────────────────────────────────────────────────── */
export default function AIAssistantPage() {
  const { isDark } = useTheme()
  const C = mkC(isDark)
  const navigate = useNavigate()
  const isMobile = useIsMobile()

  const [input, setInput]       = useState('')
  const [mode, setMode]         = useState<Mode>('analyze')
  const [messages, setMessages] = useState<DisplayMessage[]>(() => loadMessages())
  const [copiedId, setCopiedId] = useState<number | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  /* persist */
  useEffect(() => { saveMessages(messages) }, [messages])
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  /* data */
  const { data: settings, isLoading: settingsLoading } = useQuery({
    queryKey: ['ai-settings'], queryFn: aiAssistantApi.getSettings,
  })
  const { data: stats, dataUpdatedAt, refetch: refetchStats } = useQuery({
    queryKey: ['monitor-stats'], queryFn: () => monitorApi.getStats(),
    refetchInterval: 30_000,
  })
  const { data: eventsData } = useQuery({
    queryKey: ['ai-events'],
    queryFn: () => monitorApi.getEvents({ limit: 6, severity: 'critical,warning', hours: 24 }),
    refetchInterval: 30_000,
  })

  const lastUpdate = useMemo(() => {
    if (!dataUpdatedAt) return '—'
    const sec = Math.floor((Date.now() - dataUpdatedAt) / 1000)
    if (sec < 60) return `${sec}s önce`
    return `${Math.floor(sec / 60)}dk önce`
  }, [dataUpdatedAt, messages]) // refresh label on any render

  /* chat */
  const chatMut = useMutation<import('@/api/aiAssistant').ChatResponse, Error, ChatMessage[]>({
    mutationFn: (msgs) => aiAssistantApi.chat(msgs, mode),
    onSuccess: (data) => {
      setMessages(prev => [...prev, {
        id: nextId(), role: 'assistant',
        content: data.message, provider: data.provider, model: data.model, mode,
      }])
    },
    onError: (err: any) => {
      const detail = err?.response?.data?.detail || 'Bilinmeyen hata'
      setMessages(prev => [...prev, { id: nextId(), role: 'assistant', content: `Hata: ${detail}`, error: true }])
    },
  })

  const send = (text?: string) => {
    const content = (text ?? input).trim()
    if (!content || chatMut.isPending) return
    const newMsg: DisplayMessage = { id: nextId(), role: 'user', content, mode }
    const allMsgs = [...messages, newMsg]
    setMessages(allMsgs)
    setInput('')
    chatMut.mutate(allMsgs.filter(m => !m.error).map(m => ({ role: m.role, content: m.content })))
  }

  const copyMsg = (msg: DisplayMessage) => {
    navigator.clipboard.writeText(msg.content)
    setCopiedId(msg.id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const clearChat = () => { setMessages([]); localStorage.removeItem(STORAGE_KEY) }

  const exportChat = () => {
    const now = new Date()
    const dateStr = now.toLocaleDateString('tr-TR', { year: 'numeric', month: 'long', day: 'numeric' })
    const timeStr = now.toLocaleTimeString('tr-TR')

    let md = `# NetManager AI Analiz Raporu\n\n`
    md += `| | |\n|---|---|\n`
    md += `| **Tarih** | ${dateStr} ${timeStr} |\n`
    md += `| **Mod** | ${currentMode.icon} ${currentMode.label} |\n`
    md += `| **Ağ Durumu** | ${online} online · ${offline} offline · Sağlık ${health}/100 |\n`
    if (providerLabel) md += `| **AI Sağlayıcı** | ${providerLabel} |\n`
    md += `\n---\n\n`

    messages.forEach(msg => {
      if (msg.role === 'user') {
        md += `### 💬 Kullanıcı\n\n${msg.content}\n\n`
      } else if (msg.role === 'assistant' && !msg.error) {
        const mLabel = MODES.find(m => m.key === msg.mode)?.label ?? ''
        const prov = msg.provider ? ` · ${PROVIDER_LABELS[msg.provider] ?? msg.provider}` : ''
        md += `### 🤖 AI Yanıtı${mLabel ? ` (${mLabel})` : ''}${prov}\n\n${msg.content}\n\n`
      }
      md += `---\n\n`
    })

    md += `*NetManager tarafından oluşturuldu — ${now.toISOString()}*\n`

    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `netmanager-ai-raporu-${now.toISOString().slice(0, 10)}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  const isConfigured = settings?.active_provider && (
    settings.active_provider === 'ollama' ||
    (settings.active_provider === 'claude'  && settings.claude_configured) ||
    (settings.active_provider === 'openai'  && settings.openai_configured) ||
    (settings.active_provider === 'gemini'  && settings.gemini_configured)
  )
  const providerColor = settings?.active_provider ? (PROVIDER_COLORS[settings.active_provider] ?? '#64748b') : '#64748b'
  const providerLabel = settings?.active_provider ? (PROVIDER_LABELS[settings.active_provider] ?? settings.active_provider) : null
  const currentMode   = MODES.find(m => m.key === mode)!

  const offline  = stats?.devices.offline ?? 0
  const online   = stats?.devices.online ?? 0
  const total    = stats?.devices.total ?? 0
  const unacked  = stats?.events_24h.unacknowledged ?? 0
  const health   = stats?.health_score ?? 0
  const healthColor = health >= 80 ? '#22c55e' : health >= 50 ? '#f59e0b' : '#ef4444'
  const criticalEvents = eventsData?.items?.filter(e => e.severity === 'critical') ?? []
  const hasCritical    = criticalEvents.length > 0 || offline > 0

  /* dynamic suggested questions */
  const suggested = useMemo(
    () => buildSuggested(mode, offline, unacked, health, criticalEvents),
    [mode, offline, unacked, health, criticalEvents.length] // eslint-disable-line
  )

  /* proactive auto-analysis: on first mount when there are issues and no chat history */
  const proactiveTriggered = useRef(false)
  useEffect(() => {
    // wait until both settings AND stats have loaded
    if (proactiveTriggered.current || messages.length > 0) return
    if (!isConfigured || settingsLoading || !stats) return
    if (!offline && !unacked) return
    proactiveTriggered.current = true
    const timer = setTimeout(() => {
      const q = offline > 0
        ? `Proaktif analiz: Ağda ${offline} offline cihaz ve ${unacked} aktif uyarı var. Durumu değerlendir, en kritik sorunu ve yapılması gerekeni söyle.`
        : `Proaktif analiz: ${unacked} aktif uyarı var. Bunları öncelik sırasıyla analiz et ve acil aksiyon gerektiren var mı söyle.`
      send(q)
    }, 1800)
    return () => clearTimeout(timer)
  }, [isConfigured, settingsLoading, stats]) // re-run when stats arrive

  const contentPadH = isMobile ? 14 : 24
  const contentPadV = isMobile ? 12 : 20

  return (
    <div style={{
      display: 'flex',
      height: `calc(100vh - 60px)`,
      margin: `-${contentPadV}px -${contentPadH}px`,
      background: C.bg,
      overflow: 'hidden',
    }}>

      {/* ── LEFT PANEL ─────────────────────────────────────────────────── */}
      {!isMobile && <div style={{
        width: 230, flexShrink: 0, background: C.panel,
        borderRight: `1px solid ${C.border}`,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        {/* header */}
        <div style={{
          padding: '14px 14px 10px', borderBottom: `1px solid ${C.border}`, flexShrink: 0,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <div style={{
            width: 28, height: 28, borderRadius: 8,
            background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <RobotOutlined style={{ color: '#fff', fontSize: 13 }} />
          </div>
          <div>
            <div style={{ color: C.text, fontWeight: 700, fontSize: 13 }}>AI Asistanı</div>
            <div style={{ fontSize: 10, color: providerColor }}>
              {providerLabel ? `● ${providerLabel} Pro aktif` : '● Yapılandırılmamış'}
            </div>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 14 }}>

          {/* CANLI İÇGÖRÜLER */}
          <div>
            <div style={{ color: C.muted, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', marginBottom: 6 }}>
              CANLI İÇGÖRÜLER
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {[
                { val: offline, label: 'Cihaz Offline', color: offline > 0 ? '#ef4444' : '#22c55e', icon: '📡' },
                { val: unacked, label: 'Aktif Uyarı',   color: unacked > 0 ? '#f59e0b' : '#22c55e', icon: '⚠️' },
                { val: online,  label: 'Online Cihaz',  color: '#22c55e',                             icon: '✅' },
              ].map(item => (
                <div key={item.label} style={{
                  background: C.card, border: `1px solid ${C.border}`,
                  borderRadius: 8, padding: '6px 10px',
                  display: 'flex', alignItems: 'center', gap: 8,
                }}>
                  <div style={{
                    fontSize: 18, fontWeight: 800, color: item.color, minWidth: 28, lineHeight: 1,
                  }}>{item.val}</div>
                  <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.3 }}>{item.label}</div>
                </div>
              ))}
              {/* health score */}
              <div style={{
                background: C.card, border: `1px solid ${C.border}`,
                borderRadius: 8, padding: '6px 10px',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: 11, color: C.muted }}>Ağ Sağlığı</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: healthColor }}>{health}/100</span>
                </div>
                <div style={{ background: C.border, borderRadius: 4, height: 4, overflow: 'hidden' }}>
                  <div style={{ background: healthColor, width: `${health}%`, height: '100%', transition: 'width 1s' }} />
                </div>
              </div>
            </div>
          </div>

          {/* AKTİF OLAYLAR */}
          <div>
            <div style={{ color: C.muted, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', marginBottom: 6 }}>
              AKTİF OLAYLAR
            </div>
            {eventsData?.items.length ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {eventsData.items.slice(0, 5).map(ev => (
                  <div key={ev.id} style={{
                    background: C.card, border: `1px solid ${C.border}`,
                    borderRadius: 6, padding: '5px 8px',
                    borderLeft: `2px solid ${SEV_COLOR[ev.severity] ?? '#64748b'}`,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 10, fontWeight: 600, color: SEV_COLOR[ev.severity] }}>
                        {SEV_LABEL[ev.severity] ?? ev.severity}
                      </span>
                      {!ev.acknowledged && (
                        <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#ef4444' }} />
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: C.text, marginTop: 1, lineHeight: 1.3 }}>
                      {ev.title.length > 36 ? ev.title.slice(0, 36) + '…' : ev.title}
                    </div>
                    {ev.device_hostname && (
                      <div style={{ fontSize: 10, color: C.muted, marginTop: 1 }}>{ev.device_hostname}</div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ color: C.muted, fontSize: 11, textAlign: 'center', padding: '8px 0' }}>
                Aktif olay yok ✓
              </div>
            )}
          </div>

          {/* ÖNERİLEN SORULAR */}
          <div>
            <div style={{ color: C.muted, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', marginBottom: 6 }}>
              ÖNERİLEN SORULAR
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {suggested.map(s => (
                <button
                  key={s.label}
                  onClick={() => send(s.q)}
                  disabled={chatMut.isPending}
                  style={{
                    background: 'transparent', border: `1px solid ${C.border}`,
                    borderRadius: 6, padding: '5px 8px', cursor: chatMut.isPending ? 'not-allowed' : 'pointer',
                    textAlign: 'left', color: C.text, fontSize: 11,
                    transition: 'all 0.12s', opacity: chatMut.isPending ? 0.5 : 1,
                    display: 'flex', alignItems: 'center', gap: 4,
                  }}
                  onMouseEnter={e => { if (!chatMut.isPending) (e.currentTarget as HTMLElement).style.background = isDark ? '#0e1e38' : '#eff6ff' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                >
                  <span>›</span>
                  <span>{s.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* KAYDEDİLEN SORGULAR */}
          {messages.filter(m => m.role === 'user').length > 0 && (
            <div>
              <div style={{ color: C.muted, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', marginBottom: 6 }}>
                KAYDEDİLEN SORGULAR
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {[...new Set(messages.filter(m => m.role === 'user').map(m => m.content))].slice(-5).reverse().map(q => (
                  <button
                    key={q}
                    onClick={() => send(q)}
                    disabled={chatMut.isPending}
                    style={{
                      background: 'transparent', border: `1px solid ${C.border}`,
                      borderRadius: 6, padding: '5px 8px', cursor: chatMut.isPending ? 'not-allowed' : 'pointer',
                      textAlign: 'left', color: C.muted, fontSize: 10,
                      opacity: chatMut.isPending ? 0.5 : 1,
                    }}
                  >
                    {q.length > 42 ? q.slice(0, 42) + '…' : q}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>}

      {/* ── CENTER ─────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* top bar */}
        <div style={{
          flexShrink: 0, padding: '10px 20px',
          borderBottom: `1px solid ${C.border}`,
          background: C.panel,
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          {/* mode tabs */}
          <div style={{ display: 'flex', gap: 4, background: C.card, borderRadius: 10, padding: 3 }}>
            {MODES.map(m => (
              <button
                key={m.key}
                onClick={() => setMode(m.key)}
                style={{
                  background: mode === m.key ? m.color : 'transparent',
                  border: 'none', borderRadius: 7, padding: '5px 12px',
                  cursor: 'pointer', color: mode === m.key ? '#fff' : C.muted,
                  fontSize: 12, fontWeight: mode === m.key ? 600 : 400,
                  transition: 'all 0.15s', display: 'flex', alignItems: 'center', gap: 4,
                }}
              >
                <span>{m.icon}</span>
                <span>{m.label}</span>
              </button>
            ))}
          </div>

          {/* Proaktif Tarama button */}
          <Tooltip title="Mevcut ağ durumunu AI ile otomatik analiz et">
            <Button
              size="small"
              icon={<ThunderboltOutlined />}
              onClick={() => {
                const q = `Proaktif tam analiz: Sistemin anlık durumunu değerlendir. Offline cihazlar, aktif uyarılar, anomaliler ve trend dahil — en kritik noktayı öne çıkar ve ne yapmalıyım söyle.`
                send(q)
              }}
              disabled={chatMut.isPending}
              style={{
                background: `${currentMode.color}20`,
                border: `1px solid ${currentMode.color}60`,
                color: currentMode.color,
                borderRadius: 7, fontSize: 11, fontWeight: 600,
              }}
            >
              {!isMobile && 'Proaktif Tarama'}
            </Button>
          </Tooltip>

          {/* data status */}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, color: C.muted }}>Son güncelleme: {lastUpdate}</span>
            <Tooltip title="Veriyi yenile">
              <Button
                type="text" size="small"
                icon={<ReloadOutlined style={{ fontSize: 11 }} />}
                onClick={() => refetchStats()}
                style={{ color: C.muted, padding: '0 4px' }}
              />
            </Tooltip>
            {messages.length > 0 && (
              <>
                <Tooltip title="Rapor olarak indir (.md)">
                  <Button type="text" size="small" icon={<DownloadOutlined style={{ fontSize: 11 }} />}
                    onClick={exportChat} style={{ color: C.muted, padding: '0 4px' }} />
                </Tooltip>
                <Tooltip title="Geçmişi temizle">
                  <Button type="text" size="small" icon={<ClearOutlined style={{ fontSize: 11 }} />}
                    onClick={clearChat} style={{ color: C.muted, padding: '0 4px' }} />
                </Tooltip>
              </>
            )}
            <Tooltip title="AI Ayarları">
              <Button type="text" size="small" icon={<ThunderboltOutlined style={{ fontSize: 11 }} />}
                onClick={() => navigate('/settings?tab=ai')} style={{ color: C.muted, padding: '0 4px' }} />
            </Tooltip>
          </div>
        </div>

        {/* messages */}
        {settingsLoading ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Spin />
          </div>
        ) : !isConfigured ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={<span style={{ color: C.muted }}>AI asistanı kullanmak için önce bir sağlayıcı yapılandırın.</span>}
            />
            <Button type="primary" onClick={() => navigate('/settings?tab=ai')}>Sağlayıcı Ayarla</Button>
          </div>
        ) : (
          <>
            {/* ── Critical alert banner ───────────────────────────────────── */}
            {hasCritical && messages.length === 0 && !chatMut.isPending && (
              <div style={{
                flexShrink: 0,
                background: isDark ? '#1a0a0a' : '#fff5f5',
                borderBottom: `1px solid #ef444440`,
                padding: '8px 24px',
                display: 'flex', alignItems: 'center', gap: 10,
              }}>
                <span style={{ fontSize: 14 }}>🚨</span>
                <span style={{ fontSize: 12, color: '#ef4444', fontWeight: 600 }}>
                  {offline > 0 && `${offline} cihaz offline`}
                  {offline > 0 && unacked > 0 && ' · '}
                  {unacked > 0 && `${unacked} onaylanmamış uyarı`}
                </span>
                <span style={{ fontSize: 11, color: C.muted }}>— AI otomatik analiz başlatılıyor…</span>
              </div>
            )}

            <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
              {messages.length === 0 && (
                <div style={{
                  flex: 1, display: 'flex', flexDirection: 'column',
                  alignItems: 'center', justifyContent: 'center',
                  color: C.muted, gap: 10, paddingTop: 80,
                }}>
                  <span style={{ fontSize: 40 }}>{currentMode.icon}</span>
                  <div style={{ fontWeight: 600, color: C.text }}>{currentMode.label} Modu</div>
                  <div style={{ fontSize: 12 }}>Soldan bir soru seçin veya yazın</div>
                </div>
              )}

              {messages.map(msg => (
                <div key={msg.id} style={{
                  display: 'flex',
                  flexDirection: msg.role === 'user' ? 'row-reverse' : 'row',
                  gap: 10, alignItems: 'flex-start',
                }}>
                  <Avatar
                    size={34}
                    style={{
                      background: msg.role === 'user'
                        ? (isDark ? '#1d4ed8' : '#3b82f6')
                        : (msg.provider ? PROVIDER_COLORS[msg.provider] ?? '#6366f1' : '#6366f1'),
                      flexShrink: 0,
                    }}
                    icon={msg.role === 'user' ? <UserOutlined /> : <RobotOutlined />}
                  />
                  <div style={{ maxWidth: '80%' }}>
                    {msg.mode && msg.role === 'assistant' && (
                      <div style={{ marginBottom: 4 }}>
                        <Tag style={{
                          fontSize: 10, lineHeight: '16px', padding: '0 6px',
                          background: `${MODES.find(m => m.key === msg.mode)?.color ?? C.accent}22`,
                          border: `1px solid ${MODES.find(m => m.key === msg.mode)?.color ?? C.accent}44`,
                          color: MODES.find(m => m.key === msg.mode)?.color ?? C.accent,
                          borderRadius: 4,
                        }}>
                          {MODES.find(m => m.key === msg.mode)?.icon} {MODES.find(m => m.key === msg.mode)?.label}
                        </Tag>
                      </div>
                    )}
                    <div style={{
                      background: msg.role === 'user' ? C.userBg : (msg.error ? C.errBg : C.panel),
                      border: `1px solid ${msg.role === 'user' ? 'transparent' : (msg.error ? '#f87171' : C.border)}`,
                      borderRadius: msg.role === 'user' ? '16px 4px 16px 16px' : '4px 16px 16px 16px',
                      padding: '10px 14px',
                      color: msg.role === 'user' ? C.userText : C.text,
                      fontSize: 13,
                      boxShadow: isDark ? '0 2px 8px rgba(0,0,0,0.25)' : '0 1px 4px rgba(0,0,0,0.06)',
                    }}>
                      {msg.role === 'user'
                        ? <span style={{ lineHeight: 1.6 }}>{msg.content}</span>
                        : <MdContent content={msg.content} isDark={isDark} C={C} />
                      }
                    </div>
                    <div style={{
                      display: 'flex', gap: 6, marginTop: 4,
                      justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
                      alignItems: 'center',
                    }}>
                      {msg.provider && (
                        <span style={{ fontSize: 10, color: C.muted }}>
                          {PROVIDER_LABELS[msg.provider] ?? msg.provider}
                          {msg.model ? ` · ${msg.model}` : ''}
                        </span>
                      )}
                      {msg.role === 'assistant' && !msg.error && (
                        <Tooltip title={copiedId === msg.id ? 'Kopyalandı!' : 'Kopyala'}>
                          <Button type="text" size="small"
                            icon={copiedId === msg.id
                              ? <CheckOutlined style={{ color: '#22c55e', fontSize: 11 }} />
                              : <CopyOutlined style={{ fontSize: 11 }} />}
                            onClick={() => copyMsg(msg)}
                            style={{ color: C.muted, padding: '0 4px', height: 18 }}
                          />
                        </Tooltip>
                      )}
                    </div>
                  </div>
                </div>
              ))}

              {chatMut.isPending && (
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <Avatar size={34} style={{ background: '#6366f1', flexShrink: 0 }} icon={<RobotOutlined />} />
                  <div style={{
                    background: C.panel, border: `1px solid ${C.border}`,
                    borderRadius: '4px 16px 16px 16px', padding: '10px 16px',
                    display: 'flex', alignItems: 'center', gap: 8,
                  }}>
                    <Spin size="small" />
                    <span style={{ color: C.muted, fontSize: 12 }}>Yanıt hazırlanıyor…</span>
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>

            {/* input */}
            <div style={{ flexShrink: 0, padding: '10px 24px 14px', borderTop: `1px solid ${C.border}`, background: C.panel }}>
              <div style={{
                display: 'flex', gap: 8, alignItems: 'flex-end',
                background: isDark ? '#0a1628' : '#f8fafc',
                border: `1px solid ${C.border}`, borderRadius: 12, padding: '8px 10px',
              }}>
                <Input.TextArea
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
                  placeholder={`${currentMode.icon} ${currentMode.label} modunda soru sorun… (Enter gönderin, Shift+Enter satır ekler)`}
                  autoSize={{ minRows: 1, maxRows: 6 }}
                  style={{ border: 'none', boxShadow: 'none', resize: 'none', background: 'transparent', color: C.text, flex: 1, fontSize: 13 }}
                />
                <Button type="primary" icon={<SendOutlined />} onClick={() => send()}
                  loading={chatMut.isPending} disabled={!input.trim()}
                  style={{
                    borderRadius: 8, flexShrink: 0, height: 34,
                    background: currentMode.color, borderColor: currentMode.color,
                  }}
                />
              </div>
              <div style={{ color: C.muted, fontSize: 10, marginTop: 5, textAlign: 'center' }}>
                AI yanıtları hatalı olabilir. Kritik kararlar için doğrulayın.
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── RIGHT PANEL ────────────────────────────────────────────────── */}
      {!isMobile && <div style={{
        width: 240, flexShrink: 0, background: C.panel,
        borderLeft: `1px solid ${C.border}`,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{ padding: '14px 14px 10px', borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 13 }}>Aksiyon Merkezi</div>
          <div style={{ color: C.muted, fontSize: 10, marginTop: 1 }}>Hızlı erişim ve yönlendirme</div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 14 }}>

          {/* HIZLI AKSİYONLAR */}
          <div>
            <div style={{ color: C.muted, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', marginBottom: 6 }}>
              HIZLI AKSİYONLAR
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {QUICK_ACTIONS.map(a => (
                <button
                  key={a.path}
                  onClick={() => navigate(a.path)}
                  style={{
                    background: C.card, border: `1px solid ${C.border}`,
                    borderRadius: 8, padding: '7px 10px', cursor: 'pointer',
                    textAlign: 'left', transition: 'all 0.12s',
                    display: 'flex', alignItems: 'center', gap: 8,
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = a.color; (e.currentTarget as HTMLElement).style.background = `${a.color}15` }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = C.border; (e.currentTarget as HTMLElement).style.background = C.card }}
                >
                  <div style={{
                    width: 28, height: 28, borderRadius: 7,
                    background: `${a.color}20`, color: a.color,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 14, flexShrink: 0,
                  }}>{a.icon}</div>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{a.label}</div>
                    <div style={{ fontSize: 10, color: C.muted }}>{a.sub}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* KONTEXT BİLGİLERİ */}
          <div>
            <div style={{ color: C.muted, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', marginBottom: 6 }}>
              KONTEXT BİLGİLERİ
            </div>
            <div style={{
              background: C.card, border: `1px solid ${C.border}`,
              borderRadius: 8, padding: '8px 10px',
            }}>
              {[
                { label: 'Toplam Cihaz',    val: total },
                { label: 'Online',           val: online,  color: '#22c55e' },
                { label: 'Offline',          val: offline, color: offline > 0 ? '#ef4444' : C.muted },
                { label: 'Olay Sayısı (24s)', val: stats?.events_24h.total ?? '—' },
                { label: 'Ağ Sağlığı',       val: `${health}/100`, color: healthColor },
                { label: 'Topoloji Bağlantı', val: stats?.topology.links ?? '—' },
              ].map(row => (
                <div key={row.label} style={{
                  display: 'flex', justifyContent: 'space-between',
                  padding: '4px 0', borderBottom: `1px solid ${C.border}`,
                  fontSize: 11,
                }}>
                  <span style={{ color: C.muted }}>{row.label}</span>
                  <span style={{ fontWeight: 600, color: (row as any).color ?? C.text }}>{row.val}</span>
                </div>
              ))}
            </div>
          </div>

          {/* ONAY & GÜVENLİK */}
          <div>
            <div style={{ color: C.muted, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', marginBottom: 6 }}>
              ONAY & GÜVENLİK
            </div>
            <div style={{
              background: isDark ? '#1c1107' : '#fffbeb',
              border: `1px solid ${isDark ? '#78350f' : '#fde68a'}`,
              borderRadius: 8, padding: '8px 10px', fontSize: 11,
              color: isDark ? '#fcd34d' : '#92400e',
            }}>
              <div style={{ fontWeight: 600, marginBottom: 3 }}>⚠️ Kritik Aksiyonlar</div>
              <div style={{ lineHeight: 1.5 }}>Playbook çalıştırma ve config değişiklikleri onay gerektirir.</div>
              <button
                onClick={() => navigate('/approvals')}
                style={{
                  marginTop: 6, width: '100%', background: '#f59e0b', border: 'none',
                  borderRadius: 6, padding: '5px 0', cursor: 'pointer',
                  color: '#fff', fontSize: 11, fontWeight: 600,
                }}
              >
                Onayları Görüntüle
              </button>
            </div>
          </div>
        </div>
      </div>}
    </div>
  )
}
