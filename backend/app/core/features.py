"""T10 Faz A1 — Merkezi Feature Registry + lisans/plan enforcement.

Bir özelliğin (modülün) bir organizasyon için açık olup olmadığını
`Plan.features` JSON'undan çözer. RBAC'tan FARKLI:

  * RBAC (`require_permission`)  → "bu kullanıcı bu verbi yapabilir mi?"
  * Feature  (`require_feature`) → "bu organizasyonun planı bu modülü içeriyor mu?"

İkisi bağımsız: bir org_admin `devices:edit` yetkisine sahip olabilir ama
org'un planı `topology` modülünü içermiyorsa /topology 403 döner.

## Semantik — opt-out (geçiş güvenli)
`feature_enabled(plan_features, key)`:
  - plan_features None / {} ........→ True  (kısıt yok — eski org'lar kırılmaz)
  - key not in features ............→ True  (yeni feature'lar varsayılan AÇIK)
  - features[key] is False .........→ False (yalnız EXPLICIT kapatma kısıtlar)
  - else ...........................→ True

Yani bir modülü kapatmak için plana açıkça `{"<key>": false}` yazmak gerekir.
İleride (Faz A ikinci aşama) tier-bazlı opt-in modele sıkılaştırılabilir;
şimdilik bu model mevcut kurulumları bozmadan enforcement altyapısını kurar.
"""
from __future__ import annotations

# Lisanslanabilir / opsiyonel modüller. Core modüller (dashboard, devices,
# monitoring, config_backup, tasks, users, settings, reports, audit) burada
# YOK — onlar her planda açıktır ve gate'lenmez.
#
# key → insan-okur etiket (FE'de "X modülü planınızda yok" mesajı için).
FEATURES: dict[str, str] = {
    "topology":          "Topoloji Haritası",
    "topology_twin":     "Network Digital Twin",
    "ipam":              "IPAM (IP Adres Yönetimi)",
    "firmware":          "Firmware Yönetimi",
    "poe":               "PoE / Enerji İzleme",
    "config_builder":    "Easy Config Builder",
    "config_drift":      "Config Drift / Compliance",
    "sla":               "SLA & Uptime",
    "synthetic_probes":  "Synthetic Probes",
    "incidents":         "Incident RCA",
    "escalation":        "Escalation Kuralları",
    "ai_assistant":      "AI Asistan",
    "agents":            "Agent Yönetimi",
    "change_management": "Değişiklik Yönetimi",
    "racks":             "Kabin Yönetimi",
    "security_policy":   "Switch/Port Güvenlik Politikaları",  # Faz C — ileride
}


def feature_enabled(plan_features: dict | None, key: str) -> bool:
    """Opt-out: yalnız explicit `false` kısıtlar. Bkz. modül docstring'i."""
    if not plan_features:
        return True
    val = plan_features.get(key)
    if val is False:
        return False
    return True


def all_feature_states(plan_features: dict | None) -> dict[str, bool]:
    """Tüm kayıtlı feature'lar için {key: bool} — FE nav filtresi için
    /context/current tarafından döndürülür."""
    return {key: feature_enabled(plan_features, key) for key in FEATURES}
