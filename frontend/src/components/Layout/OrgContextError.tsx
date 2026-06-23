import { Alert, Button, Space } from 'antd'
import { useTranslation } from 'react-i18next'

/**
 * PR-A2 — backend mismatch surface.
 *
 * Rendered by OrgRouteShell when the validation gate fails:
 *
 *   routeOrgId  = 6   (from URL)
 *   ctx.organization.id = 1  (from backend /context/current)
 *
 * In production this state should never trigger — `X-Org-Id: 6` is
 * propagated by the Axios interceptor and the backend's
 * `resolve_location_context` returns the requested tenant. Hitting this
 * Alert is a backend bug signal; the retry button re-runs the gate
 * (re-cancels + re-removes the cache, then waits for ctx again).
 */
export default function OrgContextError({
  routeOrgId,
  ctxOrgId,
  onRetry,
}: {
  routeOrgId: number
  ctxOrgId: number | null
  onRetry: () => void
}) {
  const { t } = useTranslation()
  return (
    <div
      data-testid="org-context-error"
      data-route-org-id={routeOrgId}
      data-ctx-org-id={ctxOrgId ?? ''}
      style={{ padding: 24 }}
    >
      <Alert
        type="error"
        showIcon
        message={t('operations.gate.mismatch_title')}
        description={
          <Space direction="vertical" size={8}>
            <span>
              {t('operations.gate.mismatch_desc', {
                routeOrgId,
                ctxOrgId: ctxOrgId ?? '—',
              })}
            </span>
            <Button onClick={onRetry} data-testid="org-context-error-retry">
              {t('operations.gate.mismatch_retry')}
            </Button>
          </Space>
        }
      />
    </div>
  )
}
