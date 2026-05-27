# Dil Dosyaları

Bu klasör NetManager UI'ının çeviri dosyalarını içerir. Frontend her
yeniden başlatıldığında `*.json` dosyaları **otomatik** keşfedilir; ek
bir kod değişikliği gerekmez.

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

3. **Değerleri çevir** — JSON'daki tüm `"value"` kısımlarını yeni dile.
   Anahtarlar (`"key"`) hep İngilizce kalır:
   ```json
   "nav.dashboard": "Panel"   →   "nav.dashboard": "Dashboard"
   ```

4. **Frontend'i yenile** (Vite dev veya `npm run build` sonrası reload):
   - Settings > Genel altında yeni dil otomatik görünür.
   - Üst menüden seçilebilir; tercih `localStorage.nm-lang`'a yazılır.

## Eksik çeviri davranışı

JSON'da bulunmayan bir anahtar varsa, **Türkçe** fallback kullanılır
(`fallbackLng: 'tr'`). Yeni dilin tüm anahtarları tamamlamasına gerek
yok — eksik kalanlar Türkçe gösterilir.

## Şu anki diller

| Kod  | İsim     | Bayrak |
|------|----------|--------|
| `tr` | Türkçe   | 🇹🇷     |
| `en` | English  | 🇬🇧     |
| `ru` | Русский  | 🇷🇺     |
| `de` | Deutsch  | 🇩🇪     |
