/**
 * Global AI assistant drawer.
 *
 * Renders the same chat surface the legacy /ai-assistant page already
 * uses — same `aiAssistantApi.chat()` client, same `mode` parameter —
 * but as a right-side drawer that stays mounted ABOVE the route tree.
 * The legacy page is preserved unchanged for users who want the full
 * one-pane experience (and to keep the operator's "no regression" rule
 * intact); the drawer is the new entry point that follows the user
 * from page to page.
 *
 * Context attachment: every outgoing user prompt is prefixed with a
 * read-only summary of the current page (route / org / location /
 * device id+hostname+ip if applicable). The summary is built by
 * AIAssistantContext.buildPageContext, which only ever reads fields the
 * user is already authorised to see.
 */
import { Drawer, Button, Input, Space, Spin, Tag, Tooltip } from 'antd'
import {
  RobotOutlined, SendOutlined, ClearOutlined, CloseOutlined,
} from '@ant-design/icons'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { aiAssistantApi, type ChatMessage } from '@/api/aiAssistant'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useAIAssistant } from '@/contexts/AIAssistantContext'

const DRAWER_WIDTH_DESKTOP = 480

function renderContextSummary(ctx: ReturnType<typeof useAIAssistant>['pageContext']): string {
  const bits: string[] = []
  bits.push(`route=${ctx.route}`)
  if (ctx.organization_id != null) {
    bits.push(`org=${ctx.organization_id}${ctx.organization_name ? ` (${ctx.organization_name})` : ''}`)
  }
  if (ctx.location_id != null) {
    bits.push(`location=${ctx.location_id}${ctx.location_name ? ` (${ctx.location_name})` : ''}`)
  }
  if (ctx.device_id != null) {
    bits.push(`device=${ctx.device_id}${ctx.device_hostname ? ` (${ctx.device_hostname})` : ''}${ctx.device_ip ? ` ${ctx.device_ip}` : ''}`)
  }
  return bits.join(' · ')
}

/**
 * Build the prompt envelope sent on the user's behalf. We prepend a
 * single short context line so the LLM has the current page state,
 * but the user's prompt itself is preserved unchanged. The context
 * line lives INSIDE the user message (not as a separate role) so
 * existing backend chat history handling is unaffected.
 *
 * Exported so a unit test can assert against the exact serialisation
 * shape without rendering the component.
 */
export function envelopeUserPrompt(
  prompt: string,
  pageContext: ReturnType<typeof useAIAssistant>['pageContext'],
): string {
  const summary = renderContextSummary(pageContext)
  if (!summary) return prompt
  return `[NetManager context: ${summary}]\n\n${prompt}`
}

export default function AIAssistantDrawer() {
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const ai = useAIAssistant()
  const [input, setInput] = useState('')

  const chatMutation = useMutation({
    mutationFn: (msgs: ChatMessage[]) => aiAssistantApi.chat(msgs, 'analyze'),
    onSuccess: (resp) => {
      ai.appendMessage({ role: 'assistant', content: resp.message })
    },
  })

  const handleSend = () => {
    const prompt = input.trim()
    if (!prompt) return
    const userMessage: ChatMessage = {
      role: 'user',
      content: envelopeUserPrompt(prompt, ai.pageContext),
    }
    const nextHistory = [...ai.messages, userMessage]
    ai.appendMessage(userMessage)
    setInput('')
    chatMutation.mutate(nextHistory)
  }

  return (
    <Drawer
      title={
        <Space size={8} align="center">
          <RobotOutlined />
          <span>{t('ai.assistant_title', { defaultValue: 'AI Assistant' })}</span>
        </Space>
      }
      placement="right"
      open={ai.open}
      onClose={ai.closePanel}
      width={isMobile ? '100%' : DRAWER_WIDTH_DESKTOP}
      destroyOnClose={false}
      maskClosable={true}
      closeIcon={<CloseOutlined />}
      data-testid="ai-assistant-drawer"
      extra={
        <Space size={4}>
          <Tooltip title={t('ai.clear_history', { defaultValue: 'Clear conversation' })}>
            <Button
              type="text"
              size="small"
              icon={<ClearOutlined />}
              onClick={ai.clearMessages}
              disabled={ai.messages.length === 0}
              data-testid="ai-assistant-clear"
            />
          </Tooltip>
        </Space>
      }
    >
      <div
        style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
        data-testid="ai-assistant-body"
      >
        {/* Context strip — read-only, shows the user what's being shared */}
        <div
          style={{ fontSize: 11, marginBottom: 8, opacity: 0.75 }}
          data-testid="ai-assistant-context-strip"
        >
          {renderContextSummary(ai.pageContext) || (
            <span>{t('ai.no_context', { defaultValue: 'No page context attached.' })}</span>
          )}
        </div>

        {/* Messages */}
        <div
          style={{ flex: 1, overflowY: 'auto', marginBottom: 12 }}
          data-testid="ai-assistant-messages"
        >
          {ai.messages.length === 0 ? (
            <div style={{ textAlign: 'center', opacity: 0.6, padding: '24px 8px' }}>
              {t('ai.empty_state', {
                defaultValue: 'Ask something about the current page or your network.',
              })}
            </div>
          ) : (
            ai.messages.map((m, i) => (
              <div
                key={i}
                style={{
                  marginBottom: 12,
                  padding: 8,
                  borderRadius: 6,
                  background: m.role === 'user' ? 'rgba(59, 130, 246, 0.08)' : 'transparent',
                }}
              >
                <Tag color={m.role === 'user' ? 'blue' : 'default'} style={{ marginBottom: 4 }}>
                  {m.role === 'user' ? t('ai.you', { defaultValue: 'You' }) : t('ai.assistant', { defaultValue: 'Assistant' })}
                </Tag>
                <div style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{m.content}</div>
              </div>
            ))
          )}
          {chatMutation.isPending && (
            <div style={{ textAlign: 'center', padding: 8 }}>
              <Spin size="small" />
            </div>
          )}
        </div>

        {/* Input */}
        <Space.Compact style={{ width: '100%' }}>
          <Input.TextArea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t('ai.input_placeholder', {
              defaultValue: 'Ask the assistant…',
            }) as string}
            autoSize={{ minRows: 1, maxRows: 4 }}
            onPressEnter={(e) => {
              if (!e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            data-testid="ai-assistant-input"
          />
          <Button
            type="primary"
            icon={<SendOutlined />}
            onClick={handleSend}
            disabled={!input.trim() || chatMutation.isPending}
            data-testid="ai-assistant-send"
          />
        </Space.Compact>
      </div>
    </Drawer>
  )
}
