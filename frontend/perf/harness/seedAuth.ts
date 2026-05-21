/**
 * Auth seeding for the perf harness — T8.3.B.
 *
 * The topology surface is gated by `<ProtectedRoute>`, which redirects
 * to `/login` when the Zustand auth store has no token. The perf
 * harness is not testing the auth flow; we want to measure the topology
 * page in isolation. So before navigation we:
 *
 *   1. Inject a synthetic super-admin record into `localStorage` under
 *      the same key (`netmgr-auth`) the Zustand `persist` middleware
 *      reads. The token is a placeholder — backend never sees it
 *      because (2).
 *   2. Intercept every `/api/v1/**` and `/ws/**` request and abort it.
 *      With the live dev server's Vite proxy pointed at localhost:8000,
 *      a real backend would 401 the placeholder token and the response
 *      interceptor (`src/api/client.ts:32`) would `logout()` mid-spec
 *      and bounce us back to `/login`. Aborting at the page level keeps
 *      the perf run deterministic whether or not the backend is up.
 *      NOTE: pattern is `/api/v1/**`, NOT `/api/**` — Vite serves source
 *      modules from `/src/api/*.ts` and we must not abort those.
 *
 * The stress loader (`?stress=N&perf=1`) builds the graph in-page from
 * a deterministic seed — no API round-trip required for the measurement.
 */
import type { Page } from '@playwright/test'

const STORAGE_KEY = 'netmgr-auth'

// Shape mirrors `useAuthStore` in `src/store/auth.ts`. Zustand persist
// wraps state in `{ state, version }`.
const FAKE_AUTH_PAYLOAD = {
  state: {
    token: 'perf-harness-placeholder-token',
    user: {
      id: 1,
      username: 'perf-harness',
      role: 'super_admin',
      system_role: 'super_admin',
      org_id: 1,
    },
    permissions: null,
  },
  version: 0,
}

/**
 * Seed the auth store via an init script. Must be called BEFORE
 * `page.goto(...)` so the script runs ahead of the bundle's first
 * Zustand store-creation pass.
 */
export async function seedFakeAuth(page: Page): Promise<void> {
  await page.addInitScript(
    ({ key, payload }) => {
      try {
        window.localStorage.setItem(key, JSON.stringify(payload))
      } catch {
        /* localStorage may be unavailable in odd contexts; harvest will
         * surface the symptom via `overlay_missing` warning instead. */
      }
    },
    { key: STORAGE_KEY, payload: FAKE_AUTH_PAYLOAD },
  )
}

/**
 * Block every `/api/v1/**` and WS upgrade so the page does not depend on
 * a live backend. Pair with `seedFakeAuth` for fully self-contained
 * measurement runs.
 */
export async function blockBackendTraffic(page: Page): Promise<void> {
  // Match the axios client's `baseURL = '/api/v1'`. Using `/api/**` here
  // would also abort Vite's dev-mode source files at `/src/api/*.ts`,
  // taking the whole bundle down and leaving `#root` empty.
  await page.route('**/api/v1/**', (route) => route.abort('failed'))
  // Sigma + r3f don't open WS connections; the live-events stream
  // (T8.2 channel) opens one. Abort it too so a reconnect storm
  // doesn't perturb frame timings.
  await page.route('**/ws/**', (route) => route.abort('failed'))
}

/**
 * Inject a tiny "viewport-locking" stylesheet before navigation.
 *
 * Why: Sigma v3's constructor checks `container.getBoundingClientRect().
 * height === 0` and throws `Sigma: Container has no height`. The topology
 * root div is `position: absolute, inset: 0` — in a desktop browser the
 * Layout's `minHeight: 100vh` gives the html element enough resolved
 * height that the initial containing block can size to ~1080 px and the
 * absolute descendant inherits that. In headless Chromium the body's
 * default content-driven height interacts oddly with the absolute
 * positioning; Sigma's `useEffect` runs before layout has flushed and
 * reads 0.
 *
 * The fix is harness-only — we don't touch production CSS. We inject a
 * stylesheet via `addInitScript` that pins `html, body, #root` to the
 * viewport. Result: container height is non-zero before Sigma runs.
 *
 * Idempotent and side-effect-free w.r.t. the measurement itself: the
 * stress graph + overlay still mount through the same code path the
 * user sees in their own Chrome, so the "single source of truth" lock
 * (T8.3.0 §11) holds.
 */
export async function pinViewportHeight(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // The first three rules give the html / body / #root chain explicit
    // heights so `position: absolute, inset: 0` further down resolves
    // against a definite viewport.
    //
    // The fourth rule is the critical one: AppLayout's per-route wrapper
    // (`<div key={location.pathname}>` inside `.ant-layout-content`) is
    // unpositioned and has no explicit height. TopologyV2's root is
    // `position: absolute, inset: 0`, so it resolves against the
    // initial containing block — but Sigma's `useEffect` reads
    // `container.offsetHeight` synchronously and a 0 race-window has
    // been observed in headless Chromium 131. Making the wrapper an
    // explicit positioned container with a definite min-height removes
    // the race: the absolute child anchors to it directly, with a
    // pre-flushed height.
    const css = `
      html, body { margin: 0; padding: 0; height: 100%; width: 100%; }
      #root { height: 100%; width: 100%; }
      .ant-layout-content > div { position: relative; min-height: calc(100vh - 60px); }
    `
    const inject = () => {
      const style = document.createElement('style')
      style.setAttribute('data-perf-harness', 'viewport-lock')
      style.textContent = css
      document.head.appendChild(style)
    }
    if (document.head) inject()
    else document.addEventListener('DOMContentLoaded', inject, { once: true })
  })
}
