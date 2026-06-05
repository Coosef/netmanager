// LANG-INFRA — AntD locale merkezi registry.
//
// Yeni dil eklemek için (örn. Español):
//   1. `npm i antd@latest` kurulumu ile birlikte zaten gelir
//   2. AŞAĞIYA bir satır ekle:
//        import esES from 'antd/locale/es_ES'
//   3. ANTD_LOCALES nesnesine bir satır ekle:
//        es: esES,
//   4. (`i18n/dayjsLocales.ts` + `locales/es.json` eklemeyi unutma.)
//
// Component/page/App.tsx dosyalarına DOKUNULMAZ — sözleşme `i18n/` klasörüdür.
import type { Locale } from 'antd/es/locale'
import trTR from 'antd/locale/tr_TR'
import enUS from 'antd/locale/en_US'
import deDE from 'antd/locale/de_DE'
import ruRU from 'antd/locale/ru_RU'

const ANTD_LOCALES: Record<string, Locale> = {
  tr: trTR,
  en: enUS,
  de: deDE,
  ru: ruRU,
}

/**
 * Verilen i18n dil koduna karşılık gelen AntD locale objesini döner.
 * Bilinmeyen kod gelirse Türkçe fallback.
 */
export function getAntdLocale(code: string): Locale {
  return ANTD_LOCALES[code] ?? ANTD_LOCALES.tr
}

export const SUPPORTED_ANTD_LOCALES = Object.keys(ANTD_LOCALES)
