# 17 — Access & Ownership Matrix

> **Amaç:** Charon / NetManager production stack'ini ayakta tutan **her erişim katmanının** Primary + Backup Owner'ı, erişim yöntemi, MFA gerekliliği ve son doğrulama tarihinin şablonu. Bu paket commit'lendiğinde **boş** durur; teslim günü devir alan/veren ekip birlikte doldurur.

> **Kırmızı çizgiler:** Bu dosya hiçbir parola, key, token, hesap parolası içermez. Yalnız **kim** ve **nasıl** sorularına cevap verir. Gerçek değerler ayrı bir parola kasası ([14-SECRETS-ACCESS-HANDOVER-TEMPLATE.md](14-SECRETS-ACCESS-HANDOVER-TEMPLATE.md)) üzerinden devredilir.

## Genel kural

- **Single owner kabul edilmez.** Her sistem için en az bir Backup Owner olmalı. Tek kişiye bağlı erişim **handover acceptance'ı bloklar** ([15 §K](15-ACCEPTANCE-AND-HANDOVER-CHECKLIST.md)).
- **MFA zorunluluğu işaretlenmeli.** MFA gerekli olduğu halde aktif değilse → RISK ACCEPTED + plan gerekir.
- **Son doğrulama tarihi**, "Bu sahibin gerçekten bu erişime sahip olduğunu en son ne zaman test ettik?" sorusunun cevabıdır. 90 günden eski ise re-validate.

---

## 1. Source code & CI/CD

| Sistem/Alan | Primary Owner | Backup Owner | Erişim Yöntemi | MFA Gerekli mi | Son Doğrulama | Not |
|---|---|---|---|---|---|---|
| GitHub repository admin (Coosef/netmanager) |  |  |  | ☐ |  |  |
| Branch protection ayar sahibi |  |  | GitHub UI |  ☐ |  |  |
| GitHub Actions secrets owner |  |  | GitHub UI |  ☐ |  |  |
| CI bot / token sahibi (Snyk, vb.) |  |  |  |  ☐ |  |  |
| Release tag oluşturma yetkisi |  |  |  |  ☐ |  |  |

---

## 2. VPS / Host

| Sistem/Alan | Primary Owner | Backup Owner | Erişim Yöntemi | MFA Gerekli mi | Son Doğrulama | Not |
|---|---|---|---|---|---|---|
| VPS provider hesabı (faturalama) |  |  |  |  ☐ |  |  |
| VPS root erişimi (SSH) |  |  | SSH key |  ☐ |  |  |
| VPS sudoer kullanıcısı |  |  | SSH key |  ☐ |  |  |
| Console / KVM erişimi |  |  | Provider panel |  ☐ |  |  |
| Docker daemon yönetimi |  |  | SSH + sudo |  ☐ |  |  |

---

## 3. Cloudflare / DNS / Domain

| Sistem/Alan | Primary Owner | Backup Owner | Erişim Yöntemi | MFA Gerekli mi | Son Doğrulama | Not |
|---|---|---|---|---|---|---|
| Domain registrar hesabı |  |  |  |  ☐ |  |  |
| Cloudflare hesabı |  |  | CF panel |  ☐ |  |  |
| Cloudflare API token sahibi |  |  | (vault) |  ☐ |  |  |
| DNS kayıt yönetimi |  |  |  |  ☐ |  |  |
| Cloudflared tunnel sahibi (varsa) |  |  |  |  ☐ |  |  |
| WAF / Page Rules sahibi |  |  |  |  ☐ |  |  |

---

## 4. Production environment secrets

| Sistem/Alan | Primary Owner | Backup Owner | Erişim Yöntemi | MFA Gerekli mi | Son Doğrulama | Not |
|---|---|---|---|---|---|---|
| Üretim `.env` dosyası sahibi |  |  | VPS SSH + vault |  ☐ |  |  |
| `JWT_SECRET` sahibi |  |  | vault |  ☐ |  |  |
| `CREDENTIAL_ENCRYPTION_KEY` (Fernet) sahibi |  |  | vault |  ☐ |  |  |
| `INTERNAL_API_KEY` (X-Internal-Key) sahibi |  |  | vault |  ☐ |  |  |
| `FLOWER_USER` + `FLOWER_PASSWORD` sahibi |  |  | vault |  ☐ |  |  |
| MFA TOTP issuer ayarları sahibi |  |  |  |  ☐ |  |  |

---

## 5. Database

