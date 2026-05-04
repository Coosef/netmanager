import { useState, useRef, useEffect } from 'react'
import { Button, Input, Space, Spin, Empty, Avatar, Tooltip } from 'antd'
import {
  SendOutlined, RobotOutlined, UserOutlined, ThunderboltOutlined,
  ClearOutlined, CopyOutlined, CheckOutlined,
} from '@ant-design/icons'
import { useMutation, useQuery } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { aiAssistantApi, type ChatMessage } from '@/api/aiAssistant'
import { useTheme } from '@/contexts/ThemeContext'
import { useNavigate } from 'react-router-dom'

function mkC(isDark: boolean) {
  return {
    bg:       isDark ? '#030c1e' : '#f0f5fb',
    card:     isDark ? '#0f172a' : '#ffffff',
    border:   isDark ? '#1e3a5f' : '#e2e8f0',
    text:     isDark ? '#f1f5f9' : '#1e293b',
    muted:    isDark ? '#64748b' : '#94a3b8',
    userBg:   isDark ? '#1e40af' : '#dbeafe',
    userText: isDark ? '#e0f2fe' : '#1e3a8a',
    codeBg:   isDark ? '#0a1628' : '#f1f5f9',
    errBg:    isDark ? '#3b1212' : '#fee2e2',
    sidebar:  isDark ? '#070f1f' : '#f8fafc',
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

const SUGGESTED: { label: string; icon: string; q: string }[] = [
  { label: 'Durum',      icon: '📡', q: 'Şu an kaç cihaz offline? Hangilerinde kritik sorun var?' },
  { label: 'Risk',       icon: '⚠️', q: 'En riskli cihazlar hangileri? Neden riskli?' },
  { label: 'Anomali',    icon: '🔍', q: 'Son 24 saatte anormal bir davranış tespit edildi mi?' },
  { label: 'Olaylar',   icon: '📋', q: 'Son 24 saatte neler oldu? Dikkat etmem gereken bir şey var mı?' },
  { label: 'Performans', icon: '📈', q: 'Ağda trafik veya latency sorunu var mı?' },
  { label: 'Güvenlik',  icon: '🛡️', q: 'Güvenlik açısından dikkat etmem gereken bir şey var mı?' },
  { label: 'Topoloji',  icon: '🗺️', q: 'Topolojide beklenmeden değişen bir bağlantı var mı?' },
  { label: 'Öneri',     icon: '💡', q: 'Ağımı daha sağlıklı tutmak için ne yapmalıyım?' },
]

interface DisplayMessage extends ChatMessage {
  provider?: string
  model?: string
  error?: boolean
  id: number
}

function MarkdownContent({ content, isDark, C }: { content: string; isDark: boolean; C: ReturnType<typeof mkC> }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => (
          <p style={{ margin: '0 0 8px 0', lineHeight: 1.65 }}>{children}</p>
        ),
        strong: ({ children }) => (
          <strong style={{ color: isDark ? '#93c5fd' : '#1d4ed8', fontWeight: 600 }}>{children}</strong>
        ),
        ul: ({ children }) => (
          <ul style={{ margin: '6px 0', paddingLeft: 20, lineHeight: 1.7 }}>{children}</ul>
        ),
        ol: ({ children }) => (
          <ol style={{ margin: '6px 0', paddingLeft: 20, lineHeight: 1.7 }}>{children}</ol>
        ),
        li: ({ children }) => (
          <li style={{ marginBottom: 3 }}>{children}</li>
        ),
        code: ({ children, className }) => {
          const isBlock = className?.includes('language-')
          return isBlock ? (
            <code style={{
              display: 'block',
              background: C.codeBg,
              border: `1px solid ${C.border}`,
              borderRadius: 6,
              padding: '10px 14px',
              fontSize: 12,
              fontFamily: 'monospace',
              overflowX: 'auto',
              margin: '8px 0',
              whiteSpace: 'pre',
            }}>{children}</code>
          ) : (
            <code style={{
              background: C.codeBg,
              border: `1px solid ${C.border}`,
              borderRadius: 4,
              padding: '1px 6px',
              fontSize: 12,
              fontFamily: 'monospace',
            }}>{children}</code>
          )
        },
        pre: ({ children }) => <>{children}</>,
        h3: ({ children }) => (
          <h3 style={{ fontSize: 14, fontWeight: 700, margin: '10px 0 4px', color: C.text }}>{children}</h3>
        ),
        h4: ({ children }) => (
          <h4 style={{ fontSize: 13, fontWeight: 600, margin: '8px 0 4px', color: C.text }}>{children}</h4>
        ),
        blockquote: ({ children }) => (
          <blockquote style={{
            borderLeft: `3px solid ${isDark ? '#3b82f6' : '#93c5fd'}`,
            margin: '8px 0',
            paddingLeft: 12,
            color: C.muted,
            fontStyle: 'italic',
          }}>{children}</blockquote>
        ),
        hr: () => <hr style={{ border: 'none', borderTop: `1px solid ${C.border}`, margin: '10px 0' }} />,
      }}
    >
      {content}
    </ReactMarkdown>
  )
}

