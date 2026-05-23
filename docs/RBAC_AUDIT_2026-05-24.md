# RBAC / Yetki Akışı Denetimi — 2026-05-24

Branch: `topology-gold/T8.4-noc-design` · **lokal, push yok**

Kullanıcı raporu: "kullanıcıya lokasyon atayamıyorum, org oluşturma kısmı yok, yetki olayı çok karıştı, bir yetki akış şeması yapıp planlamamız lazım."

Aşağıdaki üç bölüm bağımsız okunabilir:

1. **Mevcut durum** — kodda ne var, hangi katman ne işe yarar
2. **Net problemler** — birinde patlayan bug, geri kalanı UI/dokümantasyon karışıklığı
3. **Akış şeması + matris** — bundan sonra UI'nin hizalanacağı kaynak (single source of truth)
4. **Cleanup planı** — sırayla yapılacaklar, her biri tek commit

---

## 1. Mevcut durum (kod)

Üç bağımsız yetki katmanı çakışıyor. Hepsi gerçek, hepsi kullanılıyor — ama UI bunu net göstermiyor:

| Katman | Tablo / Enum | Ne yapar | Karar verici |
|---|---|---|---|
| **(A) Sistem rolü** | `users.system_role` | Erişimin sınırı (`SUPER_ADMIN` global, `ORG_ADMIN` org-içi, `LOCATION_ADMIN` atandığı lokasyon(lar), `VIEWER` salt-okuma) + RLS GUC'larını + `is_super_admin` bypass'ını sürer. | `require_system_role(...)` dependency'leri; PG RLS politikaları |
| **(B) Lokasyon ataması** | `user_locations` (user × location × `loc_role`) | Bir kullanıcının hangi lokasyon(lar)a erişebileceğini ve oradaki rolünü (`location_manager` / `location_operator` / `location_viewer`) **somut** olarak söyler. `LOCATION_ADMIN` rolündeki bir kullanıcı için zorunlu; `ORG_ADMIN`/`SUPER_ADMIN` org-wide olduğundan opsiyonel. | `resolve_location_context()` her istekte hesaplar; `set_org_context()` GUC'a yazar |
| **(C) Permission set** | `permission_sets` + `user_location_perm` | Action seviyesi izin (devices.edit, ssh, ipam.delete, ...) — RBAC ince taneli kısım. Org-özel set'ler ve global şablonlar var. | `PermissionEngine.resolve()` (RBAC engine) |

**Yatay olarak nasıl çalışır:**
1. Login → `system_role` + token üretilir.
2. Her istek → `get_current_user` çalışır → `resolve_location_context` (user_locations'u okur, X-Location-Id header'ını doğrular) → `set_org_context()` → SQLAlchemy session başlarken RLS GUC'larını set eder → DB sorgusu fiziksel olarak yalnız o satırları döner.
3. Endpoint kararı: ya `require_system_role(...)` (kabaca) ya da `require_permission("devices:edit")` (`PermissionEngine.resolve`, ince taneli).

Bu mimari mantıklı. **Sorun mimari değil — UI, enum'lar ve birkaç M6 kalıntısı.**

---

## 2. Net problemler

### P1 — KRITIK: Kullanıcı güncelleme + oluşturma her zaman 500 atıyor

**Sebep:** M6 final drop'unda `users.role` kolonu silinip yerine sadece-okunur `@property` shim kondu (`return self.system_role`). Aynı satıra **bir setter** koymadık. Ama:

| Dosya | Satır | Çağrı | Sonuç |
|---|---|---|---|
| `endpoints/users.py:121` | `User(... role=payload.role, ...)` | `create_user` | `User.__init__` kwarg yazmaya çalışıyor → AttributeError |
| `endpoints/users.py:173-174` | `setattr(user, field, value)` (field='role') | `update_user` | property yazmaya çalışıyor → AttributeError |
| `endpoints/invites.py:53` | `User(... role=payload.role, ...)` | Davet kabul edilirken | Aynı patlama |

Frontend `drawer` "Kaydet"e basınca önce `PUT /users/{id}` → 500 → toast `Hata` görüyorsun. `setLocations` çağrısı bile yapılmıyor. *Aynı M6 zincirinden bug — `audit-log`'daki `select(User.role)` patlamasıyla [68dd68b](commit) düzeltilmişti; bu üç çağrı da aynı tedaviye muhtaç.*

