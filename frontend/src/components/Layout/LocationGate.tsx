import type { ReactNode } from 'react'
import { Result, Button, Spin } from 'antd'
import { EnvironmentOutlined } from '@ant-design/icons'
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
  const { sitesLoading, hasLocationAccess } = useSite()

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
        <Spin size="large" tip="Lokasyon bağlamı çözümleniyor…">
          <div style={{ padding: 48 }} />
        </Spin>
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
        title="Atanmış lokasyon yok"
        subTitle={
          'Hesabınıza henüz bir lokasyon atanmamış. Lokasyon erişimi ' +
          'olmadan cihaz, topoloji ve izleme verileri görüntülenemez. ' +
          'Lütfen bir yöneticiyle iletişime geçin.'
        }
        extra={
          <Button
            onClick={() => {
              logout()
              window.location.href = '/login'
            }}
          >
            Çıkış Yap
          </Button>
        }
      />
    </div>
  )
}