let _msgId = 0
function nextId() { return ++_msgId }

export default function AIAssistantPage() {
  const { isDark } = useTheme()
  const C = mkC(isDark)
  const navigate = useNavigate()
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [copiedId, setCopiedId] = useState<number | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  const { data: settings, isLoading: settingsLoading } = useQuery({
    queryKey: ['ai-settings'],
    queryFn: aiAssistantApi.getSettings,
  })

  const chatMut = useMutation<import('@/api/aiAssistant').ChatResponse, Error, ChatMessage[]>({
    mutationFn: (msgs) => aiAssistantApi.chat(msgs),
    onSuccess: (data) => {
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'assistant',
        content: data.message,
        provider: data.provider,
        model: data.model,
      }])
    },
    onError: (err: any) => {
      const detail = err?.response?.data?.detail || 'Bilinmeyen hata'
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'assistant',
        content: `Hata: ${detail}`,
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
    const newMsg: DisplayMessage = { id: nextId(), role: 'user', content }
    const allMsgs = [...messages, newMsg]
    setMessages(allMsgs)
    setInput('')
    const apiMsgs: ChatMessage[] = allMsgs
      .filter(m => !m.error)
      .map(m => ({ role: m.role, content: m.content }))
    chatMut.mutate(apiMsgs)
  }

  const copyMsg = (msg: DisplayMessage) => {
    navigator.clipboard.writeText(msg.content)
    setCopiedId(msg.id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const isConfigured = settings?.active_provider && (
    (settings.active_provider === 'ollama') ||
    (settings.active_provider === 'claude' && settings.claude_configured) ||
    (settings.active_provider === 'openai' && settings.openai_configured) ||
    (settings.active_provider === 'gemini' && settings.gemini_configured)
  )

  const providerColor = settings?.active_provider
    ? (PROVIDER_COLORS[settings.active_provider] ?? '#64748b') : '#64748b'
  const providerLabel = settings?.active_provider
    ? (PROVIDER_LABELS[settings.active_provider] ?? settings.active_provider) : null

  return (
    <div style={{
      display: 'flex', height: '100vh', background: C.bg, overflow: 'hidden',
    }}>
      {/* Left sidebar — suggested questions */}
      <div style={{
        width: 200, flexShrink: 0, background: C.sidebar,
        borderRight: `1px solid ${C.border}`,
        display: 'flex', flexDirection: 'column', padding: '16px 12px', gap: 8,
        overflowY: 'auto',
      }}>
        <div style={{ color: C.muted, fontSize: 11, fontWeight: 600, letterSpacing: '0.07em', marginBottom: 4 }}>
          HAZIR SORULAR
        </div>
        {SUGGESTED.map(s => (
          <button
            key={s.label}
            onClick={() => send(s.q)}
            disabled={chatMut.isPending}
            style={{
              background: 'transparent',
              border: `1px solid ${C.border}`,
              borderRadius: 8,
              padding: '8px 10px',
              cursor: chatMut.isPending ? 'not-allowed' : 'pointer',
              textAlign: 'left',
              color: C.text,
              fontSize: 12,
              lineHeight: 1.4,
              transition: 'all 0.15s',
              opacity: chatMut.isPending ? 0.5 : 1,
            }}
            onMouseEnter={e => {
              if (!chatMut.isPending)
                (e.currentTarget as HTMLElement).style.background = isDark ? '#0e1e38' : '#eff6ff'
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLElement).style.background = 'transparent'
            }}
          >
            <span style={{ fontSize: 14 }}>{s.icon}</span>
            <span style={{ marginLeft: 6, fontWeight: 500 }}>{s.label}</span>
            <div style={{ color: C.muted, fontSize: 11, marginTop: 2 }}>
              {s.q.length > 48 ? s.q.slice(0, 48) + '…' : s.q}
            </div>
          </button>
        ))}
      </div>

      {/* Main chat area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Header */}
        <div style={{
          flexShrink: 0, padding: '12px 20px',
          borderBottom: `1px solid ${C.border}`,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          background: C.card,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 34, height: 34, borderRadius: 10,
              background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <RobotOutlined style={{ color: '#fff', fontSize: 16 }} />
            </div>
            <div>
              <div style={{ color: C.text, fontWeight: 700, fontSize: 15 }}>AI Ağ Asistanı</div>
              <div style={{ color: C.muted, fontSize: 11 }}>
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

        {/* Body */}
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
              description={<span style={{ color: C.muted }}>AI asistanı kullanmak için önce bir sağlayıcı yapılandırın.</span>}
            />
            <Button type="primary" onClick={() => navigate('/settings?tab=ai')}>
              Sağlayıcı Ayarla
            </Button>
          </div>
        ) : (
          <>
            {/* Messages */}
            <div style={{
              flex: 1, overflowY: 'auto', padding: '16px 24px',
              display: 'flex', flexDirection: 'column', gap: 16,
            }}>
              {messages.length === 0 && (
                <div style={{
                  flex: 1, display: 'flex', flexDirection: 'column',
                  alignItems: 'center', justifyContent: 'center',
                  color: C.muted, fontSize: 13, gap: 8, paddingTop: 60,
                }}>
                  <RobotOutlined style={{ fontSize: 40, opacity: 0.3 }} />
                  <div>Ağınız hakkında bir soru sorun</div>
                  <div style={{ fontSize: 11 }}>Sol paneldeki hazır sorulardan seçebilirsiniz</div>
                </div>
              )}

              {messages.map((msg) => (
                <div
                  key={msg.id}
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
                      background: msg.role === 'user'
                        ? (isDark ? '#1d4ed8' : '#3b82f6')
                        : (msg.provider ? PROVIDER_COLORS[msg.provider] ?? '#6366f1' : '#6366f1'),
                      flexShrink: 0,
                    }}
                    icon={msg.role === 'user' ? <UserOutlined /> : <RobotOutlined />}
                  />

                  <div style={{ maxWidth: '78%' }}>
                    <div style={{
                      background: msg.role === 'user'
                        ? C.userBg
                        : (msg.error ? C.errBg : C.card),
                      border: `1px solid ${msg.role === 'user' ? 'transparent' : (msg.error ? '#f87171' : C.border)}`,
                      borderRadius: msg.role === 'user' ? '18px 4px 18px 18px' : '4px 18px 18px 18px',
                      padding: '10px 14px',
                      color: msg.role === 'user' ? C.userText : C.text,
                      fontSize: 13,
                      boxShadow: isDark ? '0 2px 8px rgba(0,0,0,0.3)' : '0 1px 4px rgba(0,0,0,0.06)',
                    }}>
                      {msg.role === 'user' ? (
                        <span style={{ lineHeight: 1.6 }}>{msg.content}</span>
                      ) : (
                        <div style={{ lineHeight: 1.6 }}>
                          <MarkdownContent content={msg.content} isDark={isDark} C={C} />
                        </div>
                      )}
                    </div>

                    {/* Footer: provider tag + copy button */}
                    <div style={{
                      display: 'flex',
                      justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
                      alignItems: 'center',
                      gap: 6,
                      marginTop: 4,
                    }}>
                      {msg.provider && (
                        <span style={{ fontSize: 10, color: C.muted }}>
                          {PROVIDER_LABELS[msg.provider] ?? msg.provider}
                          {msg.model ? ` · ${msg.model}` : ''}
                        </span>
                      )}
                      {msg.role === 'assistant' && !msg.error && (
                        <Tooltip title={copiedId === msg.id ? 'Kopyalandı!' : 'Kopyala'}>
                          <Button
                            type="text"
                            size="small"
                            icon={copiedId === msg.id ? <CheckOutlined style={{ color: '#22c55e' }} /> : <CopyOutlined />}
                            onClick={() => copyMsg(msg)}
                            style={{ color: C.muted, padding: '0 4px', height: 18, fontSize: 11 }}
                          />
                        </Tooltip>
                      )}
                    </div>
                  </div>
                </div>
              ))}

              {chatMut.isPending && (
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <Avatar size={32} style={{ background: '#6366f1', flexShrink: 0 }} icon={<RobotOutlined />} />
                  <div style={{
                    background: C.card, border: `1px solid ${C.border}`,
                    borderRadius: '4px 18px 18px 18px', padding: '12px 16px',
                    display: 'flex', alignItems: 'center', gap: 8,
                    boxShadow: isDark ? '0 2px 8px rgba(0,0,0,0.3)' : '0 1px 4px rgba(0,0,0,0.06)',
                  }}>
                    <Spin size="small" />
                    <span style={{ color: C.muted, fontSize: 12 }}>Yanıt hazırlanıyor…</span>
                  </div>
                </div>
              )}

              <div ref={bottomRef} />
            </div>

            {/* Input */}
            <div style={{
              flexShrink: 0,
              padding: '12px 24px 16px',
              borderTop: `1px solid ${C.border}`,
              background: C.card,
            }}>
              <div style={{
                display: 'flex', gap: 10, alignItems: 'flex-end',
                background: isDark ? '#0a1628' : '#f8fafc',
                border: `1px solid ${C.border}`,
                borderRadius: 12, padding: '8px 12px',
              }}>
                <Input.TextArea
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
                  }}
                  placeholder="Ağınız hakkında bir soru sorun… (Enter gönderin, Shift+Enter satır ekler)"
                  autoSize={{ minRows: 1, maxRows: 6 }}
                  style={{
                    border: 'none', boxShadow: 'none', resize: 'none',
                    background: 'transparent', color: C.text, flex: 1, fontSize: 13,
                  }}
                />
                <Button
                  type="primary"
                  icon={<SendOutlined />}
                  onClick={() => send()}
                  loading={chatMut.isPending}
                  disabled={!input.trim()}
                  style={{ borderRadius: 8, flexShrink: 0, height: 34 }}
                />
              </div>
              <div style={{ color: C.muted, fontSize: 10, marginTop: 6, textAlign: 'center' }}>
                AI yanıtları hatalı olabilir. Kritik kararlar için doğrulayın.
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