| Sistem/Alan | Primary Owner | Backup Owner | Erişim Yöntemi | MFA Gerekli mi | Son Doğrulama | Not |
|---|---|---|---|---|---|---|
| Postgres superuser sahibi |  |  | psql + SSH tunnel |  ☐ |  |  |
| App role sahibi (RLS scope'lu) |  |  | uygulama içi |  ☐ |  |  |
| Alembic migration koşturma yetkisi |  |  |  |  ☐ |  |  |
| DB backup taker (kim alıyor) |  |  |  |  ☐ |  |  |
| DB backup decryption key sahibi |  |  | vault |  ☐ |  |  |
| Restore approver (production restore'a kim onay verir) |  |  |  |  ☐ |  |  |
| Break-glass DB erişim approver |  |  | (vault, kontrollü) |  ☐ |  |  |

---

## 6. Agent host'lar

> Her saha agent host'u için bir satır.

| Site / Lokasyon | Primary Admin | Backup Admin | Erişim Yöntemi | MFA Gerekli mi | Son Doğrulama | Not |
|---|---|---|---|---|---|---|
| _Site A_ |  |  | SSH |  ☐ |  |  |
| _Site B_ |  |  | SSH |  ☐ |  |  |
| _ekle_ |  |  |  |  ☐ |  |  |

---

## 7. Monitoring & Incident response

| Sistem/Alan | Primary Owner | Backup Owner | Erişim Yöntemi | MFA Gerekli mi | Son Doğrulama | Not |
|---|---|---|---|---|---|---|
| Monitoring panel (Grafana / external uptime) |  |  |  |  ☐ |  |  |
| Alert channel (PagerDuty / OpsGenie / Slack) sahibi |  |  |  |  ☐ |  |  |
| Incident commander (P1 olaylarda kim koordine eder) |  |  |  |  ☐ |  |  |
| On-call rotation manager |  |  |  |  ☐ |  |  |

---

## 8. Security

| Sistem/Alan | Primary Owner | Backup Owner | Erişim Yöntemi | MFA Gerekli mi | Son Doğrulama | Not |
|---|---|---|---|---|---|---|
| Security contact (vulnerability disclosure için) |  |  |  |  ☐ |  |  |
| Secret rotation tracker |  |  | bu dosya + [14 §8](14-SECRETS-ACCESS-HANDOVER-TEMPLATE.md) |  ☐ |  |  |
| Audit log review owner |  |  |  |  ☐ |  |  |
| Pentest sonuçları / findings sahibi |  |  |  |  ☐ |  |  |

---

## 9. Business / Product

| Sistem/Alan | Primary Owner | Backup Owner | Erişim Yöntemi | MFA Gerekli mi | Son Doğrulama | Not |
|---|---|---|---|---|---|---|
| Ürün sahibi (product owner) |  |  |  | — |  |  |
| Müşteri/saha sahibi (her organizasyon için) |  |  |  | — |  |  |
| Faturalama / kontrat sahibi |  |  |  | — |  |  |
| Roadmap karar verici |  |  |  | — |  |  |

---

## 10. Erişim devri tamamlandı kontrolü

Her satır için ayrı bir checkbox:

- ☐ GitHub repo admin erişimi devir alan ekibe verildi
- ☐ Branch protection ayar sahipliği transfer edildi
- ☐ VPS SSH public key devir alan ekibe eklendi
- ☐ Devir veren ekibin VPS SSH key'leri için **revoke takvimi** belirlendi (overlap penceresi: __ gün)
- ☐ Cloudflare panel hesabı veya member olarak devir alan ekip eklendi
- ☐ Domain registrar hesabı sahipliği transfer edildi veya member olarak eklendi
- ☐ DNS kayıt yönetimi devir alan ekibe açıldı
- ☐ Production `.env` vault yetkisi devir alan ekibe verildi
- ☐ DB break-glass approver'da devir alan ekip eklendi
- ☐ Her agent host SSH erişimi devir alan ekibe verildi
- ☐ Monitoring panel member olarak devir alan ekip eklendi
- ☐ Alert channel'a devir alan on-call eklendi
- ☐ Security contact e-posta güncellendi
- ☐ Faturalama panelinde devir alan ekip eklendi (varsa)

---

## 11. Credential rotation completed

Kasayla beraber rotate edilen credential'lar (yalnız "rotate edildi mi" işareti, değer YOK):

| Credential | Eski sahibi | Yeni sahibi | Rotate tarihi | Yeni değer vault'a yazıldı | Etkilenen servisler restart edildi | Not |
|---|---|---|---|---|---|---|
| `JWT_SECRET` |  |  |  | ☐ | ☐ |  |
| Postgres superuser parolası |  |  |  | ☐ | ☐ |  |
| Postgres app role parolası |  |  |  | ☐ | ☐ |  |
| `INTERNAL_API_KEY` |  |  |  | ☐ | ☐ |  |
| `FLOWER_PASSWORD` |  |  |  | ☐ | ☐ |  |
| Cloudflare API token |  |  |  | ☐ | — |  |
| Agent key'leri (gerekirse re-enroll) |  |  |  | ☐ | ☐ |  |

> **`CREDENTIAL_ENCRYPTION_KEY` (Fernet)** **rutin olarak rotate edilmez** ([05 §7](05-SECURITY-RBAC-ORGANIZATION-SCOPING.md)). Yalnız compromise durumunda kontrollü re-encrypt prosedürü ile rotate edilir. Bu satır rotate işareti yerine **sahiplik transferi**ne ait olmalı.

---

## 12. Single-owner riski denetimi

Yukarıdaki tüm tablolar tamamlandığında:

- ☐ Hiçbir kritik sistem **tek kişiye bağlı** değil (en az 1 Backup Owner)
- ☐ Tüm Primary Owner'lar **fiilen erişim test etti** (sadece kayıtta değil)
- ☐ Backup Owner'lar da en az bir kez **fiilen erişim test etti**
- ☐ Devir veren ekibin gereksiz erişimleri için **revoke takvimi** kayıt altına alındı

Bu denetimin sonuç durumu (CONFIRMED / PENDING / RISK ACCEPTED) [16-LIVE-ENVIRONMENT-COMPLETION-WORKSHEET.md](16-LIVE-ENVIRONMENT-COMPLETION-WORKSHEET.md) §17 genel handover gating tablosuna yansır.
