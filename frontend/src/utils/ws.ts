import { useAuthStore } from '@/store/auth'

/**
 * Builds a WebSocket URL for the given path, appending the Bearer token as a
 * query parameter so the backend can authenticate the connection.
 */
export function buildWsUrl(path: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const host = window.location.hostname
  const port = window.location.port
  const portSuffix = port ? `:${port}` : ''
  const token = useAuthStore.getState().token
  const base = `${proto}://${host}${portSuffix}${path}`
  const sep = path.includes('?') ? '&' : '?'
  return token ? `${base}${sep}token=${encodeURIComponent(token)}` : base
}
