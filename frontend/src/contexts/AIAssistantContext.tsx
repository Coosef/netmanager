/**
 * Global AI assistant panel state.
 *
 * Mounted ABOVE the route tree (inside <SiteProvider> in App.tsx) so the
 * panel can be opened from any page via the navbar entry point and stay
 * open across route navigations. Chat history lives on this context
 * too, so the user can take the assistant with them while they work in
 * the rest of the app.
 *
 * Design constraints (operator's spec):
 *   - Open/close is a global toggle.
 *   - Route change must NOT close the panel.
 *   - Route change MAY refresh the lightweight "page context" snapshot
 *     the assistant gets when the user sends their next message —
 *     never silently mutating the in-flight chat, only what we attach
 *     to the next user prompt.
 *   - Only display-grade metadata may go into that context (route,
 *     active organization id/name, active location id/name, and a
 *     device id/hostname/ip if the URL is currently inside a device-
 *     detail page). No secrets, no credentials, no raw configs, no
 *     foreign-tenant data.
 *   - Permission gating happens at the navbar entry point (Header)
 *     and at the existing /ai-assistant route (RoleRoute minRole=
 *     org_admin). The drawer's API client is the same one the legacy
 *     /ai-assistant page uses; backend permission gates are unchanged.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from 'react'
import { useLocation, useParams } from 'react-router-dom'
import { useSite } from './SiteContext'
import type { ChatMessage } from '@/api/aiAssistant'

/* ─── page-context snapshot ────────────────────────────────────────────── */

/** Lightweight, RBAC-safe summary of the page the user is on when they
 *  open the panel or send a message. NEVER carries credentials / raw
 *  config / cross-tenant data — only fields already visible on screen. */
export interface AIPageContext {
  route: string
  organization_id: number | null
  organization_name: string | null
  location_id: number | null
  location_name: string | null
  device_id: number | null
  /** Only populated when the page already exposes hostname/ip via
   *  the URL or active SiteContext snapshot. Carries no other device
   *  metadata. */
  device_hostname: string | null
  device_ip: string | null
}

/* ─── context shape ────────────────────────────────────────────────────── */

interface AIAssistantCtx {
  /** Panel visibility — true while the drawer is mounted open. */
  open: boolean
  /** Imperative actions; thin wrappers around setOpen so test code can
   *  exercise them without driving DOM events. */
  openPanel: () => void
  closePanel: () => void
  togglePanel: () => void
  /** Currently displayed chat history. Persists across route changes
   *  and across open/close cycles within a single session. Cleared
   *  by clearMessages() (UI control) and on logout (the auth store's
   *  logoutCacheClear test exercises this — see `clearMessages` below). */
  messages: ChatMessage[]
  setMessages: (m: ChatMessage[]) => void
  appendMessage: (m: ChatMessage) => void
  clearMessages: () => void
  /** Page context snapshot, refreshed on every route / org / location
   *  change. Read-only from consumers. */
  pageContext: AIPageContext
}

const NULL_PAGE_CONTEXT: AIPageContext = {
  route: '/',
  organization_id: null,
  organization_name: null,
  location_id: null,
  location_name: null,
  device_id: null,
  device_hostname: null,
  device_ip: null,
}

const AIAssistantContext = createContext<AIAssistantCtx>({
  open: false,
  openPanel: () => {},
  closePanel: () => {},
  togglePanel: () => {},
  messages: [],
  setMessages: () => {},
  appendMessage: () => {},
  clearMessages: () => {},
  pageContext: NULL_PAGE_CONTEXT,
})

/* ─── provider ─────────────────────────────────────────────────────────── */

/** Pure helper — derive a safe page context from the current location +
 *  site state. Extracted so a unit test can exercise the field-by-field
 *  rules without spinning up a Router/Site provider. */