**Fix:** `User.role` setattr yazılmaz; ya (a) `setattr` öncesi `data` içindeki `role` anahtarı `system_role`'e map'lenir, **veya** (b) `User.role`'e `@role.setter` eklenir ve `system_role`'e yansıtır. (b) daha kolay + iki call site'ı birden kapatır.

### P2 — Frontend rol enum'ları **modası geçmiş**

`frontend/src/types/index.ts`:

```ts
export type UserRole = 'super_admin' | 'admin' | 'org_viewer' | 'location_manager'
                    | 'location_operator' | 'location_viewer' | 'operator' | 'viewer'   // (8)

export type SystemRole = 'super_admin' | 'org_admin' | 'member'                          // (3)

export const ROLE_OPTIONS = [ ... 8 satır ... ]   // Drawer'da hâlâ bu gösteriliyor
```

Backend ise:

```python
class SystemRole(str, Enum):
    SUPER_ADMIN  = "super_admin"
    ORG_ADMIN    = "org_admin"
    LOCATION_ADMIN = "location_admin"
    VIEWER       = "viewer"
    MEMBER       = "member"  # deprecated alias → VIEWER
```

Yani frontend kullanıcıya:
- `admin` (artık `org_admin`),
- `org_viewer` (yok — RLS org-wide görmeyi otomatik veriyor; ayrı rol yok),
- `operator` (yok),
- `location_manager` / `location_operator` (artık `location_admin` ve `loc_role`),
- `viewer`

sunuyor. Kullanıcı `admin` seçince backend belki çalışıyor (string eşleşmiyor → fallback bilinmez davranış), `org_viewer` seçince ne olduğu hiç belli değil.

**Fix:** `UserRole`/`SystemRole` tek bir tipte birleşsin — backend 4-role modeli:

```ts
export type SystemRole = 'super_admin' | 'org_admin' | 'location_admin' | 'viewer'
export const SYSTEM_ROLE_OPTIONS = [
  { value: 'super_admin',    label: 'Süper Admin',    desc: 'Platform genelinde tam yetki — RLS bypass' },
  { value: 'org_admin',      label: 'Org Admin',      desc: 'Kendi organizasyonu içinde tam yetki' },
  { value: 'location_admin', label: 'Lokasyon Admin', desc: 'Atandığı lokasyon(lar)da yönetici' },
  { value: 'viewer',         label: 'Görüntüleyici',  desc: 'Salt-okuma — org veya lokasyon kapsamında' },
]
```

`UserRole`, `ROLE_OPTIONS` silinir; `LOC_ROLE_OPTIONS` zaten doğru.

### P3 — UI yanıltıcı kopyalar (M6 kalıntısı)

- "**Tenant seçin**" — Drawer'da Organizasyon select'inde placeholder. `tenant` öldü; `Organizasyon seçin` olmalı.
- "**Admin ve Org Viewer rolleri tüm lokasyonlara otomatik erişir**" — Aslında: `Super Admin tüm orgların tüm lokasyonlarına; Org Admin sadece kendi org'unun tüm lokasyonlarına otomatik erişir. Location Admin ve Viewer için bu sayfadan lokasyon atayın.`
- Drawer'da `loc_role` görünür adı "Lokasyon Görün..." (truncated) — `Lokasyon Görüntüleyici` taşıyor. Pill genişletilecek veya kısa form (`L. Görüntüleyici`).
- `Davet Oluştur` modal'ında "Rol" select'i `ROLE_OPTIONS.filter(super_admin hariç)` — aynı modası geçmiş listeden çekiyor.

### P4 — Org oluşturma UI'sı yok

