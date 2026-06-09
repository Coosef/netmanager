/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// SW KILL-SWITCH (2026-06-09) — VitePWA plugin TAMAMEN DEVRE DIŞI.
//
// Sebep: Stale Workbox SW + cached old precache manifest bazı kullanıcı
// profillerinde "siyah ekran" yaşatıyor (rollback sonrası dahi devam etti).
// Kök nedeni nginx /sw.js için `Cache-Control: max-age=31536000, immutable`
// veriyordu (yanlış); browser eski sw.js'i 1 yıl tutuyordu, yeni sw.js'i
// fetch etmiyordu. Eski SW eski JS hash'lerini istiyor → 404 → React mount
// edemiyor → siyah ekran.
//
// Çözüm: VitePWA'yı tamamen kapat. `public/sw.js` artık kill-switch dosyası
// (cache temizler + unregister eder + reload). Vite build sırasında public/
// → dist/ olduğu gibi kopyalanır, ek workbox-*.js veya precache manifest
// üretilmez. Nginx config'i /sw.js için no-store header'ı verecek şekilde
// düzeltildi (nginx/nginx.conf).
//
// İçe alma: `vite-plugin-pwa` devDependency olarak package.json'da kalır
// (gelecekte yeniden enable etmek için); import bilerek kaldırıldı.

export default defineConfig({
  plugins: [
    react(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 3000,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: process.env.VITE_API_URL || 'http://localhost:8000',
        changeOrigin: true,
        ws: true,
        proxyTimeout: 180000,
        timeout: 180000,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            // Forward real client IP so audit logs record the actual WAN address
            const existingFwd = req.headers['x-forwarded-for'] as string | undefined
            const realIp = existingFwd
              ? existingFwd.split(',')[0].trim()
              : (req.socket.remoteAddress || '').replace(/^::ffff:/, '')
            if (realIp) {
              proxyReq.setHeader('X-Forwarded-For', realIp)
              proxyReq.setHeader('X-Real-IP', realIp)
            }
          })
        },
      },
      '/ws': {
        target: process.env.VITE_WS_URL || 'ws://localhost:8000',
        ws: true,
      },
    },
  },
  // ── Vitest ─────────────────────────────────────────────────────────────
  // The Playwright perf harness (`frontend/perf/`) uses `*.spec.ts` files
  // that import from `@playwright/test`. Vitest's default discovery would
  // pick those up and fail — exclude the whole tree. The harness has its
  // own runner (`npx playwright test --config=perf/playwright.config.ts`).
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', 'perf/**'],
  },
})
