NetManager 3.0 — Intelligence & Architecture Roadmap

Amaç: NetManager’ı klasik NMS’ten çıkarıp Network Intelligence + Safe Automation Platform haline getirmek

1. STRATEJİK YÖN DEĞİŞİMİ
Mevcut Durum
Network monitoring ✔
Config management ✔
Topology ✔
Automation ✔
Hedef

“Sistem sadece veri göstermez, karar üretir ve aksiyon önerir”

2. YENİ ANA KATMAN: DECISION ENGINE
Amaç

Toplanan tüm verileri anlamlandırıp:

root cause bulmak
risk hesaplamak
aksiyon önermek
Input
topology data
network events
config diff
SNMP metrics
SLA data
agent metrics
Output
Root Cause Detection
“Core switch down → 47 cihaz etkilendi”
Risk Score
cihaz bazlı 0–100 risk puanı
Suggested Actions
otomatik öneriler (backup, restart, fix config vb.)
Playbook Suggestion
olay → önerilen otomasyon
3. ROOT CAUSE ENGINE
Amaç

Event flood yerine gerçek sebebi bulmak

Özellikler
parent-child device dependency
topology aware correlation
cascading failure detection
alert grouping
Örnek
Access switch offline
↓
Distribution switch offline
↓
Root cause: distribution failure
4. CONDITIONAL AUTOMATION ENGINE
Amaç

Statik playbook → akıllı otomasyon

Örnek
IF device offline > 5 min
AND uplink reachable
THEN restart interface
Özellikler
condition-based triggers
multi-step logic
safe execution (approval + rollback)
dry-run simulation
5. CONFIG + EVENT CORRELATION
Amaç

Config değişikliklerinin etkisini anlamak

Örnek
Config değişti
↓
Port down oldu
↓
Correlation: config kaynaklı hata
Özellikler
config diff → event link
timeline correlation
change impact analysis
6. SERVICE IMPACT MAPPING
Amaç

Cihaz değil, iş etkisi odaklı sistem

Model
Device → VLAN → Service → Business Impact
Örnek
Core switch down
↓
POS sistemi down
↓
Satış durdu
Çıktı
etkilenen servis listesi
kritik öncelik hesaplama
7. NETWORK DIGITAL TWIN
Amaç

Gerçek ağın mantıksal modelini oluşturmak

İçerik
expected topology
expected config
expected behavior
Kullanım
Actual vs Expected
Sonuç
drift detection
misconfiguration detection
topology anomaly
8. AGENT EVRİMİ (EDGE COMPUTE MODELİ)
Mevcut
SSH proxy
SNMP
Hedef

Agent = edge intelligence node

Yeni yetenekler
local anomaly detection
offline command queue ✔ (mevcut)
local automation execution
fallback logic
local cache
9. TIME-BASED INTELLIGENCE
Amaç

Sadece anlık değil, davranış analizi

Özellikler
device stability score
interface error trend
flapping history
uptime trend
MTTR / MTBF
10. NETWORK BEHAVIOR ANALYTICS
Amaç

Anormal davranışları tespit etmek

Örnekler
MAC sayısı anormal artış
trafik spike
beklenmeyen VLAN activity
loop şüphesi
11. SMART ALERT REDUCTION
Amaç

Alert noise azaltmak

Özellikler
deduplication ✔
suppression
dependency awareness
dynamic severity
12. TEMPLATE / PARSER ENGINE (KRİTİK)
Amaç

Vendor bağımlılığını kırmak

Yapı
version-aware template
command abstraction
parser abstraction
fallback commands
AI Kullanımı

✔ yeni template üretimi
❌ runtime parsing

13. DATA MODEL GENİŞLETME
Yeni varlıklar
Service
Dependency graph
Risk score
Decision logs
Template metrics
14. PLATFORM EVRİMİ
Şu an

Monolith (FastAPI)

Hedef
decision engine service
automation engine
event processor
telemetry pipeline
15. EN KRİTİK 5 GELİŞİM
Decision Engine
Root Cause Engine
Conditional Automation
Config/Event correlation
Service Impact Mapping
16. YAPILMAMASI GEREKENLER (ŞİMDİLİK)
Wireless vendor deep integration
Capacity planning (veri yetersiz)
Session replay (yüksek maliyet)
SONUÇ

NetManager artık:

❌ Network monitoring tool değil
✅ Network Intelligence Platform