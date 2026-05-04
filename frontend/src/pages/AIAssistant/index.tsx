import { useState, useRef, useEffect } from 'react'
import {
  Button, Input, Space, Tag, Spin, Empty, Avatar, Tooltip,
} from 'antd'
import {
  SendOutlined, RobotOutlined, UserOutlined, ThunderboltOutlined,
  ClearOutlined,
} from '@ant-design/icons'
import { useMutation, useQuery } from '@tanstack/react-query'
import { aiAssistantApi, type ChatMessage } from '@/api/aiAssistant'
import { useTheme } from '@/contexts/ThemeContext'
import { useNavigate } from 'react-router-dom'

function mkC(isDark: boolean) {
  return {
    bg:     isDark ? '#030c1e' : '#f0f5fb',
    card:   isDark ? '#0f172a' : '#ffffff',
    border: isDark ? '#1e3a5f' : '#e2e8f0',
    text:   isDark ? '#f1f5f9' : '#1e293b',
    muted:  isDark ? '#64748b' : '#94a3b8',
    user:   isDark ? '#1d4ed8' : '#3b82f6',
    ai:     isDark ? '#1e293b' : '#f8fafc',
  }
}

const PROVIDER_COLORS: Record<string, string> = {
  claude: '#cc785c',
  openai: '#10a37f',
  gemini: '#4285f4',
  ollama: '#7c3aed',
}

const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
  openai: 'OpenAI',
  gemini: 'Gemini',
  ollama: 'Ollama',
}

const SUGGESTED: { label: string; q: string }[] = [
  { label: 'Durum', q: 'Şu an kaç cihaz offline? Hangilerinde kritik sorun var?' },
  { label: 'Risk', q: 'En riskli cihazlar hangileri? Neden riskli?' },
  { label: 'Anomali', q: 'Son 24 saatte anormal bir davranış tespit edildi mi?' },
  { label: 'Olaylar', q: 'Son 24 saatte neler oldu? Dikkat etmem gereken bir şey var mı?' },
  { label: 'Performans', q: 'Ağda trafik veya latency sorunu var mı?' },
  { label: 'Güvenlik', q: 'Güvenlik açısından dikkat etmem gereken bir şey var mı?' },
  { label: 'Topoloji', q: 'Topolojide beklenmeden değişen bir bağlantı var mı?' },
  { label: 'Öneri', q: 'Ağımı daha sağlıklı tutmak için ne yapmalıyım?' },
]

interface DisplayMessage extends ChatMessage {
  provider?: string
  model?: string
  error?: boolean
}

