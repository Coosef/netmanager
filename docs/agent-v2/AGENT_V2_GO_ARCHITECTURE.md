# NetManager Agent v2 — Go Native Architecture

> **Status:** DESIGN PROPOSAL (2026-06-11)
> **Yetki:** Sadece tasarım dokümanı; kod yazılmadı, build/deploy yok.
> **Hedef:** Python/winget/pip bağımlılığını tamamen kaldıran, cross-platform
> native Go binary'siyle agent.

## A. Mevcut Python Agent özellik envanteri

`backend/agent_script/netmanager_agent.py` (v1.4.1, 2016 satır) içeriği:

| Modül | Açıklama | v2'de karşılığı |
|---|---|---|
| WebSocket reconnect | backend ile persistent connection | `gorilla/websocket` veya stdlib `net/http` WS upgrade |
| Heartbeat (15s) | `/ws/agent` periodic ping | timer + channel pattern |
| SSH Connection Pool (F1) | netmiko ile cihaz SSH cache | `golang.org/x/crypto/ssh` + sync.Pool |
| Offline Command Queue (F3) | Pending cmd disk queue | BoltDB / Badger embedded KV |
| Proactive Health Monitor (F2) | Device polling | goroutine workers + ticker |
| SNMP via Agent (F4) | UDP SNMP queries | `gosnmp/gosnmp` |
| Auto Device Discovery (F5) | LLDP/CDP discovery | LLDP packet parsing native Go |
| Syslog Collector (F6) | UDP 514 listener | `net.UDPConn` listener |
| Command Streaming (F7) | Output stream chunks | WS message fragmentation |
| Secure Credential Vault (F8) | per-device SSH creds | DPAPI (Win) / keyring (Linux) |
| Key rotation | Hot key update | atomic config swap + restart-less |
| Whitelist/blacklist policy | Command validation | regex match + audit log |
| Trap Forwarding | SNMP trap relay | UDP listener + WS forward |
| Sec event reporter | Audit hooks | structured log + WS |

**Korunması ZORUNLU davranışlar:**
- WS endpoint: `/ws/agent` query string `?agent_id=...&token=...` (v1 protocol)
- Heartbeat interval 15s
- Command message format JSON (`{cmd_id, device_id, command, ...}`)
- Result format JSON (`{cmd_id, status, stdout, stderr, exit_code, ...}`)
- Reconnect backoff exponential (1s, 2s, 4s, 8s, max 60s)
- TLS 1.2 minimum
- Backend WS path unchanged (zero breaking change v1↔v2 protocol)

## B. v2'de korunması gereken protokol ve endpointler

| Endpoint | Method | Korunur mu? | Notlar |
|---|---|---|---|
| `WS /ws/agent` | WebSocket | ✅ ZORUNLU | Aynı message types |
| `GET /api/v1/agents/{id}/download/{platform}` | HTTP | ⚠ Yeni route eklenecek | `download/v2/{platform}` (binary indir) |
| `GET /api/v1/agents/download/script` | HTTP | ❌ v2'de yok | Python script gerek kalmaz |
| `POST /api/v1/agents/{id}/enroll` | HTTP | 🆕 YENİ | One-time enrollment token → kalıcı agent key |
| `GET /api/v1/agents/v2/manifest` | HTTP | 🆕 YENİ | Latest version + SHA-256 hash + signature |
| `GET /api/v1/agents/v2/binary/{version}/{platform}/{arch}` | HTTP | 🆕 YENİ | Versioned binary download |

**Backward compat sözleşmesi:** v1 ve v2 agent'lar aynı WS endpoint'i kullanır. Backend WS handler agent version'a göre davranış değiştirmez (v2 superset değil, identical protocol).

## C. Windows service mimarisi

### Native Windows Service (Go ile)

```go
// cmd/netmanager-agent/main_windows.go
package main

import (
    "golang.org/x/sys/windows/svc"
    "golang.org/x/sys/windows/svc/mgr"
)

type agentService struct{}

func (s *agentService) Execute(args []string, r <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
    status <- svc.Status{State: svc.StartPending}
    // Agent çalışması goroutine'lerde
    ctx, cancel := context.WithCancel(context.Background())
    go runAgent(ctx)
    status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
    for cr := range r {
        switch cr.Cmd {
        case svc.Interrogate:
            status <- cr.CurrentStatus
        case svc.Stop, svc.Shutdown:
            cancel()
            status <- svc.Status{State: svc.StopPending}
            return false, 0
        }
    }
    return false, 0
}
```

