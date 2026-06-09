import { useEffect, useState } from 'react'
import { useAuthStore } from '@/store/auth'

/**
 * AUTH-PERSIST-HYDRATION-HOTFIX (2026-06-09) — Zustand persist'in kendi
 * API'sini kullanan hidrasyon hook'u.
 *
 * Eski mimari `_hasHydrated` store state alanı + `setHasHydrated` setter +
 * onRehydrateStorage içinde setter zincirlemesi kullanıyordu. Zustand v5'te
 * bu antipattern; rehydrate sırasında `_hasHydrated=true && token=null`
 * race penceresi açıyordu. ProtectedRoute bu pencerede `<Navigate to="/login">`
 * yaparak Dashboard refresh sonrası kullanıcıyı login ekranına atıyordu.
 *
 * Yeni mimari Zustand persist'in `hasHydrated()` ve `onFinishHydration()`
 * fonksiyonlarını kullanır. Bu fonksiyonlar persist middleware'in INTERNAL
 * state'ini okur — rehydrate gerçekten kesin tamamlandıktan sonra true olur,
 * store state alanı (token/user/permissions) ile race yapmaz.
 */
export const useHasHydrated = (): boolean => {
  const [hydrated, setHydrated] = useState<boolean>(
    () => useAuthStore.persist.hasHydrated(),
  )

  useEffect(() => {
    const unsubFinish = useAuthStore.persist.onFinishHydration(() => {
      setHydrated(true)
    })
    // Edge: mount sırasında rehydrate zaten tamamlanmış olabilir
    // (özellikle hızlı navigation veya SPA içi geçişlerde).
    setHydrated(useAuthStore.persist.hasHydrated())
    return () => {
      unsubFinish()
    }
  }, [])

  return hydrated
}
