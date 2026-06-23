import type { ReactNode } from 'react'
import { Result, Button, Spin } from 'antd'
import { EnvironmentOutlined, ReloadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router-dom'
import { useSite } from '@/contexts/SiteContext'
import { useAuthStore } from '@/store/auth'

/**
 * P0.1 HOTFIX (2026-06-23) — Pure-redirect pathnames that must NEVER
 * be wrapped in the LocationGate spinner. These routes render a single
 * `<Navigate>` component (`LegacyRedirect`) and produce no real content;
 * blocking them behind sitesLoading creates the exact deadlock the P0.1
 * hotfix exists to close.
 */
const LEGACY_PURE_REDIRECT_PATHS: ReadonlySet<string> = new Set([
  '/dashboard',
  '/devices',
  '/agents',
])

/**
 * Faz 8 Phase F — gate the application content on a resolved location
 * context.
 *
 * The backend (Phase E) is authoritative: a user with no accessible
 * location fails closed server-side and every location-scoped query
 * returns nothing. This gate gives that state a controlled UI instead
 * of letting pages render as broken empty dashboards:
 *
 *   * while the location context is still resolving → a spinner;
 *   * a user with no accessible location → an explicit "no location"
 *     state, not a half-broken page;
 *   * otherwise → the routed page.
 */
export default function LocationGate({ children }: { children: ReactNode }) {
  const {
    sitesLoading,
    refetchSite,
    hasLocationAccess,
    hasContextFailure,
  } = useSite()
  const { t } = useTranslation()
  const location = useLocation()

  // P0.1 HOTFIX (2026-06-23) — bypass the gate for legacy pure-redirect
  // pathnames so the `LegacyRedirect` <Navigate> mounts even while
  // `sitesLoading` is still true (auth in-flight, hydration race, ctx
  // 401-loop, etc.). Without this bypass, the redirect component never
  // gets a chance to fire and the operator is pinned to the
  // "Lokasyon bağlamı çözümleniyor…" spinner indefinitely. The redirect
  // target itself (`/app/org/:id/...` or `/platform/overview`) is the
  // place where real content + the real location gate live.
  if (LEGACY_PURE_REDIRECT_PATHS.has(location.pathname)) {
    return <>{children}</>
  }

  if (sitesLoading) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '60vh',
        }}
      >
        <Spin size="large" tip={t('location_gate.resolving')}>
          <div style={{ padding: 48 }} />
        </Spin>
      </div>
    )
  }

  // LOGIN-DIRECT-NAVIGATE-FIX (2026-06-10) — `/context/current` fetch
  // gerçekten fail oldu YA DA query idle/settled olmasına rağmen ctx
  // hâlâ undefined ise blank screen yerine görünür error + Yenile butonu.
  // Davranış matrisi:
  //   · sitesLoading=true              → Spin (yukarıdaki blok)
  //   · ctx mevcut                     → children render (aşağıdaki blok)
  //   · sitesError=true && !ctx        → bu blok (görünür error)
  //   · !sitesLoading && !ctx          → bu blok (görünür error, idle stuck)
  // SiteContext.hasContextFailure bu iki durumu birleştirir.
  if (hasContextFailure) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '70vh',
        }}
        data-testid="location-gate-error"
      >
        <Result
          status="warning"
          title={t('location_gate.error_title')}
          subTitle={t('location_gate.error_desc')}
          extra={
            <Button
              type="primary"
              icon={<ReloadOutlined />}
              onClick={() => refetchSite()}
            >
              {t('location_gate.retry')}
            </Button>
          }
        />
      </div>
    )
  }

  if (!hasLocationAccess) {
    return <NoLocationAccess />
  }

  return <>{children}</>
}

/** Controlled empty-state for a user with no assigned location. */
export function NoLocationAccess() {
  const { logout } = useAuthStore()
  const { t } = useTranslation()
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '70vh',
      }}
    >
      <Result
        icon={<EnvironmentOutlined style={{ color: '#f59e0b' }} />}
        status="warning"
        title={t('location_gate.no_access_title')}
        subTitle={t('location_gate.no_access_desc')}
        extra={
          <Button
            onClick={() => {
              logout()
              window.location.href = '/login'
            }}
          >
            {t('header.logout')}
          </Button>
        }
      />
    </div>
  )
}