### Service install komutu

```go
// cmd/netmanager-agent/install.go
func installService() error {
    m, _ := mgr.Connect()
    defer m.Disconnect()
    s, err := m.CreateService("NetManagerAgent", exePath, mgr.Config{
        DisplayName: "NetManager Proxy Agent",
        Description: "Cross-platform device polling agent for NetManager",
        StartType:   mgr.StartAutomatic,
        ServiceType: windows.SERVICE_WIN32_OWN_PROCESS,
    }, "run", "--service")
    if err != nil {
        return err
    }
    defer s.Close()
    // Recovery actions: restart 10s/30s/60s
    return mgr.SetRecoveryActions(s.Handle, recoveryActions, 60*time.Second)
}
```

**Pro:**
- `sc.exe` quoting bug yok
- Service stdout/stderr → Windows Event Log
- Native recovery actions
- Restart-less binary update (A/B slot)

### Windows Event Log entegrasyonu

```go
import "golang.org/x/sys/windows/svc/eventlog"

elog, _ := eventlog.Open("NetManagerAgent")
defer elog.Close()
elog.Info(1, "agent started, version=2.0.0")
elog.Error(2, fmt.Sprintf("websocket connect failed: %v", err))
```

Event Viewer'da `Applications and Services Logs` → `NetManagerAgent` görünür.

## D. Linux systemd mimarisi

```ini
# /etc/systemd/system/netmanager-agent.service
[Unit]
Description=NetManager Proxy Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=notify  # sd_notify ile ready signal
ExecStart=/opt/netmanager-agent/netmanager-agent run --service
Restart=always
RestartSec=10
User=netmanager-agent
Group=netmanager-agent
# Hardening
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true
ReadWritePaths=/var/lib/netmanager-agent /var/log/netmanager-agent
CapabilityBoundingSet=CAP_NET_RAW  # SNMP trap UDP 162 için
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```go
// Linux notify ready
import "github.com/coreos/go-systemd/v22/daemon"
daemon.SdNotify(false, daemon.SdNotifyReady)
```

**Install:**
```bash
sudo cp netmanager-agent /opt/netmanager-agent/
sudo cp netmanager-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now netmanager-agent
```

## E. Enrollment ve secret storage

### One-time enrollment token akışı (yeni mimari)

```
1. Admin Charon UI'da yeni agent oluşturur
   → backend agent_id + one_time_enrollment_token (15dk TTL) üretir
   → token DB'de `enrollment_pending` durumunda kaydedilir
   → UI kullanıcıya download URL gösterir (token URL'de DEĞİL, header'da)

2. Kullanıcı agent binary'sini indirir + çalıştırır:
   netmanager-agent enroll \
     --backend https://netmanager.systrack.app \
     --agent-id agent-xyz \
     --enrollment-token ${TOKEN}

3. Agent POST /api/v1/agents/{id}/enroll
   X-Enrollment-Token: TOKEN
   Body: { hostname, platform, arch, version }
   → backend token'ı validate eder, EKİN agent key generate eder
   → DB'de agent.agent_key_hash güncellenir
   → Response: { agent_key: "...", config: {...} }

4. Agent agent_key'i DPAPI (Win) / keyring (Linux) ile saklar:
   Win: ProtectedData.Protect(LocalMachine scope, "NetManagerAgent")
   Linux: libsecret/keyring veya /etc/netmanager-agent/agent.key (chmod 600, root only)

5. Agent service install + start
   → bir sonraki boot'ta DPAPI/keyring'den agent_key oku → WS connect
