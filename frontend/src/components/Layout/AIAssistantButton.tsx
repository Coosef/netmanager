/**
 * Header-mounted entry point for the global AI assistant drawer.
 *
 * Why a separate component (rather than inlining into Header.tsx):
 *   - Header.tsx is already long; pulling this out keeps the surface
 *     editable in isolation and unit-testable.
 *   - The button is permission-gated (mirror of the /ai-assistant
 *     route's `minRole="org_admin"` gate). Unauthorized users see no
 *     entry point — that is also the safety boundary the operator's
 *     spec H requires.
 */
import { Tooltip } from 'antd'
import { RobotOutlined } from '@ant-design/icons'
import { useAuthStore } from '@/store/auth'
import { useAIAssistant } from '@/contexts/AIAssistantContext'

/** Roles that may use the AI assistant entry point. Mirrors the
 *  /ai-assistant route's RoleRoute minRole="org_admin" gate, expressed
 *  as an explicit allow-list so the gate is co-located with the
 *  button (no implicit "minRole ≥ org_admin" arithmetic). */
const ALLOWED_ROLES = new Set([
  'org_admin',
  'super_admin',
])

/** Pure helper — exported so the unit test can pin the gate matrix
 *  without rendering the component / mocking the auth store. */
export function isAIAssistantAllowed(role: string | null | undefined): boolean {
  if (!role) return false
  return ALLOWED_ROLES.has(role)
}

export default function AIAssistantButton() {
  const { user } = useAuthStore()
  const ai = useAIAssistant()

  if (!isAIAssistantAllowed(user?.role)) return null

  return (
    <Tooltip title="AI Assistant" data-testid="ai-assistant-button-tooltip">
      <span
        className="nm-iconbtn"
        onClick={ai.togglePanel}
        data-testid="ai-assistant-button"
        role="button"
        aria-label="Open AI Assistant"
        aria-pressed={ai.open}
      >
        <RobotOutlined
          style={{
            fontSize: 14,
            color: ai.open ? 'var(--accent)' : undefined,
          }}
        />
      </span>
    </Tooltip>
  )
}
