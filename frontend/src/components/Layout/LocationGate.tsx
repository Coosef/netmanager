import type { ReactNode } from 'react'
import { Result, Button, Spin } from 'antd'
import { EnvironmentOutlined, ReloadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useSite } from '@/contexts/SiteContext'
import { useAuthStore } from '@/store/auth'

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
  const { sitesLoading, sitesError, refetchSite, hasLocationAccess } = useSite()
  const { t } = useTranslation()

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
  // gerçekten fail oldu + ctx hâlâ yok durumunda blank screen yerine
  // görünür error + Yenile butonu. retry mekanizması SiteContext'te
  // (retry: 1) zaten var; bu fallback son recovery noktası.
  // i18n locale dosyalarına dokunmamak için (widening Δ=0) metin inline TR
  // — gelecekte common.network_error + common.retry key'leri 4 dilde
  // eklenebilir.
  if (sitesError) {
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
          title="Bağlantı sorunu"
          subTitle="Lokasyon bilgisi yüklenemedi. Lütfen yeniden deneyin."
          extra={
            <Button
              type="primary"
              icon={<ReloadOutlined />}
              onClick={() => refetchSite()}
            >
              Yenile
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
