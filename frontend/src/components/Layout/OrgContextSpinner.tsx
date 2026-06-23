import { Spin, Typography } from 'antd'
import { useTranslation } from 'react-i18next'

/**
 * PR-A2 — workspace-only spinner shown while OrgRouteShell is in a
 * `transitioning` or `validating` state.
 *
 * Intentionally NOT a full-screen overlay: AppLayout's Sidebar +
 * AppHeader continue to render around the spinner so the operator sees
 * the org context that is being committed (Header OrgBadge updates
 * mid-transition).
 *
 * The two phases produce distinct labels for diagnostic clarity:
 *   - `transitioning` — cache wipe in flight (cancel + remove of every
 *                       operational query)
 *   - `validating`    — ctx refetch under the new X-Org-Id is in
 *                       flight; we are waiting for backend to confirm
 *                       `ctx.organization.id === routeOrgId`
 */
export default function OrgContextSpinner({
  phase,
  targetOrgId,
}: {
  phase: 'transitioning' | 'validating'
  targetOrgId: number
}) {
  const { t } = useTranslation()
  return (
    <div
      data-testid="org-context-spinner"
      data-phase={phase}
      data-target-org-id={targetOrgId}
      style={{
        minHeight: '60vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        padding: 24,
      }}
    >
      <Spin size="large" />
      <Typography.Text type="secondary" style={{ fontSize: 13 }}>
        {phase === 'transitioning'
          ? t('operations.gate.transitioning', { orgId: targetOrgId })
          : t('operations.gate.validating')}
      </Typography.Text>
    </div>
  )
}
