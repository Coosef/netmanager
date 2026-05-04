import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
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