Backend `POST /super-admin/orgs` (`super_admin.py:254`) hazır. Frontend client (`superadminApi`'da `listOrgs/getOrg/updateOrg` var; **`createOrg` yok**). SuperAdmin sayfası org listeliyor + askıya alıyor + güncelliyor, ama yeni org butonu yok.

Şu an sistemde 2 organizasyon var ve hep böyle kalacak (insert path sadece DB seed). **Yeni müşteri için org açma akışı eksik.**

**Fix:** `superadminApi.createOrg(payload)` ekle + SuperAdmin sayfasında "Yeni Organizasyon" CTA + modal (name + slug + plan + admin kullanıcısı + admin emaili).

### P5 — "Süper admin dışında kimse tüm lokasyonlara erişemez" beklentisi

Kullanıcı: *"süper admin kısmında kimse tüm lokasyonlara erişemez"* — yani:

> **Super Admin dışında hiç bir rol "tüm lokasyonlar" görünümüne otomatik erişmemeli.**

Backend bu davranışı **kısmen** uyguluyor:
- `org_wide = is_super_admin(user) or is_org_wide(user)` (`request_context.py:159`), ve `is_org_wide` → `SUPER_ADMIN ∨ ORG_ADMIN`.
- Sonuç: `Org Admin` da kendi org'u içinde tüm lokasyonları görüyor.

Bu bilinçli bir karar **mı**, yoksa kullanıcının kafasında bir çelişki **mi** — netleştirmek lazım. İki olası model:

| Model | Org Admin'in yetkisi |
|---|---|
| **Mevcut** (Faz 7) | Kendi org'undaki **tüm lokasyonlar org-wide** — RLS org_id eşleştirir; lokasyon filtresi opsiyonel |
| **Sıkı izolasyon** | Org Admin de `user_locations` üzerinden atandığı lokasyon(lar)la sınırlı; sadece SA platform-wide |

Üçüncü bir orta yol: **mevcudu koru** ama UI'da org admin için tek bir "ALL LOCATIONS" pill'i göster ve "[Lokasyon ata]" CTA'sı koy (opsiyonel kısıtlama).

**Bu kararı sen veriyorsun.** Hangisini istersen ona göre planlayacağım.

### P6 — `PermissionSet` (C katmanı) sayfayla bağlanmıyor

Yetki Yönetimi sayfası `org_viewer`/`member` kavramlarını gösteriyor (B1.3 commit'imde de yine `member` çıkıyor — `is_org_admin` rolü dışındakiler "member" sayılıyor). Backend artık `SystemRole.VIEWER` → role-default permissions atıyor. Permission Set, **role'ün üstüne** action-level grant ekliyor. UI'da:

- "Süper Admin / Org Admin: tüm yetkiler otomatik" mesajı şu an sadece bu ikisi için var; `LOCATION_ADMIN`/`VIEWER` rolündeki kullanıcı için permission set listesi gerekiyor.
- ROLE_COLOR / ROLE_LABEL tablosu 3 değer biliyor (`super_admin / org_admin / member`); `location_admin` / `viewer` yok.

---

## 3. Akış şeması + matris

### 3.1 Yetki katmanları (kim ne karar verir)

```mermaid
flowchart TD
    A[Login: username/password<br/>+ MFA (varsa)] --> B[system_role atanır]
    B --> C{system_role}
    C -->|super_admin| D[RLS bypass: tüm org/loc<br/>X-Org-Id ile scope'a inebilir]
    C -->|org_admin| E[Kendi organizasyonu]
    C -->|location_admin| F[user_locations satırlarıyla<br/>belirlenmiş lokasyonlar]
    C -->|viewer| G[Atanmış lokasyonlar veya<br/>org-wide salt-okuma]

    E --> H[Org içi tüm lokasyonlar<br/>RLS organization_id=user.org]
    F --> I[Aktif location_id<br/>X-Location-Id header]
    G --> I

    H --> J[Endpoint çağrısı]
    I --> J
    D --> J

    J --> K{require_permission?}
    K -->|Evet| L[PermissionEngine.resolve<br/>system_role default + permission_set]
    K -->|Hayır - sadece role| M[require_system_role kontrolü]
    L --> N[DB sorgusu]
    M --> N

    N --> O[RLS politikası<br/>app.current_org_id<br/>app.current_location_id<br/>app.is_super_admin]
    O --> P[Sonuç]
```

### 3.2 Rol → Yetki matrisi (default davranış)

| Rol | RLS davranışı | Lokasyon atama gerekir mi? | Org sınırı? | Default action grant'leri |
|---|---|---|---|---|
| **Super Admin** | Bypass (`app.is_super_admin='on'`) | Hayır | Yok — `X-Org-Id` ile scope'a inebilir | `*` (her şey) |
| **Org Admin** | `organization_id = user.org` | Hayır (org-wide otomatik) | Kendi org'u | device/config/task/user/audit/bulk + onay-review |
| **Location Admin** | `organization_id = user.org` **AND** `location_id ∈ user_locations` | **EVET** — boşsa erişimi yok | Kendi org'u | device CRUD (delete hariç), config push/backup, audit/monitor view |
| **Viewer** | `organization_id = user.org` (opsiyonel `location_id` filtresi) | İsteğe bağlı | Kendi org'u | device/config/task/audit/monitor *view* |

> **Karar bekleniyor:** Org Admin için "kendi org'undaki tüm lokasyonlara otomatik" mi (**Mevcut**), yoksa "atandığı lokasyonlarla sınırlı" mı (**Sıkı**)? P5'e bakın.

### 3.3 Çakışma çözüm sırası (UI'da gösterilecek)

```
1. Super Admin?        →  her şeye erişim, kontrol bitti
2. Org status?         →  archived/suspended → erişim yok / read-only
3. system_role         →  kaba sınırı belirler (yukarıdaki tablo)
4. user_locations      →  Location Admin / Viewer için somut lokasyon listesi
5. PermissionEngine    →  action-level karar (devices.edit gibi)
6. RLS (DB)            →  son güvenlik — un-bypassable, app filtresi unutulursa bile koruma
```

---

## 4. Cleanup planı (sırayla, her madde tek commit)

| # | Madde | Tahmin | Bağımlılık |
|---|---|---|---|
| **F1** | **User.role setter bug'ı** — `@role.setter` ekle (`system_role`'e yaz) — create/update/invite three call site'ı birden onarır. Smoke: drawer'dan kullanıcı düzenle + kaydet, lokasyon ata. | ~15 dk | — |
| **F2** | **Frontend rol enum'larını backend'e hizala** — `UserRole` sil, `SystemRole` = `super_admin/org_admin/location_admin/viewer`, `ROLE_OPTIONS` → `SYSTEM_ROLE_OPTIONS` (açıklama satırı + label). 8 değer → 4 değer. | ~30 dk | F1 |
| **F3** | **UI yanıltıcı metin sweep** — "Tenant seçin" → "Organizasyon seçin", "Admin ve Org Viewer..." mesajı doğru hâline (Super Admin / Org Admin org-wide; Location Admin ve Viewer için lokasyon atayın). `Lokasyon Görün...` truncation: drawer'da daha geniş select veya kısa label `L. Görüntüleyici`. | ~20 dk | F2 |
| **F4** | **PermissionSet sayfası** — `member` etiketi → 4 sistem rolüne göre güncellenmiş `ROLE_LABEL`/`ROLE_COLOR`, "tam yetki otomatik" rozeti SA + Org Admin için. (P6) | ~20 dk | F2 |
| **F5** | **Org oluşturma UI** — `superadminApi.createOrg()` + SuperAdmin sayfası "Yeni Organizasyon" CTA + modal (name + slug + plan + admin email). Backend `POST /super-admin/orgs` zaten var; sadece istemci + UI yazılacak. | ~45 dk | F2 |
| **F6** | **Karar dokümanı: Org Admin scope** — kullanıcı P5'i seçer; ya "mevcudu koru" + UI'da net göster, ya "sıkı izolasyon" + backend `is_org_wide` davranışı değişir + migration smoke. *Karar netleşince commit kapsamı netleşir.* | bağlı | F2, kullanıcı kararı |
| **F7** | **RBAC_AUDIT.md → docs altında kalır** — bu dokümanı reviewable şekilde commit'le ki yeni kişi geldiğinde tek doc'a baksın. | ~5 dk | F1-F5 sonu |

**Sıralama mantığı:** F1 acil bug; F2 enum hizalaması her şeyin temeli; F3-F4 UI metinleri; F5 yeni feature; F6 mimari kararı bekliyor; F7 belgeleme.

**Toplam:** ~2-3 saat F1-F5 ile + F6'nın senin kararına bağlı süresi.

---

## 5. Sana sorum

1. **P5 (Org Admin scope)** — "Mevcut: kendi org'undaki tüm lokasyonlara otomatik" mi, **"Sıkı: Org Admin de `user_locations` ile sınırlı"** mı?
2. **F1-F5 sırasına onay veriyor musun?** F1 (bug fix) hemen ben yapıp pushyalım, gerisi F2'den itibaren onayın gelene kadar bekleyeyim mi?
3. **Tasarım batch'ini (B2.2 VLAN ve sonrası)** F1-F5 bitene kadar dondurayım mı?

Cevaplarına göre todo'yu güncelleyip implementasyona geçiyorum.
