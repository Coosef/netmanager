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

  it("finalizeSession — setTimeout(navigate, 800) KALDIRILDI (race fix)", () => {
    // DASHBOARD-INIT-ROUTER-FIX (2026-06-10): setTimeout(() => navigate(...), 800)
    // race üretiyordu. setAuth() useEffect'i (471) HEMEN tetikler ve
    // navigate('/dashboard', replace) yapar. setTimeout redündan + cleanup
    // yoktu → unmount sonrası timer fire ediyor, SiteContext mid-fetch
    // kesintiye uğruyordu.
    expect(LOGIN_SOURCE).not.toMatch(
      /setTimeout\(\s*\(\)\s*=>\s*navigate\(['"]\/dashboard['"]/,
    )
    expect(LOGIN_SOURCE).not.toMatch(
      /window\.setTimeout\(\s*\(\)\s*=>\s*navigate\b/,
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

  it("finalizeSession DOĞRUDAN navigate('/dashboard', { replace: true }) çağırır (PR #72)", () => {
    // LOGIN-DIRECT-NAVIGATE-FIX (2026-06-10): setAuth + setStep(3) sonrası
    // useEffect'e bırakmadan doğrudan navigate. Race önler. POST 200 sonrası
    // step 3 UI ("Yönlendiriliyor…") stuck kalmaz.
    // finalizeSession bloğunda en az 1 navigate('/dashboard', replace) çağrısı.
    expect(LOGIN_SOURCE).toMatch(
      /const finalizeSession[\s\S]*?navigate\(['"]\/dashboard['"],\s*\{\s*replace:\s*true\s*\}\)[\s\S]*?\n  \}/,
    )
  })

  it("useEffect navigate hala /dashboard (replace) hedefi koruyor (idempotent fallback)", () => {
    expect(LOGIN_SOURCE).toMatch(
      /navigate\(['"]\/dashboard['"],\s*\{\s*replace:\s*true\s*\}\)/,
    )
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
