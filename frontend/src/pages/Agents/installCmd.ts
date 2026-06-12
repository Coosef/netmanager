/**
 * Linux installer command builder.
 *
 * The Windows command builder was removed in the WIN-FRONTEND
 * post-CI review #2: the only safe UX for the Windows installer
 * is the .ps1 file download (see windowsInstallerDownload.ts).
 * A copy/paste PowerShell snippet would either (a) interpolate the
 * agent key into a string that lands in the user's shell history
 * or (b) require server-injected literals that any small validation
 * gap would turn into a code-injection seam.
 *
 * Linux keeps the historical contract because the user's only
 * primary workflow there is still curl + sudo bash; there is no
 * cross-platform shell-history attack model worth optimising for,
 * and the line is byte-identical to the v1 installer the field
 * already trusts.
 */
export function buildLinuxInstallCmd(agentKey: string, downloadUrl: string): string {
  return `curl -fsSL -H 'X-Agent-Key: ${agentKey}' '${downloadUrl}' | sudo bash`
}
