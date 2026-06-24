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
 *
 * ─────────────────────────────────────────────────────────────────────
 * P0.2 SITECONTEXT HYDRATION RACE + PLATFORM RECOVERY (2026-06-24)
 *
 * Production incident: hard-refresh sonrası `/app/org/:id/*` üzerinde
 * `Lokasyon bağlamı çözümleniyor…` sonsuza dek dönüyor;
 * `/platform/*` üzerinde tamamen blank ekran. Operatör browser kanıtı:
 *
 *     tokenPresent: true
 *     hydrated:     false    ← stuck
 *     ctx_present:  false
 *     sitesLoading: true
 *
 * Token store'da olduğu halde `hydrated` flag'ı false'ta takılı:
 * persist rehydrate `_hasHydrated = true` ATAMASINI YAPMIŞ ve gerekli
 * setState'leri çalıştırmış (token nedeni), AMA bu hook'un eski
 * implementasyonu `onFinishHydration` listener'ını yalnız
 * `useEffect` içinde subscribe ediyordu. Zustand v5 contract'ında
 * `onFinishHydration` ONCE-ONLY semantik kullanır — listener
 * subscribe edildiğinde rehydrate ZATEN tamamlanmışsa retroaktif
 * çağrı YOK. Sonuç: subscribe-after-fire yarış penceresi açılır,
 * hook hydrated=false döndürür ve SiteContext useQuery
 * `enabled: !!token && hydrated` kilidi açılmaz.
 *
 * Yarışı kapatmak için iki bağımsız savunma katmanı eklendi:
 *
 *   (a) initial useState lazy initializer'a ek olarak useEffect
 *       içinde ÜÇ aşamalı recheck:
 *         · synchronous (effect commit anı)
 *         · queueMicrotask (current task'in microtask kuyruğu)
 *         · setTimeout(0) (task queue fallback — Zustand'in async
 *           rehydrate'i hangi turn'de resolve ederse etsin yakala)
 *       Üç check'in en az biri kesinlikle subscribe-after-fire
 *       penceresinin OUT tarafına düşer ve `hasHydrated()` true
 *       dönerse `setHydrated(true)` ile state'ı güncel hale çeker.
 *
 *   (b) `onHydrate` + `onFinishHydration` listener'ları aynen
 *       korunur. Bunlar GELECEK rehydrate döngülerini (örneğin
 *       cross-tab storage event'leri) yakalar.
 *
 * (a) → ilk hidrasyonu hatasız tamamlar. (b) → sonradan tetiklenen
 * rehydrate döngülerini izler. İki katman da TOGETHER düşmedikçe
 * hook artık false'ta takılamaz.
 */
export const useHasHydrated = (): boolean => {
  const [hydrated, setHydrated] = useState<boolean>(
    () => useAuthStore.persist.hasHydrated(),
  )

  useEffect(() => {
    // P0.2 (2026-06-24) — three-stage recheck closes the subscribe-
    // after-fire race against Zustand v5 persist's once-only
    // `onFinishHydration` contract. The check function is idempotent;
    // calling it three times across different scheduler phases costs
    // nothing AND guarantees we land on the post-hydrate side at
    // least once even when Zustand's async rehydrate resolves in an
    // unexpected turn (slow CPU, throttled tabs, devtools profiler,
    // BroadcastChannel cross-tab sync, etc.).
    const checkAndSet = () => {
      if (useAuthStore.persist.hasHydrated()) {
        setHydrated(true)
      }
    }
    // (1) Synchronous recheck — covers the case where the rehydrate
    //     microtask resolved between the initial useState evaluation
    //     and the first commit's effect phase.
    checkAndSet()
    // (2) Microtask recheck — covers the case where Zustand's
    //     rehydrate microtask is queued AFTER this useEffect runs but
    //     before the next task tick. queueMicrotask runs at the end of
    //     the current microtask queue.
    queueMicrotask(checkAndSet)
    // (3) Task-queue recheck — final fallback for any scheduler that
    //     uses a setTimeout/macrotask path (unusual but defensive).
    const timeoutId = setTimeout(checkAndSet, 0)

    // AUTH-GUARD-TOKEN-FIRST-FIX (2026-06-10) — `onHydrate` listener
    // eklendi. Rehydration BAŞLADIĞINDA flag false'a çekilir; FINISH
    // callback ile true'ya geçer. Daha defansif lifecycle:
    //   start → hydrated: false
    //   finish → hydrated: true
    // ProtectedRoute token-first karar matrisi sayesinde bu hook'un
    // false dönmesi blank screen üretmez (token mevcutsa children
    // render edilir).
    //
    // P0.2 (2026-06-24): listeners stay attached so future rehydrate
    // cycles (cross-tab storage events, manual persist.rehydrate()
    // calls if ever added) still update the hook's state. They are
    // no longer the ONLY mechanism keeping the hook in sync.
    const unsubStart = useAuthStore.persist.onHydrate(() => {
      setHydrated(false)
    })
    const unsubFinish = useAuthStore.persist.onFinishHydration(() => {
      setHydrated(true)
    })
    return () => {
      clearTimeout(timeoutId)
      unsubStart()
      unsubFinish()
    }
  }, [])

  return hydrated
}
