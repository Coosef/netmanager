import { Navigate, Outlet } from 'react-router-dom'
import { Result, Button, Spin } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '@/store/auth'
import { useSite } from '@/contexts/SiteContext'

/**
 * PR-A — Platform panel guard.
 *
 * Wraps every `/platform/*` route. Only super_admin (ROLE identity, not
 * the currently-active RLS bypass flag) may enter. Anyone else is
 * redirected to `/` — RootRedirect then sends them to their operations
 * home `/app/org/<own>/dashboard`.
 *
 * The shell renders `<Outlet />`; the surrounding AppLayout's sidebar
 * switches to `PlatformSidebar` via `detectPanelMode(pathname)`.
 *
 * Note: the guard uses `useAuthStore.user.system_role` (stable role
 * identity) rather than `useSite().isSuperAdmin` (the bypass-active
 * flag) — a scoped super-admin who has X-Org-Id active still has the
 * role and must be able to walk back to the platform panel.
 *
 * ─────────────────────────────────────────────────────────────────────
 * P0.2 SITECONTEXT HYDRATION RACE + PLATFORM RECOVERY (2026-06-24)
 *
 * Production incident: hard refresh on `/platform/organizations` or
 * `/platform/overview` rendered a FULLY BLANK page. AppLayout skips
 * LocationGate for platform routes (panelMode==='platform') by
 * design — the platform panel operates above tenant scope. But the
 * previous PlatformShell did `if (!ctxResolved) return null` which
 * produced a totally empty DOM during the hydration window. When the
 * sibling hydration race (`useHasHydrated.ts`) left `hydrated` stuck
 * at false, `ctxResolved` stayed false forever, and the operator saw
 * an indefinite blank screen with no spinner, no error, no retry.
 *
 * Replaced with a three-state UI mirroring the LocationGate contract
 * used on the operations side:
 *
 *   1. context loading        → centered Spin with "yükleniyor" tip
 *   2. context error / stuck  → Result(warning) + "Yenile" button
 *                               wired to refetchSite()
 *   3. context ready          → role gate → Outlet
 *
 * Loading/error branches use the same i18n keys the operations
 * LocationGate uses (`location_gate.resolving` / `location_gate.
 * error_title` / `location_gate.retry`) — operator-facing copy is
 * already correct ("Bağlamı çözümleniyor / Bağlantı sorunu / Yenile").
 * No new translations needed.
 */
export default function PlatformShell() {
  const user = useAuthStore((s) => s.user)
  const { ctxResolved, isPlatformSuperAdmin, sitesLoading,
          hasContextFailure, refetchSite } = useSite()
  const { t } = useTranslation()

  // Pre-token guard: no auth state yet → render nothing (the auth
  // store rehydrates synchronously enough that this window is
  // effectively zero, and ProtectedRoute upstream is the canonical
  // pre-token spinner owner).
  if (user == null) return null

  // P0.2 (2026-06-24) — context loading: show a visible spinner
  // instead of the previous `return null` blank screen. Operators
  // never see a totally empty DOM on /platform/* anymore.
  if (sitesLoading) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '60vh',
        }}
        data-testid="platform-shell-loading"
      >
        <Spin size="large" tip={t('platform.shell.loading')}>
          <div style={{ padding: 48 }} />
        </Spin>
      </div>
    )
  }

  // P0.2 (2026-06-24) — context error: visible Result + Yenile.
  // Triggers when sitesLoading went false but ctx is still undefined
  // (idle + empty + hydrated + token == "stuck" state) OR the
  // /context/current fetch genuinely failed. Mirrors LocationGate.
  if (hasContextFailure) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '60vh',
        }}
        data-testid="platform-shell-error"
      >
        <Result
          status="warning"
          title={t('platform.shell.error_title')}
          subTitle={t('platform.shell.error_desc')}
          extra={
            <Button
              type="primary"
              icon={<ReloadOutlined />}
              onClick={() => refetchSite()}
            >
              {t('platform.shell.retry')}
            </Button>
          }
        />
      </div>
    )
  }

  // ctxResolved is the redundant "ctx is non-undefined" guard kept
  // for defense-in-depth. With the loading + error branches above,
  // this branch is reached only when ctx is present.
  if (!ctxResolved) return null

  if (user.system_role !== 'super_admin' && !isPlatformSuperAdmin) {
    return <Navigate to="/" replace />
  }

  return <Outlet />
}
