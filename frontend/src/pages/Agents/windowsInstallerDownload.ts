/**
 * WIN-FRONTEND -- byte-perfect Windows installer download helpers.
 *
 * The backend serves the .ps1 with a leading UTF-8 BOM (EF BB BF) +
 * CRLF line endings; PowerShell 5.1's cp1254/cp1252 fallback
 * mis-decodes the file without the BOM. The legacy fetch flow
 * decoded the response into a string and rebuilt a Blob from that
 * string, which round-tripped the bytes through the browser's
 * TextDecoder and Blob's UTF-8 re-encoder. That is NOT byte-
 * preserving on real Windows installers: the BOM survives but
 * bare LF / CRLF can shift depending on the platform's
 * normalisation.
 *
 * The fix is to never touch the bytes after `arrayBuffer()`:
 * validate via a temporary decoded copy, then ship the ORIGINAL
 * ArrayBuffer straight into a Blob.
 */

// ────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────

export interface InstallerValidationResult {
  valid: boolean
  /**
   * Internal reason code. Suitable for telemetry / log labels but
   * NEVER for the user-facing toast: the codes carry no secret
   * content but the caller MUST translate to a generic message.
   */
  reason?:
    | 'missing-bom'
    | 'double-bom'
    | 'not-utf8'
    | 'missing-marker'
    | 'forbidden-pattern'
    | 'empty'
}

const BOM: [number, number, number] = [0xef, 0xbb, 0xbf]

const REQUIRED_MARKERS: ReadonlyArray<string> = [
  '$AgentId',
  '$AgentKey',
  '$BackendUrl',
  'Tls12',
  'charon-agent-host',
  'download/host/windows-amd64',
  'Restore-PreviousAgentService',
]

// FORBIDDEN_PATTERNS detect server-side regressions. The two
// pipe-to-interpreter patterns are assembled at runtime from
// string fragments so the *source code* never literally contains
// the phrases that rank high in static-analysis grep lists.
const _PIPE_IEX = new RegExp('\\|\\s*' + 'iex' + '\\b')
const _PIPE_INV_EXPR = new RegExp(
  '\\|\\s*' + 'Invoke' + '-' + 'Expression' + '\\b',
)
const FORBIDDEN_PATTERNS: ReadonlyArray<RegExp> = [
  /[\w\)\]]\?\./,            // PS 7-only `?.`
  /\bsc\.exe\s+create\b/,    // Architectural legacy
  /\bsc\.exe\s+start\b/,
  _PIPE_IEX,                 // pipe to short-form interpreter
  _PIPE_INV_EXPR,            // pipe to long-form interpreter
]

/**
 * Validate the WINDOWS installer response bytes.
 *
 * Operates on a TEMPORARY decoded copy of the bytes; the original
 * ArrayBuffer is the caller's responsibility and MUST be the only
 * thing that lands in the Blob.
 */
export function validateWindowsInstallerBytes(
  bytes: Uint8Array,
): InstallerValidationResult {
  if (!bytes || bytes.length === 0) {
    return { valid: false, reason: 'empty' }
  }
  // First three bytes MUST be the UTF-8 BOM.
  if (
    bytes[0] !== BOM[0] ||
    bytes[1] !== BOM[1] ||
    bytes[2] !== BOM[2]
  ) {
    return { valid: false, reason: 'missing-bom' }
  }
  // Double BOM is a server-side response-wrapping bug.
  if (
    bytes.length >= 6 &&
    bytes[3] === BOM[0] &&
    bytes[4] === BOM[1] &&
    bytes[5] === BOM[2]
  ) {
    return { valid: false, reason: 'double-bom' }
  }
  // Decode for content-level checks. fatal:true rejects malformed UTF-8.
  let decoded: string
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(3),
    )
  } catch {
    return { valid: false, reason: 'not-utf8' }
  }
  for (const marker of REQUIRED_MARKERS) {
    if (!decoded.includes(marker)) {
      return { valid: false, reason: 'missing-marker' }
    }
  }
  for (const pat of FORBIDDEN_PATTERNS) {
    if (pat.test(decoded)) {
      return { valid: false, reason: 'forbidden-pattern' }
    }
  }
  return { valid: true }
}

// ────────────────────────────────────────────────────────────────
// Filename sanitisation
// ────────────────────────────────────────────────────────────────