export function buildPageContext(args: {
  pathname: string
  routeParams: Record<string, string | undefined>
  organizationId: number | null
  organizationName: string | null
  locationId: number | null
  locationName: string | null
  /** Optional. When the page is a device-detail page AND the
   *  surrounding context already exposes the device row, the caller
   *  may pass display fields (hostname/ip) explicitly. We never read
   *  these from anywhere the user couldn't already see. */
  deviceHostname?: string | null
  deviceIp?: string | null
}): AIPageContext {
  // device_id only gets populated when the route actually carries one —
  // and only as a number, never a string the LLM might leak elsewhere.
  let deviceId: number | null = null
  const raw = args.routeParams.deviceId ?? args.routeParams.id
  if (raw && /^\d+$/.test(raw)) {
    // /devices/:deviceId is the canonical detail route; /api/.../id etc.
    // are not present in the browser path.
    const onDeviceRoute = /\/devices\/\d+(?:\b|\/)/.test(args.pathname)
    if (onDeviceRoute) deviceId = Number(raw)
  }

  return {
    route: args.pathname || '/',
    organization_id: args.organizationId,
    organization_name: args.organizationName,
    location_id: args.locationId,
    location_name: args.locationName,
    device_id: deviceId,
    device_hostname: deviceId != null ? (args.deviceHostname ?? null) : null,
    device_ip: deviceId != null ? (args.deviceIp ?? null) : null,
  }
}

interface ProviderProps {
  children: ReactNode
}

export function AIAssistantProvider({ children }: ProviderProps) {
  const [open, setOpen] = useState(false)
  const [messages, setMessagesState] = useState<ChatMessage[]>([])
  const location = useLocation()
  // We deliberately read params via the topmost match — App-level routes
  // declare /devices/:deviceId. Sub-route components MAY re-use other
  // param names, but the top-level path is the source of truth for the
  // assistant's page context.
  const params = useParams()
  const site = useSite()

  const openPanel = useCallback(() => setOpen(true), [])
  const closePanel = useCallback(() => setOpen(false), [])
  const togglePanel = useCallback(() => setOpen((v) => !v), [])
  const setMessages = useCallback(
    (m: ChatMessage[]) => setMessagesState(m),
    [],
  )
  const appendMessage = useCallback(
    (m: ChatMessage) => setMessagesState((prev) => [...prev, m]),
    [],
  )
  const clearMessages = useCallback(() => setMessagesState([]), [])

  // SiteContext exposes org id via `routeOrgId` (URL-authoritative on
  // /app/org/:organizationId/* paths) or `activeOrgId` (preference
  // hint outside that surface). Either way, we want the effective id
  // that downstream queries would scope on.
  //
  // Names — organization_name / location_name — are nice-to-have for
  // the LLM prompt envelope but never required. We only set
  // location_name from the site's exposed `locations` array, which is
  // already the access-checked set; org_name is intentionally left
  // null at this layer (the legacy AIAssistant page does not need it
  // either) and may be filled in by a future PR via a dedicated
  // org-detail hook. RBAC safety is not affected — the backend
  // re-checks every chat call against the user's token.
  const orgId = site?.routeOrgId ?? site?.activeOrgId ?? null
  const orgName: string | null = null
  const locId = site?.activeLocationId ?? null
  const locName: string | null = (() => {
    if (locId == null) return null
    const found = site?.locations?.find?.((l: any) => l.id === locId)
    return (found?.name as string | undefined) ?? null
  })()

  const pageContext = useMemo<AIPageContext>(() => buildPageContext({
    pathname: location.pathname,
    routeParams: params as Record<string, string | undefined>,
    organizationId: orgId,
    organizationName: orgName,
    locationId: locId,
    locationName: locName,
    // device hostname/ip are only attached if a downstream page sets
    // them — we deliberately do NOT fetch the device row here.
  }), [
    location.pathname,
    params,
    orgId,
    orgName,
    locId,
    locName,
  ])

  // Reset chat history when the active organization changes — chat
  // history from another tenant must not leak across the org switch.
  // Open state is preserved so the panel stays available, but the
  // conversation starts fresh.
  useEffect(() => {
    setMessagesState([])
  }, [orgId])

  const value = useMemo<AIAssistantCtx>(() => ({
    open,
    openPanel,
    closePanel,
    togglePanel,
    messages,
    setMessages,
    appendMessage,
    clearMessages,
    pageContext,
  }), [open, openPanel, closePanel, togglePanel, messages, setMessages,
       appendMessage, clearMessages, pageContext])

  return (
    <AIAssistantContext.Provider value={value}>
      {children}
    </AIAssistantContext.Provider>
  )
}

export const useAIAssistant = () => useContext(AIAssistantContext)