export default function AIAssistantPage() {
  const { isDark } = useTheme()
  const C = mkC(isDark)
  const navigate = useNavigate()
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)

  const { data: settings, isLoading: settingsLoading } = useQuery({
    queryKey: ['ai-settings'],
    queryFn: aiAssistantApi.getSettings,
  })

  const chatMut = useMutation<import('@/api/aiAssistant').ChatResponse, Error, ChatMessage[]>({
    mutationFn: (msgs) => aiAssistantApi.chat(msgs),
    onSuccess: (data) => {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: data.message,
        provider: data.provider,
        model: data.model,
      }])
    },
    onError: (err: any) => {
      const detail = err?.response?.data?.detail || 'Bilinmeyen hata'
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `⚠️ Hata: ${detail}`,
        error: true,
      }])
    },
  })

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, chatMut.isPending])

  const send = (text?: string) => {
    const content = (text ?? input).trim()
    if (!content || chatMut.isPending) return
    const newMsg: DisplayMessage = { role: 'user', content }
    const allMsgs = [...messages, newMsg]
    setMessages(allMsgs)
    setInput('')
    const apiMsgs: ChatMessage[] = allMsgs
      .filter(m => !m.error)
      .map(m => ({ role: m.role, content: m.content }))
    chatMut.mutate(apiMsgs)
  }

  const isConfigured = settings?.active_provider && (
    (settings.active_provider === 'ollama') ||
    (settings.active_provider === 'claude' && settings.claude_configured) ||
    (settings.active_provider === 'openai' && settings.openai_configured) ||
    (settings.active_provider === 'gemini' && settings.gemini_configured)
  )

  const providerColor = settings?.active_provider ? (PROVIDER_COLORS[settings.active_provider] ?? '#64748b') : '#64748b'
  const providerLabel = settings?.active_provider ? (PROVIDER_LABELS[settings.active_provider] ?? settings.active_provider) : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: C.bg, padding: '16px 20px', gap: 12 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 10,
            background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <RobotOutlined style={{ color: '#fff', fontSize: 18 }} />
          </div>
          <div>
            <div style={{ color: C.text, fontWeight: 700, fontSize: 16 }}>AI Ağ Asistanı</div>
            <div style={{ color: C.muted, fontSize: 12 }}>
              {providerLabel
                ? <><span style={{ color: providerColor }}>● </span>{providerLabel} aktif</>
                : 'Sağlayıcı yapılandırılmamış'}
            </div>
          </div>
        </div>
        <Space>
          {messages.length > 0 && (
            <Tooltip title="Sohbeti temizle">
              <Button icon={<ClearOutlined />} size="small" onClick={() => setMessages([])} />
            </Tooltip>
          )}
          <Button
            size="small"
            icon={<ThunderboltOutlined />}
            onClick={() => navigate('/settings?tab=ai')}
          >
            Ayarlar
          </Button>
        </Space>
      </div>

      {settingsLoading ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Spin />
        </div>
      ) : !isConfigured ? (
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 16,
        }}>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <span style={{ color: C.muted }}>
                AI asistanı kullanmak için önce bir sağlayıcı yapılandırın.
              </span>
            }
          />
          <Button type="primary" onClick={() => navigate('/settings?tab=ai')}>
            Sağlayıcı Ayarla
          </Button>
        </div>
      ) : (
        <>
          {/* Messages area */}
          <div style={{
            flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12,
            paddingBottom: 8,
          }}>
            {messages.length === 0 && (
              <div style={{ paddingTop: 24 }}>
                <div style={{ color: C.muted, fontSize: 13, marginBottom: 12, textAlign: 'center' }}>
                  Önerilen sorular
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
                  {SUGGESTED.map(s => (
                    <Tag
                      key={s.label}
                      style={{ cursor: 'pointer', borderRadius: 20, padding: '4px 12px', fontSize: 12 }}
                      color="blue"
                      onClick={() => send(s.q)}
                    >
                      {s.label}
                    </Tag>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg, idx) => (
              <div
                key={idx}
                style={{
                  display: 'flex',
                  flexDirection: msg.role === 'user' ? 'row-reverse' : 'row',
                  gap: 10,
                  alignItems: 'flex-start',
                }}
              >
                <Avatar
                  size={32}
                  style={{
                    background: msg.role === 'user' ? C.user : (msg.provider ? PROVIDER_COLORS[msg.provider] ?? '#6366f1' : '#6366f1'),
                    flexShrink: 0,
                  }}
                  icon={msg.role === 'user' ? <UserOutlined /> : <RobotOutlined />}
                />
                <div style={{ maxWidth: '75%' }}>
                  <div style={{
                    background: msg.role === 'user'
                      ? (isDark ? '#1e40af' : '#dbeafe')
                      : (msg.error ? (isDark ? '#3b1212' : '#fee2e2') : C.card),
                    border: `1px solid ${msg.role === 'user' ? 'transparent' : C.border}`,
                    borderRadius: msg.role === 'user' ? '18px 4px 18px 18px' : '4px 18px 18px 18px',
                    padding: '10px 14px',
                    color: msg.role === 'user' ? (isDark ? '#e0f2fe' : '#1e3a8a') : C.text,
                    fontSize: 13,
                    lineHeight: 1.6,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}>
                    {msg.content}
                  </div>
                  {msg.provider && (
                    <div style={{ marginTop: 3, textAlign: 'right', fontSize: 10, color: C.muted }}>
                      {PROVIDER_LABELS[msg.provider] ?? msg.provider} · {msg.model}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {chatMut.isPending && (
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <Avatar size={32} style={{ background: '#6366f1', flexShrink: 0 }} icon={<RobotOutlined />} />
                <div style={{
                  background: C.card, border: `1px solid ${C.border}`,
                  borderRadius: '4px 18px 18px 18px', padding: '10px 14px',
                }}>
                  <Spin size="small" />
                  <span style={{ color: C.muted, fontSize: 12, marginLeft: 8 }}>Yanıt hazırlanıyor…</span>
                </div>
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div style={{
            flexShrink: 0,
            background: C.card,
            border: `1px solid ${C.border}`,
            borderRadius: 12,
            padding: '8px 12px',
            display: 'flex',
            gap: 8,
            alignItems: 'flex-end',
          }}>
            <Input.TextArea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
              }}
              placeholder="Ağınız hakkında bir soru sorun… (Enter gönderin, Shift+Enter satır ekler)"
              autoSize={{ minRows: 1, maxRows: 5 }}
              style={{ border: 'none', boxShadow: 'none', resize: 'none', background: 'transparent', color: C.text, flex: 1 }}
            />
            <Button
              type="primary"
              icon={<SendOutlined />}
              onClick={() => send()}
              loading={chatMut.isPending}
              disabled={!input.trim()}
              style={{ borderRadius: 8, flexShrink: 0 }}
            >
              Gönder
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
