/**
 * Login success redirect davranışı — P0 LOGIN-AUTH-LOOP-FIX sözleşmesi.
 *
 * Bu testler Login/index.tsx içindeki redirect hedefinin **`/dashboard`**
 * olduğunu kaynak kod düzeyinde sabitler (regression koruması). Eski hedef
 * `'/'` page-reload döngüsünü tetikleyebiliyordu (nginx access log:
 * 1 sn'de 6 GET /).
 *
 * @testing-library/react olmadan saf string-match smoke (mevcut codebase
 * pattern: sw-killswitch.test.ts).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const LOGIN_SOURCE = readFileSync(
  resolve(__dirname, '../index.tsx'),
  'utf-8',
)


describe('Login redirect — `/dashboard` hedefi (P0 loop fix sözleşmesi)', () => {
  it("authenticated useEffect — `navigate('/dashboard', { replace: true })`", () => {
    // useEffect'te hidrate olmuş authenticated kullanıcı `/login` ekranını
    // açtıysa Dashboard'a dönmeli — `/'`'a değil.
    expect(LOGIN_SOURCE).toMatch(/navigate\(['"]\/dashboard['"],\s*\{\s*replace:\s*true\s*\}\)/)
  })

  it("finalizeSession — 800ms setTimeout sonrası `/dashboard`'a navigate", () => {
    // Eski: window.setTimeout(() => navigate('/'), 800)
    // Yeni: window.setTimeout(() => navigate('/dashboard', ...), 800)
    expect(LOGIN_SOURCE).toMatch(
      /setTimeout\(\(\)\s*=>\s*navigate\(['"]\/dashboard['"]/,
    )
  })

  it("kaynak kodda `navigate('/')` page-reload tetikleyici çağrısı YOK", () => {
    // Tüm Login/index.tsx içinde root navigate kalmamalı (regression guard).
    // `\/dashboard` veya `\/login` AMA salt `'/'` YOK.
    expect(LOGIN_SOURCE).not.toMatch(/navigate\(['"]\/['"](\s*[,)])/)
  })

  it("kaynak kodda `setTimeout(.., navigate('/'), 800)` legacy pattern YOK", () => {
    expect(LOGIN_SOURCE).not.toMatch(/setTimeout\(\(\)\s*=>\s*navigate\(['"]\/['"]\),\s*800\)/)
  })
})


describe('Layout brand click — `/dashboard` (sidebar + topnav)', () => {
  const SIDEBAR_SRC = readFileSync(
    resolve(__dirname, '../../../components/Layout/Sidebar.tsx'),
    'utf-8',
  )
  const TOPNAV_SRC = readFileSync(
    resolve(__dirname, '../../../components/Layout/TopNav.tsx'),
    'utf-8',
  )

  it('Sidebar brand → navigate("/dashboard")', () => {
    expect(SIDEBAR_SRC).toContain("navigate('/dashboard')")
    expect(SIDEBAR_SRC).not.toMatch(/navigate\(['"]\/['"][)\s;,]/)
  })

  it('TopNav brand → navigate("/dashboard")', () => {
    expect(TOPNAV_SRC).toContain("navigate('/dashboard')")
    expect(TOPNAV_SRC).not.toMatch(/navigate\(['"]\/['"][)\s;,]/)
  })
})
