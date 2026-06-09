/*
 * Service Worker Kill-Switch — 2026-06-09
 *
 * Bu dosya BİR PWA service worker'ı DEĞİL — eski Workbox SW'lerden kurtulmak
 * için bir kill-switch'tir. Üç şey yapar:
 *   1. Tüm Cache Storage key'lerini siler (eski workbox-precache-* dahil)
 *   2. Kendini unregister eder (artık SW yok)
 *   3. Açık tab/window'ları reload eder (temiz state ile başlasın)
 *
 * Fetch handler YOK — request'ler doğrudan ağa gider, SW araya girmez.
 *
 * Üretim akışı:
 *   - Vite VitePWA plugin DISABLE edildi (vite.config.ts)
 *   - Vite build sırasında bu dosya public/ → dist/ olduğu gibi kopyalanır
 *   - Nginx /sw.js için Cache-Control: no-store (nginx.conf)
 *   - Mevcut SW kontrolündeki browser'lar bir sonraki navigation'da bu sw.js'i
 *     fetch eder, install + activate olur, kendini siler — otomatik recovery.
 */

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys()
      await Promise.all(keys.map((key) => caches.delete(key)))
    } catch (e) { /* ignore */ }

    try {
      await self.registration.unregister()
    } catch (e) { /* ignore */ }

    try {
      const clients = await self.clients.matchAll({ type: 'window' })
      clients.forEach((client) => {
        try {
          client.navigate(client.url)
        } catch (e) { /* ignore */ }
      })
    } catch (e) { /* ignore */ }
  })())
})
