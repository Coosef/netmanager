import { Spin } from 'antd'
import { useTranslation } from 'react-i18next'

/**
 * AUTH-GUARD-TOKEN-FIRST-FIX (2026-06-10) — ProtectedRoute artık `null`
 * yerine bu görünür loading'i render eder.
 *
 * Eski mimari (App.tsx ProtectedRoute):
 *   if (!hydrated) return null
 * Bu hidrasyon penceresinde DOM'a HİÇ bir element basmıyordu → kullanıcı
 * blank screen görüyordu (rootText="", dashboardVisible=false canlı
 * browser raporuyla doğrulandı).
 *
 * Yeni mimari token-first karar matrisi:
 *   token VAR  → children (hydrated bağımsız)
 *   token YOK + hydrated FALSE → bu component (görünür loading)
 *   token YOK + hydrated TRUE  → <Navigate to="/login">
 *
 * data-testid="protected-route-loading" → entegrasyon test marker'ı.
 * Hidrasyon kalıcı false kalsa bile kullanıcı blank yerine "Yükleniyor…"
 * görür. Token store'a yazıldığı an children render olur — hidrasyon
 * flag'i route'u bloke etmez.
 */
export default function ProtectedRouteLoading() {
  const { t } = useTranslation()
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
      }}
      data-testid="protected-route-loading"
    >
      <Spin size="large" tip={t('auth_guard.loading')}>
        <div style={{ padding: 48 }} />
      </Spin>
    </div>
  )
}