```

**Pros:**
- One-time token URL'de görünmez (header)
- Agent key disk'te düz metin YOK (DPAPI/keyring)
- Token expire olursa enrollment fail → installer key sızdırmaz
- Token tek-kullanımlık (idempotency)

### Secret storage matrisi

| Platform | Storage | API |
|---|---|---|
| Windows | DPAPI (LocalMachine) | `crypto/dpapi.Encrypt` (`github.com/billgraziano/dpapi`) |
| Linux (with desktop) | libsecret / GNOME Keyring | `github.com/zalando/go-keyring` |
| Linux (server, headless) | `/etc/netmanager-agent/agent.key` (chmod 600, root:root) | os.WriteFile + chmod |
| macOS (future) | Keychain | `keyring` |

## F. Auto-update mimarisi

### A/B slot binary swap

```
/opt/netmanager-agent/
├── current → slot-a/             (symlink, atomic swap)
├── slot-a/
│   ├── netmanager-agent.exe      (version 2.0.0)
│   ├── version.txt               (2.0.0)
│   └── manifest.json
├── slot-b/                       (next version staging)
│   ├── netmanager-agent.exe      (version 2.0.1)
│   └── manifest.json
└── update.log
```

**Update akışı:**

```go
func performUpdate(newVer string) error {
    // 1. /agents/v2/manifest GET → expected hash + signature
    manifest := fetchManifest()
    if !verifyManifestSignature(manifest, embeddedPubKey) {
        return ErrManifestInvalid
    }
    if manifest.Version <= currentVersion {
        return nil  // already up-to-date
    }
    
    // 2. Binary indir → slot-b/
    err := downloadBinary(manifest.URL, "slot-b/netmanager-agent")
    if err != nil { return err }
    
    // 3. SHA-256 hash doğrula
    if !verifyHash("slot-b/netmanager-agent", manifest.SHA256) {
        os.RemoveAll("slot-b/")
        return ErrHashMismatch
    }
    
    // 4. Smoke test: yeni binary'yi --version ile çalıştır
    if err := runSmokeTest("slot-b/netmanager-agent"); err != nil {
        os.RemoveAll("slot-b/")
        return err
    }
    
    // 5. Atomic swap: current → slot-b/
    os.Remove("current")
    os.Symlink("slot-b/", "current")
    
    // 6. Service restart (Windows: ChangeServiceConfig + StartService;
    //    Linux: systemctl reload)
    return restartSelf()
}
```

### Rollback

```go
// Yeni binary 3 kez crash ederse otomatik rollback
if crashCount > 3 {
    os.Remove("current")
    os.Symlink("slot-a/", "current")  // önceki version
    restartSelf()
    elog.Error(99, "auto-rollback to previous version")
}
```

**Persistent crash counter:** BoltDB key `crash_count` her start'ta increment, normal shutdown'da reset.

## G. Signed manifest ve binary doğrulaması

### Manifest format

```json
{
  "version": "2.0.0",
  "released_at": "2026-08-01T10:00:00Z",
  "platforms": {
    "windows_amd64": {
      "url": "https://netmanager.systrack.app/.../netmanager-agent-2.0.0-windows-amd64.exe",
      "sha256": "abc123...",
      "size": 8400000
    },
    "linux_amd64": { "...": "..." },
    "linux_arm64": { "...": "..." }
  },
  "min_supported_version": "2.0.0",
  "ed25519_signature": "..."
}
```

### Ed25519 signature

```go
// Backend (release pipeline):
priv, _ := ed25519.GenerateKey(rand.Reader)
sig := ed25519.Sign(priv, manifestBytes)

// Agent (built-in pubkey):
//go:embed pubkey.bin
var manifestPubKey []byte

func verifyManifest(manifest []byte, sig []byte) bool {
    return ed25519.Verify(ed25519.PublicKey(manifestPubKey), manifest, sig)
}
```

**Pubkey rotation:** Backend yeni pubkey'i `next_pubkey` field'inde yayınlar; agent N versiyonda günceller, eski pubkey N+1'de kaldırılır.

### Code signing (Windows EV cert)

- DigiCert / Sectigo EV Code Signing certificate (~$500/yıl)
- `signtool sign /sha1 ${THUMBPRINT} /t http://timestamp.digicert.com /fd sha256 /a netmanager-agent.exe`
- SmartScreen warning yok
- Group Policy whitelistable

## H. Offline queue ve reconnect

### Embedded KV store

