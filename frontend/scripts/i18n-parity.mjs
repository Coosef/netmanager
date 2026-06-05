#!/usr/bin/env node
// LANG-INFRA — i18n locale parity check.
//
// tr.json baseline alınır; en/de/ru'da eksik veya fazla key listelenir.
//
// Kullanım:
//   node scripts/i18n-parity.mjs              → rapor + exit 0
//   node scripts/i18n-parity.mjs --strict     → drift varsa exit 1 (CI için)
//   node scripts/i18n-parity.mjs --fix        → eksik key'leri tr.json
//                                                değeriyle PLACEHOLDER olarak
//                                                en/de/ru'ya ekler.
//                                                ⚠ Gerçek çeviri değildir;
//                                                  çevirmen elle düzeltmeli.
//
// package.json scripts:
//   pnpm i18n:check        / npm run i18n:check
//   pnpm i18n:check:strict / npm run i18n:check:strict
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const LOCALES_DIR = resolve(__dirname, '..', 'src', 'i18n', 'locales')
const BASELINE = 'tr'
const META_KEY = '__meta'

const args = new Set(process.argv.slice(2))
const STRICT = args.has('--strict')
const FIX = args.has('--fix')

/** Yapraktan kök'e tüm anahtar yollarını dot-notation olarak çıkarır. */
function flatten(obj, prefix = '') {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (k === META_KEY) continue
    const path = prefix ? `${prefix}.${k}` : k
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, flatten(v, path))
    } else {
      out[path] = v
    }
  }
  return out
}

/** Dot-notation path'i nested objeye set eder; mevcut dalları korur. */
function setByPath(obj, path, value) {
  const parts = path.split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]
    if (cur[p] === undefined || typeof cur[p] !== 'object' || Array.isArray(cur[p])) {
      cur[p] = {}
    }
    cur = cur[p]
  }
  cur[parts[parts.length - 1]] = value
}

function readLocale(code) {
  const path = join(LOCALES_DIR, `${code}.json`)
  return { path, data: JSON.parse(readFileSync(path, 'utf8')) }
}

function listLocaleCodes() {
  return readdirSync(LOCALES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
}

function main() {
  const codes = listLocaleCodes()
  if (!codes.includes(BASELINE)) {
    console.error(`✗ Baseline locale ${BASELINE}.json bulunamadı.`)
    process.exit(2)
  }

  const baseline = readLocale(BASELINE)
  const baselineFlat = flatten(baseline.data)
  const baselineKeys = new Set(Object.keys(baselineFlat))

  console.log(`Baseline:  ${BASELINE}.json — ${baselineKeys.size} key`)
  console.log('')

  let totalMissing = 0
  let totalExtra = 0
  const others = codes.filter((c) => c !== BASELINE).sort()
  const fixedFiles = []

  for (const code of others) {
    const { path, data } = readLocale(code)
    const flat = flatten(data)
    const keys = new Set(Object.keys(flat))

    const missing = [...baselineKeys].filter((k) => !keys.has(k)).sort()
    const extra = [...keys].filter((k) => !baselineKeys.has(k)).sort()

    totalMissing += missing.length
    totalExtra += extra.length

    if (missing.length === 0 && extra.length === 0) {
      console.log(`✓ ${code}.json — parity OK (${keys.size} key)`)
    } else {
      console.log(`✗ ${code}.json — ${keys.size} key`)
      if (missing.length) {
        console.log(`  Eksik (${missing.length}):`)
        const preview = missing.slice(0, 20)
        preview.forEach((k) => console.log(`    - ${k}`))
        if (missing.length > preview.length) {
          console.log(`    … ve ${missing.length - preview.length} key daha`)
        }
      }
      if (extra.length) {
        console.log(`  Fazla (${extra.length}) — baseline'da yok:`)
        const preview = extra.slice(0, 10)
        preview.forEach((k) => console.log(`    - ${k}`))
        if (extra.length > preview.length) {
          console.log(`    … ve ${extra.length - preview.length} key daha`)
        }
      }

      if (FIX && missing.length) {
        for (const k of missing) {
          setByPath(data, k, baselineFlat[k])
        }
        writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8')
        fixedFiles.push({ code, count: missing.length })
        console.log(
          `  ⚠ --fix uygulandı: ${missing.length} key tr.json değeriyle ` +
          `PLACEHOLDER olarak eklendi. Çevirmen elle düzeltmeli.`,
        )
      }
    }
    console.log('')
  }

  console.log('─'.repeat(60))
  console.log(
    `Toplam: ${others.length} dil; ${totalMissing} eksik key, ` +
    `${totalExtra} fazla key.`,
  )

  if (FIX && fixedFiles.length) {
    console.log('')
    console.log('Placeholder eklenen dosyalar:')
    fixedFiles.forEach((f) => console.log(`  - ${f.code}.json: ${f.count} key`))
    console.log('')
    console.log('⚠ ÖNEMLİ: --fix gerçek çeviri yapmaz. Eklenen değerler tr.json')
    console.log('  değeridir; çevirmen elle düzeltmeli.')
  }

  const drift = totalMissing > 0 || totalExtra > 0
  if (drift && STRICT) {
    console.log('')
    console.log('Strict mode: drift tespit edildi, exit 1.')
    process.exit(1)
  }
}

try {
  main()
} catch (e) {
  console.error(`✗ Beklenmeyen hata: ${e.message}`)
  process.exit(2)
}
