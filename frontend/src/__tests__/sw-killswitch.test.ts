/**
 * SW Kill-Switch smoke testleri (2026-06-09).
 *
 * frontend/public/sw.js dosyasının kill-switch davranışına uygun olduğunu
 * doğrular. Build sırasında bu dosya dist/sw.js'e olduğu gibi kopyalanır
 * (VitePWA disabled → workbox-precache üretilmez).
 *
 * Beklenen davranış:
 *   - skipWaiting + clients.matchAll + cache temizleme + unregister
 *   - PRECACHE kalıntısı YOK (workbox, precacheAndRoute, NetworkFirst,
 *     NavigationRoute, api-cache, index.html)
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

const SW_PATH = resolve(__dirname, '../../public/sw.js')

describe('SW kill-switch — frontend/public/sw.js', () => {
  it('public/sw.js dosyası mevcut', () => {
    expect(existsSync(SW_PATH)).toBe(true)
  })

  it('beklenen kill-switch davranışlarını içerir', () => {
    const sw = readFileSync(SW_PATH, 'utf-8')

    expect(sw).toContain('skipWaiting')
    expect(sw).toContain("addEventListener('install'")
    expect(sw).toContain("addEventListener('activate'")
    expect(sw).toContain('caches.keys')
    expect(sw).toContain('caches.delete')
    expect(sw).toContain('registration.unregister')
    expect(sw).toContain('clients.matchAll')
    expect(sw).toContain('navigate')
  })

  it('Workbox / precache executable kalıntısı YOK (yorumlar hariç)', () => {
    const sw = readFileSync(SW_PATH, 'utf-8')
    // Yorum satırlarını çıkar (// ve /* */ blokları)
    const code = sw
      .replace(/\/\*[\s\S]*?\*\//g, '')   // /* ... */ blok yorumlar
      .replace(/\/\/.*$/gm, '')             // // satır yorumları

    // Executable kod'da workbox import / runtime YOK olmalı
    expect(code).not.toMatch(/importScripts\s*\(/)
    expect(code).not.toMatch(/workbox-/)
    expect(code).not.toMatch(/precacheAndRoute/)
    expect(code).not.toMatch(/NetworkFirst/)
    expect(code).not.toMatch(/NavigationRoute/)
    expect(code).not.toMatch(/api-cache/)
    expect(code).not.toMatch(/index\.html/)
  })

  it('fetch handler YOK (request\'ler doğrudan ağa gider)', () => {
    const sw = readFileSync(SW_PATH, 'utf-8')
    expect(sw).not.toMatch(/addEventListener\(['"]fetch['"]/)
  })

  it('hassas log kalıntısı YOK (token/password/key/secret)', () => {
    const sw = readFileSync(SW_PATH, 'utf-8')
    // Yorumlar dahil — kill-switch açık metin dökümanına ihtiyacı yok
    expect(sw.toLowerCase()).not.toContain('console.log')
    expect(sw.toLowerCase()).not.toContain('token')
    expect(sw.toLowerCase()).not.toContain('password')
  })

  it('defansif try/catch kullanımı (unregister/navigate fail olsa bile cache temizliği yapılır)', () => {
    const sw = readFileSync(SW_PATH, 'utf-8')
    // En az 3 try/catch bloğu (cache + unregister + clients) olmalı
    const tryCount = (sw.match(/try\s*\{/g) || []).length
    expect(tryCount).toBeGreaterThanOrEqual(3)
  })
})
