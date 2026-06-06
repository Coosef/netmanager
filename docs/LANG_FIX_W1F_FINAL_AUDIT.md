# LANG-FIX W1-F FINAL AUDIT — Pre-Deploy Report

**Tarih:** 2026-06-06
**Branch:** `t10/w1f-final-audit` (W1-F3 merge sonrası, origin/main `57c4ee4`)
**Baseline:** W1 (final shipped `b32abe7`, 2026-06-05) + W1-F1/F2/F3 (3 PR merged)

Bu rapor `LANG-FIX W1-F (F1+F2+F3)` paketinin production deploy edilmeden önce
gerçek görünür UI yüzeyinde kalan boşlukları ölçer. **W1 Final Audit (2026-06-05)
ile birebir karşılaştırılabilir** — aynı `lang_audit_w1f.mjs` script + aynı filtre listesi.

---

## ÖZET — deploy kararı için tek sayfada

| Soru | Cevap |
|---|---|
| W1-F kapsamındaki 3 sayfada (TerminalSessions / Settings / Users) canlı kodda kalan **gerçek defect** var mı? | ⚠️ **2 adet** — Users sayfasında 2 toast string i18n'a alınmamış (`Davet iptal edilemedi`, `Bu lokasyon zaten eklenmiş`). Cleanup mini PR'da düzeltilecek. |
| W1-F paket 4 dil parity'i bozdu mu? | ❌ **Hayır.** TR 2289 / EN 2246 / DE 2203 / RU 2203. Toplam **215 eksik key** (W3 scope), W1-F1+F2+F3 **sıfır widening**. |
| W1 → W1-F net azalma (audit script ile) | **3243 → 2813 = −430 visible UI literal candidate.** Live code (DeviceDetail.tsx legacy hariç). |
| Deploy bloklayıcı var mı? | **Yok.** 2 toast residual cleanup PR'da temizlenecek; teknik literal/marka/protocol keepers KURAL-uyumlu. |
| Mini PR sonrası deploy hazır mı? | ✅ **Evet.** W1 deploy paterni (frontend-only + `--no-deps`) doğrudan uygulanabilir. |

---

## 1) Güncel hardcoded literal sayısı

Audit script (heuristic, `t()` çağrıları + teknik blocklist filtreli) — **2026-06-06**:

| Kategori | Adet |
|---|---:|
| Form label (`label="..."` + `rule.label`) | **964** |
| JSX child text (`<span>foo</span>` vb.) | **917** |
| Title / Tooltip title | **580** |
| Placeholder | **193** |
| Toast / Notification | **131** |
| Confirm button (`okText`/`cancelText`) | **74** |
| Alert / Validation message | **71** |
| Alert description | **43** |
| Form extra hint | **7** |
| Tooltip | **7** |
| Input addon | **1** |
| **TOPLAM (raw)** | **2 988** |
| DeviceDetail.tsx (1868 LOC dead code) hariç **live code** | **2 813** |

## 2) W1 başlangıcı → W1-F sonu karşılaştırması

### Toplam (live code, DeviceDetail.tsx hariç)

| Tarih | Aşama | Findings |
|---|---|---:|
| 2026-06-05 (W1 audit) | W1-E shipped | 3 243 |
| 2026-06-06 (W1-F audit) | **W1-F3 shipped** | **2 813** |
| | **NET AZALMA** | **−430 (−13.3%)** |

### W1-F kapsamındaki 3 sayfa karşılaştırması

| Sayfa | W1 audit (öncesi) | W1-F audit (sonrası) | Δ | Sprint |
|---|---:|---:|---:|---|
| TerminalSessions | 35 | 0 (listede yok) | **−35** | W1-F1 |
| Settings | 379 | 39 | **−340** | W1-F2 |
| Users | 58 | 3 | **−55** | W1-F3 |
| **W1-F toplam etki** | **472** | **42** | **−430** | — |

