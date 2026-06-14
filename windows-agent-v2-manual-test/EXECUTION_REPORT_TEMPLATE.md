# Windows Agent V2 - Manual Validation Execution Report

> **Operator copy this file to** `report-<run-id>.md` **and fill it in
> per run. Keep blank fields empty so a reviewer can spot them at a
> glance.**
>
> This template is the operator-fill twin of
> [`docs/WINDOWS_AGENT_V2_MANUAL_VALIDATION_PLAN.md`](../docs/WINDOWS_AGENT_V2_MANUAL_VALIDATION_PLAN.md).
> The plan document defines what each section means; this template is
> what the operator submits.

---

## 0. Run identification

| Field | Value |
|---|---|
| Run ID | `YYYY-MM-DD-T<tier>-<os-tag>-run<NN>` |
| Test date (UTC) | `YYYY-MM-DDTHH:MM:SSZ` |
| Operator name | |
| Reviewer name (counter-signs Section 12) | |
| Plan revision applied | v1 |
| Plan baseline `main` SHA | `646ff665cda0fc01a7aa12e7c2ee825a7ed3916e` |

---

## 1. Machine info

| Field | Value |
|---|---|
| OS name | (e.g. `Windows Server 2022 Standard`) |
| OS build | (`(Get-CimInstance Win32_OperatingSystem).BuildNumber`) |
| Architecture | `amd64` |
| RAM (GB) | |
| Free disk on `C:` (GB) | |
| Domain join state | `workgroup` / `isolated-staging-OU` (NOT a production AD domain) |
| PowerShell version | (`$PSVersionTable.PSVersion`) |
| Test machine hostname | `OPERATOR-HOST` (redacted) |

---

## 2. Backend / artifact

| Field | Value |
|---|---|
| Backend URL type | `staging` (operator attestation, NOT production) |
| Backend URL (redacted host) | `https://<staging>...` |
| Manifest endpoint reachable? | yes / no |
| Manifest emits 4 `X-Charon-*` headers? | yes / no |
| `WINDOWS_AGENT_V2_ENABLED` on staging instance | `True` (must be True ONLY on staging) |
| `WINDOWS_AGENT_V2_ENABLED` on production (independent check) | `False` (required; if `True`, HARD STOP) |
| v4 artifact: GitHub Actions run ID | |
| v4 artifact: workflow URL | |
| v4 artifact: SHA-256 (downloaded ZIP) | |
| v4 artifact: SHA-256 (workflow-reported) | |
| ZIP SHA match? | yes / no |
| In-ZIP SHA256SUMS verification passed? | yes / no |

---

## 3. Section 4 preflight checklist sign-off

Mark `[x]` for each row that passed manual inspection. Any unchecked
row blocks the run.