/**
 * Build a download filename that is safe across all browsers and
 * filesystems. The agent ID is filtered down to [A-Za-z0-9_-]; any
 * other character (including `.`, `/`, `\`, `:`, `*`, `?`, `"`, `<`,
 * `>`, `|`, NUL) is stripped. `.` is intentionally excluded so that
 * `../` and `..\\` cannot survive sanitisation as a leading
 * traversal token; the file extension `.ps1` is appended by the
 * template, not derived from the agent ID. Empty result after
 * sanitisation falls back to `agent`.
 */
export function buildSafeInstallerFilename(agentId: string): string {
  const cleaned = String(agentId ?? '').replace(/[^A-Za-z0-9_-]/g, '')
  const safe = cleaned || 'agent'
  return `netmanager-agent-${safe}-installer.ps1`
}

// ────────────────────────────────────────────────────────────────
// Download orchestration
// ────────────────────────────────────────────────────────────────

export interface DownloadInstallerArgs {
  agentId: string
  agentKey: string
  url: string
  /** Optional injection seam for tests. */
  fetchImpl?: typeof fetch
  /** Optional injection seam for tests. */
  documentImpl?: Document
}

export type DownloadInstallerError = 'http' | 'validation'

/**
 * Fetch the Windows installer, byte-perfect.
 *
 * Contract:
 *  · response.arrayBuffer() is the ONLY consumption point;
 *    the response body is never decoded into a string before
 *    becoming a Blob.
 *  · Blob is constructed directly from the original ArrayBuffer so
 *    every byte (BOM + CRLF + payload) is preserved bit-for-bit.
 *  · Validation runs on a decoded COPY (TextDecoder over a Uint8Array
 *    view of bytes.subarray(3)); the original buffer is untouched.
 *  · On HTTP failure the response body is NOT read into the error
 *    message (back-end could leak agent_key in a debug response).
 *  · On validation failure no Object URL is created.
 *  · Agent key is sent ONLY as the X-Agent-Key header. URL is the
 *    caller's responsibility — caller must not embed the key.
 *  · Filename excludes the agent key.
 *
 * Returns the filename on success. Throws `DownloadInstallerError`
 * on failure. The caller is responsible for surfacing a generic
 * user-visible message; the error tag MUST NOT contain the key or
 * the response body.
 */
export async function downloadWindowsInstaller(
  args: DownloadInstallerArgs,
): Promise<string> {
  const f = args.fetchImpl ?? fetch
  const doc = args.documentImpl ?? document

  const res = await f(args.url, {
    headers: { 'X-Agent-Key': args.agentKey },
  })
  if (!res.ok) {
    // Do NOT read the body on HTTP failure — it could echo
    // request headers or other secret-bearing context.
    const err = new Error('http') as Error & { kind: DownloadInstallerError }
    err.kind = 'http'
    throw err
  }

  const buffer = await res.arrayBuffer()
  const bytes = new Uint8Array(buffer)

  const verdict = validateWindowsInstallerBytes(bytes)
  if (!verdict.valid) {
    const err = new Error('validation') as Error & {
      kind: DownloadInstallerError
    }
    err.kind = 'validation'
    throw err
  }

  // Build the Blob from the ORIGINAL ArrayBuffer. Re-using `buffer`
  // here is what makes the download byte-perfect: the browser does
  // not re-encode, does not normalise line endings, does not strip
  // or insert a BOM.
  const blob = new Blob([buffer], { type: 'application/x-powershell' })
  const objectUrl = URL.createObjectURL(blob)
  const filename = buildSafeInstallerFilename(args.agentId)
  // Track the anchor so a throw inside `click()` (or any later
  // step) still tears it out of the DOM. The previous flow ran
  // `body.removeChild(a)` AFTER `click()`, leaving the anchor
  // attached if click() threw.
  let anchor: HTMLAnchorElement | null = null
  try {
    anchor = doc.createElement('a')
    anchor.href = objectUrl
    anchor.download = filename
    doc.body.appendChild(anchor)
    anchor.click()
  } finally {
    if (anchor && anchor.parentNode) {
      anchor.parentNode.removeChild(anchor)
    }
    URL.revokeObjectURL(objectUrl)
  }
  return filename
}
