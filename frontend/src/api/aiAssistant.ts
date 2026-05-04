import client from './client'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatResponse {
  message: string
  provider: string
  model: string
  tokens_used: number
}

export interface AIProviderSettings {
  active_provider: string | null
  claude_model: string
  claude_configured: boolean
  openai_model: string
  openai_configured: boolean
  gemini_model: string
  gemini_configured: boolean
  ollama_base_url: string
  ollama_model: string
}

export interface UpdateAISettings {
  active_provider?: string
  claude_api_key?: string
  claude_model?: string
  openai_api_key?: string
  openai_model?: string
  gemini_api_key?: string
  gemini_model?: string
  ollama_base_url?: string
  ollama_model?: string
}

export interface AIProvider {
  id: string
  name: string
  models: string[]
  requires_key: boolean
}

export const aiAssistantApi = {
  getSettings: (): Promise<AIProviderSettings> =>
    client.get<AIProviderSettings>('/ai/settings').then((r) => r.data),
  updateSettings: (payload: UpdateAISettings): Promise<{ ok: boolean }> =>
    client.patch<{ ok: boolean }>('/ai/settings', payload).then((r) => r.data),
  chat: (messages: ChatMessage[]): Promise<ChatResponse> =>
    client.post<ChatResponse>('/ai/chat', { messages }).then((r) => r.data),
  getProviders: (): Promise<{ providers: AIProvider[] }> =>
    client.get<{ providers: AIProvider[] }>('/ai/providers').then((r) => r.data),
}