```go
// internal/queue/bolt.go
import "go.etcd.io/bbolt"

type Queue struct {
    db *bbolt.DB
}

func (q *Queue) Push(msg Message) error {
    return q.db.Update(func(tx *bbolt.Tx) error {
        b := tx.Bucket([]byte("queue"))
        id, _ := b.NextSequence()
        return b.Put(itob(id), msg.Marshal())
    })
}

func (q *Queue) Drain(ws *websocket.Conn) error {
    return q.db.View(func(tx *bbolt.Tx) error {
        b := tx.Bucket([]byte("queue"))
        return b.ForEach(func(k, v []byte) error {
            msg := UnmarshalMessage(v)
            if err := ws.WriteJSON(msg); err != nil {
                return err  // bağlantı koptu, bir sonraki connect'te devam
            }
            b.Delete(k)
            return nil
        })
    })
}
```

### Reconnect backoff (exponential + jitter)

```go
backoff := time.Second
for {
    err := connect()
    if err == nil { backoff = time.Second; continue }
    
    jitter := time.Duration(rand.Int63n(int64(backoff / 2)))
    sleep := backoff + jitter
    time.Sleep(sleep)
    
    backoff *= 2
    if backoff > 60*time.Second {
        backoff = 60 * time.Second
    }
}
```

### Proxy/TLS inspection desteği

```go
// HTTPS_PROXY env var auto-detect
client := &http.Client{
    Transport: &http.Transport{
        Proxy: http.ProxyFromEnvironment,  // HTTPS_PROXY, NO_PROXY
        TLSClientConfig: &tls.Config{
            MinVersion: tls.VersionTLS12,
            // Enterprise TLS inspection: custom CA bundle
            RootCAs: loadCustomCA(),
        },
    },
}
```

## I. Observability / logging

### Structured logging

```go
import "log/slog"

logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
    Level: slog.LevelInfo,
}))

logger.Info("ws connected",
    slog.String("backend_url", backendURL),
    slog.Int("attempt", attempt),
)
```

**Output formats:**
- Windows: JSON → file `%ProgramData%\NetManagerAgent\agent.log` + Event Log critical
- Linux: JSON → journald (systemd capture)

### Health endpoint (optional, debug için)

```go
// localhost:9091/health (sadece loopback)
http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
    json.NewEncoder(w).Encode(map[string]any{
        "version": Version,
        "uptime":  time.Since(startTime).Seconds(),
        "ws_state": wsState,
        "queue_depth": queue.Depth(),
    })
})
```

Sadece `127.0.0.1` listen; firewall expose YOK.

## J. v1/v2 compatibility

| Konu | v1 (Python) | v2 (Go) | Compat |
|---|---|---|---|
| WS endpoint | `/ws/agent?agent_id=...&token=...` | Aynı | ✅ Full |
| Heartbeat format | `{"type":"heartbeat", "version":"1.4.x"}` | `{"type":"heartbeat", "version":"2.0.0"}` | ✅ Version string farklı, backend tarafında ayrım yok |
| Command/result JSON | `{"cmd_id", "device_id", "command", ...}` | Aynı | ✅ Identical wire format |
| SNMP traps | UDP 162 listen + WS forward | Aynı | ✅ |
| Backend WS code | Version-agnostic | Aynı | ✅ Zero backend change |

