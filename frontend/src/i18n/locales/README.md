# Dil Dosyaları

Bu klasör NetManager UI'ının çeviri dosyalarını içerir. Frontend her
yeniden başlatıldığında `*.json` dosyaları **otomatik** keşfedilir; ek
bir kod değişikliği gerekmez.

> **Sözleşme (LANG-INFRA):** Yeni dil eklemek için yalnız `src/i18n/`
> klasöründe çalışılır. Component, page veya `App.tsx` dosyalarına
> dokunmak gerekmez.

## Yeni dil eklemek

1. **Mevcut bir dili kopyala** (örn. `tr.json` → `es.json`)
   ```bash
   cp src/i18n/locales/tr.json src/i18n/locales/es.json
   ```

2. **`__meta` bloğunu güncelle** — yeni dosyanın en üstünde:
   ```json
   {
     "__meta": { "name": "Español", "flag": "🇪🇸", "region": "España" },
     ...
   }
   ```
   * `name` — Settings > Genel sayfasında gösterilen ad
   * `flag` — bayrak emoji (yoksa 🌐 kullanılır)
   * `region` — alt satır metni (opsiyonel)

3. **AntD locale registry'sine satır ekle** — `src/i18n/antdLocales.ts`:
   ```ts
   import esES from 'antd/locale/es_ES'
   const ANTD_LOCALES = {
     // ...
     es: esES,
   }
   ```
   (AntD locale paketleri JS modülü olarak gelir; JSON'a gömülemediği
   için ayrı registry'de tutulur — yine merkezi `i18n/` klasöründe.)

4. **dayjs locale yan-etki import'u** — `src/i18n/dayjsLocales.ts`:
   ```ts
   import 'dayjs/locale/es'
   ```

5. **Değerleri çevir** — JSON'daki tüm `"value"` kısımlarını yeni dile.
   Anahtarlar (`"key"`) hep İngilizce kalır:
   ```json
   "nav.dashboard": "Panel"   →   "nav.dashboard": "Dashboard"
   ```

6. **Parity kontrolü** — eksik / fazla key yok mu doğrula:
   ```bash
   pnpm i18n:check
   # veya
   npm run i18n:check
   ```

   Geçici placeholder olarak (çevirmen sonra elle düzeltir):
   ```bash
   pnpm i18n:fix
   ```
   > ⚠ **`--fix` gerçek çeviri yapmaz.** Eksik key'leri tr.json
   > değeriyle doldurur (placeholder). Çevirmen elle düzeltmeli.

7. **Frontend'i yenile** (Vite dev veya `npm run build` sonrası reload):
   - Settings > Genel altında yeni dil otomatik görünür.
   - Üst menüden seçilebilir; tercih `localStorage.nm-lang`'a yazılır.
   - AntD bileşenleri (DatePicker, Pagination vs.) + dayjs (zaman
     ifadeleri) yeni dile **otomatik** geçer; component değişikliği
     gerekmez.

## Parity kontrolü

`tr.json` baseline; diğerlerinde aynı key seti olmalı.

| Komut | Davranış |
|---|---|
| `npm run i18n:check` | Drift raporu, exit 0 (uyarı amaçlı) |
| `npm run i18n:check:strict` | Drift varsa exit 1 (CI/build) |
| `npm run i18n:fix` | Eksikleri tr değeriyle PLACEHOLDER doldurur ⚠ |

> **NOT:** `i18n:check:strict` script olarak mevcut ama henüz CI/build
> hook'una bağlı değil. LANG-FIX-W3 (locale parity tamamlama) bittikten
> sonra CI entegrasyonu yapılacak.

## Eksik çeviri davranışı

JSON'da bulunmayan bir anahtar varsa, **Türkçe** fallback kullanılır
(`fallbackLng: 'tr'`). Bu pragmatik bir güvenlik ağıdır; **kalıcı
çözüm değildir** — eksik key'ler tamamlanmalı (`pnpm i18n:check` ile
takip).

## Şu anki diller

| Kod  | İsim     | Bayrak |
|------|----------|--------|
| `tr` | Türkçe   | 🇹🇷     |
| `en` | English  | 🇬🇧     |
| `ru` | Русский  | 🇷🇺     |
| `de` | Deutsch  | 🇩🇪     |
