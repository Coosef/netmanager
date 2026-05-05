import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['network-icon.svg', 'icon-192.svg', 'icon-512.svg'],
      manifest: {
        name: 'NetManager',
        short_name: 'NetManager',
        description: 'Çok Satıcılı Ağ Yönetim Platformu — Cisco, Aruba, Ruijie',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'any',
        scope: '/',
        start_url: '/',
        lang: 'tr',
        categories: ['productivity', 'utilities'],
        icons: [
          {
            src: 'icon-192.svg',
            sizes: '192x192',
            type: 'image/svg+xml',
          },
          {
            src: 'icon-512.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,svg,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: /^\/api\//,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache',
              networkTimeoutSeconds: 10,
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 300,
              },
            },
          },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
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
})