W1-F net azalma **−430** literal = audit aritmetiği toplam azalmayla **birebir eşleşiyor** (Settings'in büyük payı bu).

### Mevcut Settings residuals (39) — analiz

Tüm 39 finding **deliberate keeper** veya **false-positive**:

| Tip | Sayı | Örnek |
|---|---:|---|
| Protocol / teknik akronim | ~10 | `SMTP Host`, `SMTP Port`, `TLS`, `Webhook URL`, `SSH`, `SNMP`, `Community String`, `Port`, `v3 (USM)` |
| Brand / vendor / channel name | ~8 | `Slack`, `Microsoft Teams`, `Telegram`, `Bug`/`Task`/`Incident`/`Story`/`Epic` (Jira issue types), `Charon v1.0` |
| Email/URL placeholder örneği | ~7 | `smtp.example.com`, `user@example.com`, `123456:ABC...` (Telegram bot token örneği), `ATATT3xFfGF0...` (Atlassian token), `NET`, `admin`, `public`, `Charon1`, `llama3.2` |
| JSON syntax placeholder | 1 | `{"Authorization": "Bearer ..."}` |
| Email/SMS akronim (MFA method tag) | 2 | MfaTab `Email`, `SMS` |
| JSX expression yanlış yakalanmış (false-positive) | ~6 | `Promise`, `err ?`, `v ? dayjs...`, vb. — kod fragmenti, gerçek UI metni değil |
| KURAL: Marka literal | 1 | `Charon v1.0` |

**SETTINGS'TE GERÇEK DEFECT YOK.**

### Mevcut Users residuals (3)

| # | Satır | Tip | Literal | Tip |
|---|---|---|---|---|
| 1 | 117 | Toast | `"Davet iptal edilemedi"` (revoke invite mutation onError) | **⚠️ Gerçek defect — i18n kaçırıldı** |
| 2 | 229 | Toast | `"Bu lokasyon zaten eklenmiş"` (addLocAssignment uyarı) | **⚠️ Gerçek defect — i18n kaçırıldı** |
| 3 | 379 | JSX text | `"MFA"` (table column header akronim) | ✅ KURAL-uyumlu teknik akronim |

**2 toast string W1-F3 conversion'da kaçırıldı** (mutation handler içlerinde). Cleanup mini PR'da düzeltilecek.

### TerminalSessions residuals — 0

W1-F1 audit'ta listede yok (≤ minimum eşik). W1-F1 conversion eksiksiz.

---

## 3) Kalan en büyük sayfalar (W1-F dışı, W2 scope)

Top 20 — yüksekten düşüğe:

| Sıra | Sayfa | Findings | W2 sprint adayı |
|---|---|---:|---|
| 1 | Agents | 185 | ✅ |
| 2 | Monitor | 166 | ✅ |
| 3 | Topology | 130 | ✅ |
| 4 | Playbooks | 105 | ✅ |
| 5 | BackupCenter | 101 | ✅ |
| 6 | Reports | 99 | ✅ |
| 7 | Permissions | 89 | ✅ (W1-D'de dokunulmamıştı) |
| 8 | AlertRules | 87 | ✅ |
| 9 | SuperAdmin | 86 | ✅ |
| 10 | Incidents | 84 | ✅ |
| 11 | Firmware | 83 | ✅ |
| 12 | DriverTemplates | 79 | ⚠️ Önceki W1-D rule: "MUST NOT be touched" — Sürücü Şablonları sayfası özel |
| 13 | Ipam | 75 | ✅ |
| 14 | MacArp | 73 | ✅ |
| 15 | AssetLifecycle | 72 | ✅ |
| 16 | TopologyV2 | 63 | ✅ |
| 17 | ChangeManagement | 62 | ✅ |
| 18 | ConfigTemplates | 61 | ✅ |
| 19 | BandwidthMonitor | 58 | ✅ |
| 20 | VlanManagement | 56 | ✅ |

**W1-F kapsamı dışındaki 50+ sayfa W2 scope.** En büyük 5 (Agents/Monitor/Topology/Playbooks/BackupCenter) toplam **687 finding** — W2 ilk fazı bunlar olabilir.

---

## 4) Kalan locale gap listesi

`npm run i18n:check`:

| Dil | Eksik | İçerik |
|---|---:|---|
| EN | 43 | `help.faq_*` (W3 scope, FAQ namespace başlangıçtan eksik) |
| DE | 86 | help.faq_* (79) + `devices.bulk_fetch_info_*` (3) + `topology.{blast_radius, blast_critical, blast_safe, filter_layer}` (4) |
| RU | 86 | Aynı dağılım (help.faq_* 79 + devices 3 + topology 4) |
| **Toplam eksik** | **215** | |

### Deploy bloklayıcı olmayan gap (mini PR scope)

| Kapsam | DE | RU | Toplam | Eylem |
|---|---:|---:|---:|---|
| `devices.bulk_fetch_info_*` (3 key) | 3 | 3 | 6 | Mini PR — küçük çeviri eki |
| `topology.{blast_*, filter_layer}` (4 key) | 4 | 4 | 8 | Mini PR — küçük çeviri eki |
| **Mini PR pre-deploy temizlik** | **7** | **7** | **14** | — |

### Mini PR sonrası locale state

| Dil | Eksik (mini PR sonrası) |
|---|---:|
| EN | 43 (help.faq_* W3 scope) |
| DE | 79 (help.faq_* W3 scope — pre-deploy temizliği değil) |
| RU | 79 (help.faq_* W3 scope) |
| **Toplam** | **201** (sırf W3 scope) |

---

## 5) Synonym konsolidasyon etkisi

W1 audit (2026-06-05) 9 konsolidasyon adayı tespit etmişti. Mevcut durumda **bazıları zaten W1-F sırasında yapıldı**:

| # | W1 audit önerisi | W1-F'de yapıldı mı? | Açıklama |
|---|---|---|---|
| 1 | `devices.bulk_lifecycle.apply` → `common.apply` | ⏳ Hayır | Mini PR'a alınabilir |
| 2 | `devices.detail.ports.row.poe_cancel` → `common.cancel` | ⏳ Hayır | Mini PR'a alınabilir |
| 3 | `devices.form.submit_update` → `common.update` (yeni) | ✅ **Yapıldı** (W1-F2) — `common.update` zaten ekledim |
| 4 | `devices.detail.actions_tab.update_ok` → `common.update` | ✅ **Yapıldı** (`common.update` mevcut) |
| 5 | `devices.delete_error` / `users.update_error` → `common.update_failed` | ⏳ Hayır | İsteğe bağlı |
| 6 | `dashboard.refresh` → `common.refresh` | ⏳ Hayır | Refresh action kullanım noktaları çok — risk var |
| 7 | `devices.detail.actions.refresh_btn` → `common.refresh` | ⏳ Hayır | Aynı not |
| 8 | `devices.detail.actions_tab.btn_refresh_page` → `common.refresh` | ⏳ Hayır | Aynı not |
| 9 | `devices.csv.result_errors` → `common.error` | ⏳ Hayır | Mini PR'a alınabilir |

**Net W1-F otomatik kazanımı:** common.update ve common.refresh referansları çoktan W1-F2'de mevcut → 9 adaydan **2 dolaylı çözüm**.

**Mini PR scope (cleanup):**
- 2 Users toast eksik (gerçek defect)
- 7 locale gap DE/RU (deploy bloklayıcısı değil ama hijyen)
- 5 synonym konsolidasyon (düşük risk, opsiyonel)

Tahmini mini PR delta: ~35 satır JSON + 2 component edit + tsc/vitest/build/parity.

---

## 6) Deploy bloklayıcı analizi

| Kategori | Durum | Aksiyon |
|---|---|---|
| Component-level bug / regression | ❌ Yok | — |
| tsc/vitest/build fail | ❌ Yok | — |
| Parity widening | ❌ Yok | — |
| Pre-existing locale gap (W3 scope) | ⚠️ 215 eksik | Mini PR ile 14 azaltıldı (target 201) |
| Visible UI defect (Users 2 toast) | ⚠️ 2 toast i18n eksik | **Mini PR'da düzeltilmeli** |
| Backend / API breaking change | ❌ Yok (frontend-only) | — |
| Demo path sayfalar (TerminalSessions + Settings + Users) çevirili | ✅ Evet (Users 2 toast hariç) | Mini PR sonrası tam |
| W1 sayfaları regresyon (Dashboard/Devices/DeviceDetail/Racks) | ❌ Yok | — |

**SONUÇ: Mini PR sonrası deploy bloklayıcı YOK.**

---

## 7) SSH Session Termination implementation öncesi son durum

PR #7 (`docs/SSH_SESSION_TERMINATION_DESIGN.md`, 1077 satır) hâlâ açık. **W1-F deploy tamamlanmadan implementation başlatılmaz** (kullanıcı kararı, 2026-06-06).

### Tasarım dokümanı ile mevcut kod uyumluluğu

| Tasarım gerekliliği | Mevcut kod durumu | Hazır mı? |
|---|---|---|
| `terminal_sessions:terminate` yeni RBAC verb | `SYSTEM_ROLE_PERMISSIONS` map mevcut | ✅ |
| Yeni `exit_reason='force_closed'` | `TerminalSessionLog.exit_reason` String(32) | ✅ migration YOK |
| `audit_logs` tablosuna yeni action | Mevcut tablo + `_scoping` hook | ✅ |
| Redis pub/sub `terminal:terminate` kanalı | `get_redis()` helper mevcut | ✅ |
| WS handler subscribe task | `ws.py` ssh_terminal_ws — `revalidator` task paterni mevcut | ✅ |
| Frontend TerminalSessions ekranı i18n hazır | ✅ **W1-F1 ile tamam** — `terminal_sessions.*` namespace mevcut, terminate button keyleri eklemek için temiz baseline |
| `terminal_sessions.terminate.*` namespace | ❌ Henüz yok — Implementation PR'ında eklenecek (tasarım dokümanında listelendi) |

### W1-F deploy ile SSH implementation arasındaki sıra (kullanıcı kararı)

```
PR #10 merge ✅
→ W1-F Final Audit (bu rapor) ✅
→ Locale gap + synonym cleanup mini PR ⏳
→ Final smoke + W1-F deploy ⏳
→ SSH Session Termination implementation (PR #7 baseline) ⏳
→ W2 sprint (Agents/Monitor/Topology...) ⏳
```

SSH implementation **W1-F deploy'a bağlı değil** (tasarım dokümanında belirtildi) — paralel ilerleyebilir ama kullanıcı sırayı tercih etti.

---

## 8) Cleanup mini PR scope (önerilen)

`t10/lang-fix-w1f-cleanup` branch — single atomic commit:

| # | Değişiklik | Etki |
|---|---|---|
| 1 | Users/index.tsx satır 117 toast → `t('users.invite.toast_revoke_failed')` (yeni key) | 1 gerçek defect fix |
| 2 | Users/index.tsx satır 229 toast → `t('users.locations.toast_already_added')` (yeni key) | 1 gerçek defect fix |
| 3 | DE `devices.bulk_fetch_info_*` (3 key) ekle | Pre-existing gap |
| 4 | RU `devices.bulk_fetch_info_*` (3 key) ekle | Pre-existing gap |
| 5 | DE `topology.{blast_radius, blast_critical, blast_safe, filter_layer}` (4 key) ekle | Pre-existing gap |
| 6 | RU `topology.{blast_*, filter_layer}` (4 key) ekle | Pre-existing gap |
| 7 | (Opsiyonel) 5 synonym konsolidasyon: `bulk_lifecycle.apply → common.apply`, `poe_cancel → common.cancel`, `csv.result_errors → common.error`, `devices.delete_error → common.update_failed`, `users.update_error → common.update_failed` | Hijyen — risk düşük |

### Mini PR delta tahmini

| Tip | Adet |
|---|---:|
| Yeni JSON satır (4 dil) | ~16 (4 dil × 4 yeni key) |
| TR yeni 2 toast key (`toast_revoke_failed`, `toast_already_added`) | 2 × 4 = 8 |
| DE/RU eksik key gap doldurma | 7 × 2 = 14 |
| Component edit | 2 satır |
| (Opsiyonel) synonym refactor | ~10-20 satır |
| **Tahmini toplam delta** | **~50-70 satır** |

**Süre tahmini:** ~30-45dk

---

## 9) Deploy readiness kararı

| Kriter | Durum |
|---|---|
| W1-F1 + W1-F2 + W1-F3 tüm PR merged | ✅ (446ae4f, 2921e7e, 57c4ee4) |
| Test pipeline yeşil (her PR'da) | ✅ |
| Parity widening = 0 | ✅ |
| KURAL-E1..E5 uygulandı | ✅ |
| Backend/API değişikliği yok | ✅ |
| 4 dil parity 215 sabit | ✅ |
| Gerçek defect kaldı mı | ⚠️ 2 toast (Users) — **cleanup PR ile düzeltilecek** |
| 7 locale gap (pre-existing) | ⚠️ Hijyen — **cleanup PR ile temizlenecek** |
| Browser smoke (kullanıcı tarafında) | ⏳ Cleanup merge sonrası |
| Frontend-only deploy patern (W1 deploy 2026-06-05) | ✅ Uygulanabilir |
| Rollback tag stratejisi (W1 paterniyle) | ✅ |
| SSH Session Termination implementation öncesi durum | ✅ Tasarım hazır, deploy'a bağlı değil |

**KARAR: Cleanup PR + final smoke sonrası deploy READY.**

Önerilen sıra (kullanıcı tarafından onaylanmış):

```
1. ✅ PR #10 merge (yapıldı, bu rapor branch'inden önce)
2. ✅ W1-F Final Audit (bu doküman)
3. ⏳ Cleanup mini PR (2 Users toast + 14 locale + ~5 synonym)
4. ⏳ Cleanup PR merge + final smoke (tsc + vitest + build + i18n:check)
5. ⏳ W1-F deploy planı güncelle (W1_DEPLOY_PLAN paterniyle)
6. ⏳ Deploy GO iste (kullanıcıdan explicit)
7. ⏳ VPS deploy (W1 deploy paterni, frontend-only --no-deps)
8. ⏳ Browser smoke matrisi (7 ekran × 4 dil = 28 hücre)
9. ⏳ Deploy log dokümanı
10. ⏳ SSH Session Termination implementation (deploy sonrası)
11. ⏳ LANG-FIX W2 sprint planlaması (Agents/Monitor/Topology vd.)
```

---

## EK — Audit araç ve veriler

- **Scanner:** `/tmp/lang_audit_w1f.mjs` (Node 22+, plain regex + JSON parser, t() içerikleri dışlanır; W1 audit ile aynı filtre listesi)
- **Ham bulgular:** `/tmp/audit_w1f_findings.json` (2988 finding + byCat + byDir)
- **W1 audit baseline:** `docs/LANG_FIX_FINAL_AUDIT.md` (2026-06-05 — t10/lang-fix-final-audit branch'i merge edildi)
- **W1-F1 commit:** `446ae4f` (PR #8)
- **W1-F2 commit:** `2921e7e` (PR #9)
- **W1-F3 commit:** `57c4ee4` (PR #10)
- **Mevcut origin/main HEAD:** `57c4ee4` (W1-F3 merge)
- **Audit branch:** `t10/w1f-final-audit` (sadece bu rapor, kod değişikliği yok)

Mevcut audit script gelecek W2 sprintlerde de aynı baseline'la kullanılır: her sprint
sonu `node /tmp/lang_audit_w1f.mjs` → toplam delta görülebilir.
