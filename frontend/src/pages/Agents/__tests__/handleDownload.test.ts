/**
 * NocAgents handleDownload — source-match wiring guards.
 *
 * These are cheap regression guards that the wiring stays intact.
 * The authoritative behavioural test lives in
 * `createdModal.component.test.tsx` (real jsdom + Testing Library
 * render against the named export).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const SRC = readFileSync(
  resolve(__dirname, '../NocAgents.tsx'),
  'utf-8',
)

describe('NocAgents — source guards (component test is authoritative)', () => {
  it('does NOT import or call the byte-perfect Windows helper while WINDOWS_AGENT_DEVELOPMENT_PAUSED', () => {
    // The call site is intentionally absent so that the disabled
    // Windows button + handleDownload early-return cannot
    // accidentally regress into a live download. The helper itself
    // (windowsInstallerDownload.ts) is preserved verbatim and its
    // dedicated test file still runs — a future WINDOWS AGENT
    // RESUME GO commit re-adds the import + call site.
    expect(SRC).not.toMatch(/from\s+['"]\.\/windowsInstallerDownload['"]/)
    expect(SRC).not.toContain('downloadWindowsInstaller(')
  })

  it('only imports buildLinuxInstallCmd from installCmd (Windows builder gone)', () => {
    expect(SRC).toMatch(/from\s+['"]\.\/installCmd['"]/)
    expect(SRC).toContain('buildLinuxInstallCmd')
    expect(SRC).not.toContain('buildWindowsInstallCmd')
  })

  it('does NOT round-trip the response through res.text()', () => {
    expect(SRC).not.toContain('res.text()')
    expect(SRC).not.toContain('await res.text()')
  })

  it('does NOT construct a Blob from a decoded string', () => {
    expect(SRC).not.toMatch(/new\s+Blob\(\s*\[\s*text\s*\]/)
  })

  it('forbids `agent_key` in URL or filename literal', () => {
    expect(SRC).not.toMatch(/[?&]agent_key=/)
    expect(SRC).not.toMatch(/[?&]X-Agent-Key=/)
    expect(SRC).not.toMatch(/\.ps1[^"`]*agent\.agent_key/)
    expect(SRC).not.toMatch(/agent\.agent_key[^"`]*\.ps1/)
  })

  it('does not contain iwr | iex or Invoke-Expression', () => {
    expect(SRC).not.toMatch(/\|\s*iex\b/)
    expect(SRC).not.toContain('Invoke-Expression')
  })

  it('exports CreatedModal as a named export for component tests', () => {
    expect(SRC).toMatch(/export\s+function\s+CreatedModal/)
  })

  it('Windows branch does NOT render the manual install command block', () => {
    // The copy/paste block lives in a `platform === "linux"`
    // sub-conditional now. We assert the constraint at source level
    // because the markup change is the actual P0-2 fix.
    expect(SRC).toMatch(/platform === 'linux'\s*&&\s*installCmd/)
  })

  it('uses i18n keys for the active Linux failure + coming-soon Windows hint', () => {
    // The duplicate "primary hint" key was consolidated away. The
    // Windows failure keys are NOT referenced from NocAgents.tsx
    // while WINDOWS_AGENT_DEVELOPMENT_PAUSED is in effect (no
    // Windows download => no Windows failure path) — but the i18n
    // keys themselves are preserved in the locale files for a
    // future resume.
    expect(SRC).not.toContain("t('agents.windows_download_primary_hint')")
    expect(SRC).not.toContain("t('agents.windows_download_failed')")
    expect(SRC).not.toContain("t('agents.windows_validation_failed')")
    // Linux is the only active platform; its failure key still drives the alert.
    expect(SRC).toContain("t('agents.linux_download_failed')")
    // The Windows path now points at the coming-soon copy instead.
    expect(SRC).toContain("t('agents.windows_coming_soon_message')")
    expect(SRC).toContain("t('agents.windows_coming_soon_tooltip')")
  })

  it('selects the failure key based on the active platform', () => {
    // The Linux failure path previously raised the Windows i18n key.
    // Source-level guarantee that the platform check is in place.
    expect(SRC).toMatch(/platform === ['"]windows['"]\s*[?]/)
  })

  it('preserves the Linux downloadInstallerFile call site verbatim', () => {
    expect(SRC).toContain(
      'agentsApi.downloadInstallerFile(agent.id, agent.agent_key, platform, base)',
    )
  })

  it('keeps the concurrent download guard (synchronous ref)', () => {
    // The previous `if (downloading) return` was async-stale; two
    // rapid synthetic clicks could both observe false. Now backed
    // by a ref so the guard flips synchronously.
    expect(SRC).toMatch(/downloadingRef\.current/)
    expect(SRC).toMatch(/if\s*\(\s*downloadingRef\.current\s*\)\s*return/)
  })

  it('does not log or alert anything containing the agent key', () => {
    expect(SRC).not.toMatch(/console\.(log|error|warn|info|debug)\([^)]*agent\.agent_key/)
    expect(SRC).not.toMatch(/alert\(\s*agent\.agent_key/)
    expect(SRC).not.toMatch(/alert\(\s*e\?\.message\s*\)/)
    expect(SRC).not.toMatch(/alert\([^)]*\+\s*e\.message/)
  })
})
