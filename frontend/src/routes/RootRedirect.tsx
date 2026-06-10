import { Navigate } from 'react-router-dom'
import { Spin } from 'antd'
import { useAuthStore } from '@/store/auth'
import { useHasHydrated } from '@/hooks/useHasHydrated'

/**
 * P0 LOGIN-AUTH-LOOP-FIX (2026-06-10) — `<Route index>` artık doğrudan
 * `<DashboardPage>` render etmiyor; bunun yerine auth state + hidrasyon
 * temelli güvenli yönlendirme yapan bu component'i kullanıyor.
 *
 * Mevcut bug:
 *   - Eski davranış: `<Route index element={<DashboardPage />}>` → `/` her
 *     zaman Dashboard render ediyordu.
 *   - Login `finalizeSession` + `navigate('/')` sırasında bir kombinasyon
 *     sürekli `/` route'una page-reload tetikliyor → nginx access log'da
 *     1 saniyede 6 `GET /` istek görüldü. Kullanıcı boş/siyah ekran
 *     görüyordu.
 *   - Memory'deki "dashboard-refresh-auth-backlog" hipotezi: ProtectedRoute
 *     hidrasyon penceresinde Navigate to="/login" + Login.tsx useEffect
 *     authenticated kullanıcıyı tekrar `/` route'una atıyor → re-mount,
 *     re-fetch, re-render → tarayıcı reload döngüsü.
 *
 * Yeni davranış:
 *   - `/` → bu component → hidrate olmadıysa minimal spinner (boş div
 *     değil — kullanıcı uygulamanın boot olduğunu görür), hidrate
 *     olduktan sonra:
 *       · authenticated → `<Navigate to="/dashboard" replace>`
 *       · unauthenticated → `<Navigate to="/login" replace>`
 *   - `/dashboard` route'u App.tsx'te ayrıca tanımlı. Login success direkt
 *     `/dashboard`'a navigate eder (`/` üzerinden geçmez).
 *
 * Tasarım kararları:
 *   - `null` render etmek YERİNE minimal Spin — kullanıcı blank screen
 *     yerine "yükleniyor" görür. Çok büyük değil, sayfa ortasında küçük.
 *   - `replace: true` history pollution önler. Geri tuşu /login → /dashboard
 *     çevriminde sıkışmaz.
 *   - `useHasHydrated` Zustand persist'in kendi API'sini kullanır (eski
 *     `_hasHydrated` race penceresi yok — bkz. `hooks/useHasHydrated.ts`).
 */
export default function RootRedirect() {
  // AUTH-GUARD-TOKEN-FIRST-FIX (2026-06-10) — ProtectedRoute ile aynı
  // matrise hizalandı (bkz. App.tsx ProtectedRoute):
  //   token VAR              → /dashboard (hydrated bağımsız)
  //   token YOK + !hydrated  → görünür <Spin> (blank YOK)
  //   token YOK + hydrated   → /login
  // Hidrasyon kalıcı false kalsa bile token mevcutsa kullanıcı bloklanmaz.
  const hydrated = useHasHydrated()
  const token = useAuthStore((s) => s.token)

  if (token) return <Navigate to="/dashboard" replace />
  if (!hydrated) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
        }}
        data-testid="root-redirect-loading"
      >
        <Spin size="large" />
      </div>
    )
  }
  return <Navigate to="/login" replace />
}
