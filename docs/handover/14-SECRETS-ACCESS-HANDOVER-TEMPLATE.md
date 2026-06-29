# 14 — Secrets ve Erişim Devir Şablonu

> ⚠ **Bu dosya bilerek BOŞ bırakılmış bir şablondur.**
> Hiçbir gerçek secret, parola, token, key veya kişisel bilgi **dokümana yazılmaz**.
> Devir veren ekip aşağıdaki tabloları **ayrı, güvenli bir kanal üzerinden** (1Password vault, GPG-encrypted dosya, kurum şifreli mesaj sistemi) doldurur ve devir alan ekibe iletir.
> Kanal **chat, e-posta, Slack DM, ticket attachment, screenshot DEĞİLDİR**.

Devir alan ekip her satırı doldurulmuş + sahibi onaylanmış olarak alır, sonra burayı **boş** olarak commit eder (tarihsel kayıt için).

---

## 1. VPS erişim sahibi

| Alan | Değer (doldurulacak) |
|---|---|
| VPS provider (Hetzner / DigitalOcean / AWS / on-prem ...) | |
| Hesap sahibi (kişi/kurum) | |
| Faturalama hesabı | |
| VPS public IP | |
| SSH bağlantı kullanıcı adı | |
| SSH key sahibi (private key kimde) | |
| SSH key rotation periyodu | |
| Console / KVM erişim portu | |
| Sudo yetkili kullanıcı listesi | |

> Off-handover: yeni ekibin public key'i VPS'e eklenir; eski ekibin key'i belirli bir süre sonra (örnek: 30 gün overlap) silinir.

---

## 2. GitHub erişim sahibi

| Alan | Değer (doldurulacak) |
|---|---|
| Repository | `Coosef/netmanager` (örnek; doğrulanacak) |
| Organization owner | |
| Branch protection ayarları (`main`, `release/*`) | |
| Required reviewers | |
| Required CI checks | |
| Bot / token hesapları (Snyk, frontend QA action) | |
| Secret scanning durumu | |
| Webhook'lar (CF, Slack, vb.) | |

> Off-handover: organizasyon owner devri (GitHub bunu özel akışla yapar).

---

## 3. Domain / Cloudflare erişim sahibi

| Alan | Değer (doldurulacak) |
|---|---|
| Domain registrar | |
| Domain owner | |
| Domain expiry date | |
| Cloudflare account email | |
| Cloudflare 2FA sahibi | |
| Cloudflare zone(s) | |
| DNS kayıtları (A/AAAA/CNAME) | |
| Cloudflare tunnel kullanılıyor mu? | |
| Tunnel sahibi + tunnel token | (token GIZLI — kanal dışı) |
| WAF / Page Rules envanteri | |
| Always Use HTTPS | |
| Bot Fight Mode | |

---

## 4. Production environment secret owner (`.env`)

| Alan | Değer (doldurulacak) |
|---|---|
| `.env` dosyasının VPS'teki path'i | |
| `.env` ACL (sahip + chmod) | |
| `.env` backup'ı nerede tutuluyor (vault) | |
| `.env` son rotation tarihi | |

**`.env` içindeki KEY listesi** (yalnız anahtarlar, değerler asla):

```
POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB
APP_DB_USER, APP_DB_PASSWORD
REDIS_URL (compose'da sabit, .env'de override yapılabilir)
JWT_SECRET, JWT_ALGORITHM, JWT_EXPIRE_MINUTES
CREDENTIAL_ENCRYPTION_KEY
MFA_ISSUER, MFA_TOTP_* (varsa)
INTERNAL_API_KEY
FLOWER_USER, FLOWER_PASSWORD
WINDOWS_AGENT_V2_ENABLED
FRONTEND_TARGET
```

> ⚠ **VERIFY BEFORE HANDOVER**: `backend/app/core/config.py` üzerinden tam `Settings` field listesi extract edilebilir; üretimde set olmayan ama default ile çalışan field'lar belirginleştirilmeli.

---

## 5. Database backup owner

| Alan | Değer (doldurulacak) |
|---|---|
| Backup nerede tutuluyor (S3 / B2 / on-prem / yok) | |
| Backup encryption key sahibi | |
| Backup retention policy | |
| Restore tatbikat tarihi (son) | |
| Backup automation cron / scheduler | |
| Backup sahibinin acil iletişim bilgisi | |

> ⚠ **VERIFY BEFORE HANDOVER**: Mevcut backup automation YOKSA, ilk hafta içinde kurulması zorunludur. Boş bırakmak kabul edilmez.

---

## 6. Agent host erişimleri

Saha tarafındaki her agent host için (bir-bir tablo):

| Alan | Değer (doldurulacak) |
|---|---|
| Lokasyon adı | |
| Organization | |
| Host OS | |
| Host network konumu (private / public) | |
| Host SSH erişim sahibi | |
| Host sudo yetkili kullanıcı | |
| Agent installer kim koştu / installation date | |
| Agent key son rotation | |
| Acil iletişim (saha personeli) | |

> Off-handover: saha personeline yeni ekibin iletişim bilgisi verilir; agent host SSH erişimi yeni ekibe açılır; eski ekibin erişimi planlı tarihte revoke edilir.

---

## 7. Break-glass erişim prosedürü

Tüm normal erişimler kaybolduğunda kullanılacak son çare yolu:

| Alan | Değer (doldurulacak) |
|---|---|
| Break-glass kullanıcı (Postgres superuser) — kim sahip | |
| Break-glass parola nerede saklı | (kanal dışı vault) |
| Break-glass kullanım izni veren makam | |
| Break-glass kullanım sonrası ne yapılır (rotation + audit) | |
| Cloudflare break-glass (panel erişimi alt sahibi) | |
| VPS provider'a hesap geri kazanma akışı | |

**Kural:** Break-glass **kullanıldı mı** — kullanım ekibe duyurulur, audit log'a not düşülür, sonrasında break-glass credential rotate edilir.

---

## 8. Credential rotation kayıt alanı

| Tarih | Hangi secret | Sahibi | Yeni değer kanal dışı vault'a yazıldı | Etkilenen servis(ler) yeniden başlatıldı | Notlar |
|---|---|---|---|---|---|
| — | — | — | — | — | — |

İlk satır boş; her rotation sonrası yeni satır eklenir. Sahibi imzasız satır kabul edilmez.

---

## 9. Offboarding checklist

Bir personel ayrıldığında (devir alan ekipten birisi):

- [ ] GitHub erişim revoke
- [ ] VPS SSH key revoke (`~/.ssh/authorized_keys` temizliği)
- [ ] Cloudflare üyelik revoke
- [ ] 1Password / vault üyelik revoke
- [ ] Agent host SSH erişim revoke (her saha için)
- [ ] Kişinin oluşturduğu Charon kullanıcı hesabı `is_active=False` + soft-deleted
- [ ] Kişinin enroll ettiği agent'lar audit edilir; key rotation gerekli mi
- [ ] Kişiye atanan production-impact ticket'lar başka sahibine devredilir
- [ ] Postmortem / dokümantasyon sahipliği transfer edilir

---

## 10. Doğrulanmış ve doğrulama bekleyen alanlar

### Doğrulanmış
- Şablon yapısı: hiçbir gerçek secret eklenmedi
- Kategoriler kapsayıcı (VPS, GitHub, CF, .env, DB backup, agent, break-glass)

### VERIFY BEFORE HANDOVER
- Her bir kategori sahibi belirlenip değerler ayrı vault'a yazıldı
- Eski erişimlerin revoke edileceği tarih plan edildi
- Break-glass prosedürü dryrun ile test edildi