**Migration sırası:**
1. v1 ve v2 paralel deploy (production'da hem v1 hem v2 agent çalışır)
2. Backend yeni v1 agent install'a izin VERIR (mevcut customer çalışmaya devam)
3. Backend yeni v2 download endpoint'i sunar; UI default v2
4. v1 deprecation: 6 ay grace period
5. v1 sunset: agent download v1 endpoint'i 410 Gone döner

## K. Migration ve rollout planı

### Ring rollout (production)

```
Ring 0 — Internal test (1 hafta)
  · Anthropic team agents (~5)
  · Otomatik telemetry: install success rate, WS uptime, command throughput

Ring 1 — Canary (1 hafta)
  · 5% rastgele seçilen customer agents
  · Backend `agent_v2_enabled` feature flag per-org
  · Rollback kriteri: install success < %95 veya crash rate > baseline +20%

Ring 2 — General (2 hafta)
  · %25 → %50 → %100 customer agents
  · Customer'a email: "v2 update available, opt-in via Charon UI"

Ring 3 — Default
  · Yeni agent install default v2
  · v1 enrollment endpoint deprecation warning
```

### v1 → v2 in-place migration

```
# v1 agent (Python) çalışırken:
1. Backend agent.target_version = "2.0.0" set
2. v1 agent kendi update mekanizması yok → manuel migration
3. Customer Charon UI'da "Upgrade to v2" buton tıklar
   → backend POST /api/v1/agents/{id}/v2-migration-token
   → response: one-time enrollment token + v2 binary URL
4. Customer eski Python service'i durdurur, v2 binary'yi indirir + enroll
   netmanager-agent enroll --enrollment-token=... --legacy-agent-id=...
5. Backend eski v1 service kaydını v2 ile değiştirir (agent_id korunur)
6. v2 agent yeni agent_key ile WS connect
```

## L. Dosya / package yapısı

```
agent-v2/
├── cmd/
│   └── netmanager-agent/
│       ├── main.go
│       ├── main_windows.go      # //go:build windows
│       ├── main_linux.go        # //go:build linux
│       ├── install.go
│       ├── uninstall.go
│       └── enroll.go
├── internal/
│   ├── ws/
│   │   ├── client.go
│   │   ├── reconnect.go
│   │   └── messages.go
│   ├── ssh/
│   │   ├── pool.go
│   │   └── exec.go
│   ├── snmp/
│   │   ├── client.go
│   │   └── trap_listener.go
│   ├── syslog/
│   │   └── listener.go
│   ├── queue/
│   │   └── bolt.go
│   ├── secret/
│   │   ├── dpapi_windows.go
│   │   ├── keyring_linux.go
│   │   └── file_fallback.go
│   ├── update/
│   │   ├── manifest.go
│   │   ├── verify.go
│   │   └── swap.go
│   └── service/
│       ├── windows.go
│       ├── systemd.go
│       └── recovery.go
├── pkg/
│   └── protocol/
│       ├── messages.go          # Backend ile shared wire format
│       └── version.go
├── manifest/
│   └── pubkey.bin               #go:embed (Ed25519 public key)
├── go.mod
├── go.sum
├── Makefile                     # cross-compile targets
├── README.md
└── docs/
    ├── ARCHITECTURE.md
    ├── ENROLLMENT.md
    └── MIGRATION_FROM_V1.md
```

**Binary size hedefi:** < 10 MB (UPX compressed ~5 MB).

## M. Sprint ve task breakdown

### Sprint 1 (2 hafta) — Core agent
- [ ] Go module setup + CI cross-compile (Win/Linux amd64/arm64)
- [ ] WS client + reconnect + heartbeat
- [ ] Message protocol (v1 wire format identical)
- [ ] BoltDB embedded queue (offline)
- [ ] Structured logging (slog JSON)
- [ ] `enroll` subcommand + one-time token flow
- [ ] DPAPI (Windows) + keyring (Linux) wrapper
- [ ] Backend `POST /agents/{id}/enroll` endpoint
- [ ] Backend `GET /agents/v2/manifest` endpoint (mock)

### Sprint 2 (2 hafta) — Service + SSH
- [ ] Windows service (`golang.org/x/sys/windows/svc`)
- [ ] Linux systemd `Type=notify`
- [ ] Service install / uninstall subcommands
- [ ] SSH connection pool + exec (`golang.org/x/crypto/ssh`)
- [ ] Command policy whitelist/blacklist
- [ ] Audit log structured events

### Sprint 3 (2 hafta) — SNMP + Syslog + Discovery
- [ ] gosnmp integration (poll + trap UDP 162)
- [ ] Syslog UDP 514 listener
- [ ] LLDP/CDP discovery (packet capture)
- [ ] Device health monitoring (F2)

### Sprint 4 (2 hafta) — Auto-update + Code signing
- [ ] Manifest fetch + Ed25519 verify
- [ ] A/B slot binary swap
- [ ] Atomic restart (Windows service restart, Linux systemd-notify)
- [ ] Rollback on crash counter
- [ ] Code signing pipeline (EV cert, GitHub Actions Windows runner)

### Sprint 5 (2 hafta) — Migration + Rollout
- [ ] Backend v1 → v2 migration endpoint
- [ ] UI "Upgrade to v2" button
- [ ] Ring rollout feature flag
- [ ] Telemetry dashboard (install/uptime/crash)

### Sprint 6 (2 hafta) — Hardening + Documentation
- [ ] Penetration test (binary tampering, replay)
- [ ] Proxy/TLS inspection environments test
- [ ] Customer documentation
- [ ] Migration guide
- [ ] v1 sunset timeline announcement

**Toplam tahmini:** 12 hafta (3 ay) + 1 hafta buffer.

## N. Test matrisi

| Test seviyesi | Kapsam | Araç |
|---|---|---|
| Unit | Pure Go fonksiyonları | `go test` |
| Integration | WS client + mock backend | testcontainers veya in-memory backend |
| Service install | Windows service / Linux systemd | Vagrant VM matrix |
| Update flow | A/B slot swap | E2E test with fake manifest server |
| Migration | v1 → v2 in-place | Vagrant VM with Python agent → upgrade |
| Cross-platform | Windows 10/11/Server 2019/2022, Ubuntu 20/22, RHEL 8/9 | GitHub Actions matrix |
| TR Windows | Türkçe locale | Manual VM test |
| Proxy/TLS-MitM | Corporate proxy environment | Squid + custom CA bundle |
| Penetration | Binary tampering, manifest forgery | Manual + automated fuzzing |

## O. Tahmini süre ve riskler

### Süre
- **3 ay** (12 sprint) for general-availability
- **1 ay** post-GA for v1 sunset and customer migration support

### Riskler

| Risk | Olasılık | Etki | Mitigation |
|---|---|---|---|
| Code signing cert procurement gecikme | Orta | Yüksek (SmartScreen warning) | Sprint 4 öncesi başvuru (~2 hafta lead time) |
| Cross-compile broken on Sprint 3 (CGO dep) | Düşük | Orta | Pure Go forced; SNMP lib CGO-free seçimi |
| v1 → v2 migration customer escapes | Orta | Orta | Ring rollout + 6 ay grace period |
| DPAPI/keyring corner cases | Orta | Yüksek | Fallback to encrypted file (AES-GCM) |
| Auto-update infinite loop | Düşük | Yüksek | Rollback counter + manual override |
| Linux distros without systemd | Düşük | Düşük | OpenRC fallback (Alpine) — out of scope v1 |
| Binary size > 10 MB | Düşük | Düşük | UPX compress + dead code elim |
| Customer firewall blocks new endpoint | Orta | Orta | Aynı backend host, sadece path farkı |

## P. MSI/EXE packaging yol haritası

### Phase 1 (Sprint 4) — Plain EXE/binary

- Windows: signed `netmanager-agent.exe` (single file)
- Linux: tarball + install.sh script (idempotent)

### Phase 2 (post-GA, opt-in) — MSI installer

- WiX Toolset XML descriptor
- Add/Remove Programs entry
- Group Policy deployable
- Bundled EV cert sign

### Phase 3 (enterprise) — Endpoint management integration

- SCCM (System Center) deployment package
- Intune integration
- Chocolatey package (community channel)
- winget package (Microsoft Store)

---

## Önemli sözleşmeler

- **Backend protocol unchanged** — v1 agent'lar bu tasarım boyunca etkilenmeyecek
- **WS path unchanged** — `/ws/agent` query string aynı
- **No DB migration** — yeni endpoint'ler mevcut tablolara eklenir
- **No production deploy** — bu doküman yalnız tasarım onayı için

## Açık sorular (review sırasında karar gerekli)

1. **Code signing cert kim alacak?** (legal + kim sahip; ~$500/yıl)
2. **Auto-update default ON mu OFF mu?** (enterprise customer için OFF tercih)
3. **Linux fallback dağıtım yöntemi?** (deb/rpm package mı yoksa sadece tarball?)
4. **v1 sunset takvimi?** (6 ay default; daha kısa/uzun?)
5. **Binary host hangi CDN?** (Cloudflare R2 / S3 / current backend?)
6. **Manifest signing key yönetimi?** (HSM mı dosya mı; ne sıklıkla rotate?)

Bu kararlar tasarım onayı sonrası implementation öncesi netleştirilmeli.
