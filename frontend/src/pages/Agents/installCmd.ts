/**
 * Agent installer komut üreticileri — Linux ve Windows.
 *
 * Çıkış kontrat'ı:
 *   - Üretilen string KULLANICIYA OLDUĞU GİBİ KOPYALANIR.
 *   - `<AGENT_ID>`, `<AGENT_KEY>` gibi placeholder ASLA çıktıda
 *     görünmemeli — agent_key + downloadUrl çağrıyı yapan tarafından
 *     gerçek değerlerle inject edilir.
 *
 * Windows komut formatı (PowerShell 5.1 uyumlu):
 *   - TLS 1.2 enforce komutun EN BAŞINDA (Cloudflare TLS 1.2 min;
 *     PS 5.1 default SystemDefault TLS Windows Server 2016/2019'da hâlâ
 *     1.0/1.1 olabilir, edge reddeder).
 *   - PS 7-only syntax YOK: `?.`, `??`, ternary `? :`, `-Parallel` vs.
 *     kullanılmaz. Sadece PS 5.1 dahil her PowerShell sürümünde parse
 *     edilebilen syntax.
 *   - Multiline + backtick line-continuation: tek satır `-c "$h=@{...}"`
 *     formatı PS 5.1 dış shell quoting nedeniyle `$h` değişkenini
 *     bozuyor ve `InvalidLeftHandSide` parser hatası veriyor. Multiline
 *     bu hatayı engeller.
 *   - Komut başında yorum satırı: "Yönetici olarak açın" + "PS 5.1 uyumlu"
 *     bilgisi PowerShell tarafından parse-skip edilir (yorum), kullanıcı
 *     için dokümantasyon görevi görür.
 *
 * Linux komut formatı (mevcut davranış, değişmedi):
 *   - Tek satır curl pipe sudo bash — Bash default'u TLS 1.2+
 *     (Debian/Ubuntu/RHEL modern dağıtımlarda), enforce gerek YOK.
 */


export function buildLinuxInstallCmd(agentKey: string, downloadUrl: string): string {
  // Linux Bash, mevcut davranış korundu.
  return `curl -fsSL -H 'X-Agent-Key: ${agentKey}' '${downloadUrl}' | sudo bash`
}


export function buildWindowsInstallCmd(agentKey: string, downloadUrl: string): string {
  // Windows PowerShell 5.1 uyumlu, multiline + backtick line-continuation.
  // Yorum satırları kullanıcı için dokümantasyon; PowerShell parse-skip eder.
  const lines = [
    '# Windows PowerShell\'i Yonetici olarak acin (PS 5.1 uyumlu)',
    '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
    'Set-ExecutionPolicy Bypass -Scope Process -Force',
    '',
    '$hdr = @{',
    `  "X-Agent-Key" = "${agentKey}"`,
    '}',
    '',
    'iwr `',
    `  -Uri "${downloadUrl}" \``,
    '  -Headers $hdr `',
    '  -UseBasicParsing |',
    '  iex',
  ]
  return lines.join('\n')
}


/**
 * Güvenli kullanıcıya gösterilecek hata mesajı (i18n-uyumlu sabit metin).
 * Backend response body, HTTP status veya internal detayları **göstermez** —
 * agent key veya sunucu detayı sızdırmaz.
 */
export const SAFE_DOWNLOAD_ERROR_MESSAGE_TR =
  'Windows kurulum betiği indirilemedi. Lütfen tekrar deneyin.'

export const SAFE_SCRIPT_VALIDATION_ERROR_MESSAGE_TR =
  'Windows kurulum betiği doğrulanamadı. Lütfen tekrar deneyin.'


/**
 * Backend'den dönen .ps1 script'in beklenen PS 5.1 uyumlu pattern'leri
 * içerdiğini doğrular. Bu fonksiyon **kullanıcıya gösterilmeyen** internal
 * health-check; script içeriği ve agent_key console'a/log'a basılmaz.
 *
 * Pozitif kontroller (VAR olmalı):
 *   - $AgentId değişkeni
 *   - $AgentKey değişkeni
 *   - $BackendUrl değişkeni
 *   - Tls12 satırı
 *
 * Negatif kontrol (OLMAMALI):
 *   - `?.` null-conditional (PS 7-only, PS 5.1'de parser hatası)
 */
export function isValidWindowsInstallerScript(scriptText: string): boolean {
  if (!scriptText || typeof scriptText !== 'string') return false
  // Pozitif: agent template değişkenleri + Tls12
  const required = ['$AgentId', '$AgentKey', '$BackendUrl', 'Tls12']
  for (const token of required) {
    if (!scriptText.includes(token)) return false
  }
  // Negatif: `?.` PS 7-only operator
  // Word/bracket/paren öncesi `?.` regex
  if (/[\w\)\]]\?\./.test(scriptText)) return false
  return true
}