- [ ] 4.1 OS build >= 17763
- [ ] 4.2 PowerShell 5.1.x
- [ ] 4.3 Session elevated
- [ ] 4.4 `Get-Service NetManagerAgent` returns `$null`
- [ ] 4.5 `C:\ProgramData\NetManagerAgent\` does NOT exist
- [ ] 4.6 TLS 1.2 reachable on staging backend
- [ ] 4.7 Manifest endpoint returns the four `X-Charon-*` headers
- [ ] 4.8 `test-config.json` placeholders replaced with staging values
- [ ] 4.9 Operator attests: no real production agent key in `test-config.json`
- [ ] 4.10 Operator attests: backend URL is NOT the production URL
- [ ] 4.11 Operator attests: no production secret on the box
- [ ] 4.12 v4 ZIP SHA-256 matches workflow-published artifact

---

## 4. Per-script results

### 4.1 `01-preflight.ps1`

| Field | Value |
|---|---|
| Start time (UTC) | |
| Exit code | |
| `preflight.txt` contents | `PRECHECK_RESULT=PASS` / `PRECHECK_RESULT=BLOCKED` |
| 4 positive-report lines present verbatim? | yes / no |
| `[BLOCK]` lines (if any) | (paste, redacted) |
| Decision | PASS / FAIL / BLOCKED |

### 4.2 `02-run-installer.ps1`

| Field | Value |
|---|---|
| Start time (UTC) | |
| Exit code | |
| UAC elevation required? | yes / no |
| `installer-run.txt` last section (paste, redacted) | |
| Installer self-cleaned its own file? | yes / no |
| Decision | PASS / FAIL / BLOCKED |

### 4.3 `03-post-install-verify.ps1`

| Field | Value |
|---|---|
| Start time (UTC) | |
| Exit code | |
| `post-install.txt` contents | `POST_INSTALL_RESULT=PASS` / `POST_INSTALL_RESULT=FAIL` |
| `[OK]` lines printed | / 7 |
| `[FAIL]` lines (if any) | (paste, redacted) |
| Decision | PASS / FAIL |

### 4.4 `05-collect-diagnostics.ps1`

| Field | Value |
|---|---|
| Start time (UTC) | |
| Exit code | |
| Diagnostics ZIP filename | `netmanager-agent-diagnostics-<ts>.zip` |
| Diagnostics ZIP byte size | |
| Diagnostics ZIP inspection (Section 8.4 plan) - leaked any secret-bearing path? | no (required) |
| Decision | PASS / FAIL |

### 4.5 `06-safe-cleanup.ps1` (default mode)

| Field | Value |
|---|---|
| Start time (UTC) | |
| Exit code | |
| Local test-package artifacts wiped? | yes / no |
| Agent install on disk preserved? | yes (default mode does NOT wipe agent files) |
| Decision | PASS / FAIL |

### 4.6 `06-safe-cleanup.ps1 -RemoveAgentFiles`

| Field | Value |
|---|---|
| Start time (UTC) | |
| Exit code | |
| `Get-Service NetManagerAgent` after run | `$null` (required) |
| `Test-Path C:\ProgramData\NetManagerAgent\` after run | `$false` (required) |
| Any `*.failed-*` glob hits on disk after run? | no (required) |
| Decision | PASS / FAIL |

---

## 5. Evidence summary

### 5.1 ZIP SHA-256

```
windows-agent-v2-manual-test-v4.zip = <sha256-hex-lower>
```

### 5.2 Manifest header capture (from a reviewer machine)

```
X-Charon-Runtime-Version:                <value>
X-Charon-Runtime-Zip-Sha256:             <HEX-UPPER>
X-Charon-Python-Version:                 <value>
X-Charon-Compatible-Host-Core-Range:     <value>
```

### 5.3 Service status snapshot

```
Name:        NetManagerAgent
Status:      Running
StartType:   Automatic
StartName:   LocalSystem
DisplayName: NetManager Proxy Agent
```

ImagePath argv match (Stage 11.C canonical equivalence): yes / no

### 5.4 Event log snippet (last 100 events)

(paste, redacted; truncate to the lines mentioning `NetManagerAgent`)

### 5.5 Diagnostics archive content summary

| File | Size (bytes) | Sensitive? |
|---|---|---|
| `diagnostics-summary.txt` | | no |
| (list every file the ZIP contains) | | |

Excluded paths confirmed absent (per Section 8.4 plan):

- `config.env`: absent (required)
- `config.env.bak`: absent (required)
- `config.env.new`: absent (required)
- `staging\rollback-config.failed`: absent (required)
- `staging\proc-capture\*`: absent (required)
- `failed-*\*`: absent (required)

---

## 6. Linux installer golden check (Section 6.9 plan)

| Field | Value |
|---|---|
| Re-verified on (host) | (operator's reviewer machine) |
| Linux installer downloaded from | (staging backend) |
| Timestamp-stripped SHA-256 | (must equal `889654588f35eef1d5e43208840078ed6394aecfeeec6c15544c39342f5d5442`) |
| Drift detected? | no (required) |

---

## 7. Production non-flip check (Section 6.10 plan)

| Field | Value |
|---|---|
| Production runtime endpoint Status code | `404 Endpoint not available` (required) |
| If anything other than 404: HARD STOP triggered? | yes / no |

---

## 8. Production non-touch attestation (Section 9.3 plan)

The operator pastes the verbatim attestation from Section 9.3 of the
plan AND signs below.

> "I attest that this validation run did NOT modify any production
> system, did NOT contact the production NetManager backend, did NOT
> contact production secrets storage, did NOT flip
> `WINDOWS_AGENT_V2_ENABLED` on production, and did NOT run the
> installer or any of its scripts against a production-tagged Windows
> host."

Operator signature (name + date in UTC):

---

## 9. Failure class (if any)

| Section | Class | Notes |
|---|---|---|
| Triggered? | yes / no | |
| Class (per Section 7 plan) | (7.1 Preflight / 7.2 Download / 7.3 Header / 7.4 Install / 7.5 Start / 7.6 Verify / 7.7 Diagnostics / 7.8 Cleanup) | |
| Defect ID filed | | |
| Incident ID filed (if Section 7.7 or Section 10.4 plan triggered) | | |

---

## 10. Hard STOP triggers (Section 10.4 plan)

Mark `[x]` per the inspection result. Any `[x]` here means the
validation campaign is HARD STOPPED (no further runs).

- [ ] Diagnostics ZIP leaked a secret-bearing path
- [ ] Production `WINDOWS_AGENT_V2_ENABLED` is `True`
- [ ] Linux byte-equal golden drifted
- [ ] Any run contacted the production NetManager backend
- [ ] `ROLLBACK_INCOMPLETE` mode fired
- [ ] Production secret was found on the test machine after the run started

---

## 11. Final decision

| Field | Value |
|---|---|
| Decision | PASS / FAIL / BLOCKED |
| Reason summary | |
| Operator notes | |

PASS requires every per-script row in Section 4 to be PASS, every
checked row in Section 3 to be ticked, every required answer in
Sections 5 - 10 to satisfy the plan's expectations.

---

## 12. Reviewer counter-signature

A reviewer DIFFERENT from the operator inspects this report and
signs below.

| Field | Value |
|---|---|
| Reviewer name | |
| Reviewer agrees with the operator's decision? | yes / no |
| Reviewer notes | |
| Reviewer signature (name + date in UTC) | |

---

## 13. Retention

| Field | Value |
|---|---|
| Diagnostics ZIP destroyed at (UTC) | (per Section 9.4 plan, after campaign closes) |
| `test-config.json` wiped at (UTC) | (must be done at run end) |
| Report retention storage | (operator's secured store) |
