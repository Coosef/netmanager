# Windows Agent V2 - Manual Validation Plan (Staging Only)

> **Document version:** v1
> **Plan owner:** Backend / Windows Agent V2 working group
> **Effective range:** STAGING / controlled manual validation only. **This is
> NOT a production rollout document.** No production secret, no production
> agent ID/key, no production backend URL, no production Windows host, and
> no `WINDOWS_AGENT_V2_ENABLED` flag flip are involved at any step.
> **Baseline:** `main` at SHA `646ff665cda0fc01a7aa12e7c2ee825a7ed3916e`
> (post-PR #87). CI: ALL GREEN.

---

## 1. Purpose and Scope

### 1.1 What this plan IS

A reproducible, evidence-bearing manual validation procedure for the
Windows Agent V2 installer + runtime endpoints + Section H 11-stage
flow. The plan is executed in a **controlled staging environment**:

- A disposable Windows VM (or set of VMs) owned by the validation
  operator. The VM is created for this validation and destroyed after.
- A staging instance of the NetManager backend (or local docker-compose
  instance) reachable only over a tightly scoped network.
- A staging-only agent record created via the backend's admin UI for
  this validation. The agent ID + key live only in the operator's local
  notebook; they are NEVER reused across runs and NEVER mirrored from
  production.

### 1.2 What this plan IS NOT

- **NOT a production rollout.** Production rollout requires a separate
  Change Advisory Board document, a production agent provisioning flow,
  and a `WINDOWS_AGENT_V2_ENABLED` flag-flip decision. None of those
  are in scope here.
- **NOT a deploy approval.** Successful execution of this plan does NOT
  authorize deploying the agent to production fleet machines.
- **NOT a security review.** The pentest / threat-model review is a
  separate work product gated on its own approval chain.
- **NOT a flag-flip rehearsal.** `WINDOWS_AGENT_V2_ENABLED` stays
  `False` before, during, and after this plan. The plan exercises the
  agent surface by HTTP-only mock paths plus the staging backend's
  internal test harness; it never asks the live backend to flip a
  feature flag.

### 1.3 Inputs accepted into scope

- The v4 manual test package (`windows-agent-v2-manual-test-v4.zip`)
  built by the
  [`windows-agent-manual-test-package.yml`](../.github/workflows/windows-agent-manual-test-package.yml)
  workflow on the baseline SHA above.
- The five operator scripts (`01-preflight.ps1`, `02-run-installer.ps1`,
  `03-post-install-verify.ps1`, `05-collect-diagnostics.ps1`,
  `06-safe-cleanup.ps1`) and the
  [`test-config.example.json`](../windows-agent-v2-manual-test/test-config.example.json)
  template.
- The execution report template at
  [`windows-agent-v2-manual-test/EXECUTION_REPORT_TEMPLATE.md`](../windows-agent-v2-manual-test/EXECUTION_REPORT_TEMPLATE.md).
- A staging backend reachable at an `https://...` URL the operator
  controls (DOCKERIZED LOCAL or a labelled staging host).

### 1.4 Outputs produced by this plan

- A filled execution report per Windows OS / PowerShell version
  combination (see Section 11 + the standalone template).
- A redacted diagnostics ZIP per run, produced by
  `05-collect-diagnostics.ps1` (see Section 8 for what it must NOT
  contain).
- A Go / No-Go recommendation per Section 10, signed by the validation
  operator AND a reviewer.

### 1.5 Out of scope

| Topic | Reason |
|---|---|
| Production rollout | Separate Change Advisory Board document |
| `WINDOWS_AGENT_V2_ENABLED` flag flip | Owned by feature-flag governance |
| Production secret / credential rotation | Owned by SecOps |
| VPS / production-host login | Forbidden by this plan |
| Linux agent installer | Pinned by `_linux_installer()` golden; unchanged |
| Runtime bundle BUILDER edits | Owned by [PR #4 builder doc](../ops/windows-runtime-bundle/README.md) |
| Installer GENERATOR edits | Owned by PR #3 / Section H 11-stage doc |

---

## 2. Prerequisites

### 2.1 Test Windows machine requirements

| Item | Minimum |
|---|---|
| OS | Windows Server 2019 (build >= 17763) OR Windows Server 2022 OR Windows 10 22H2 / Windows 11 |
| PowerShell | 5.1 (default on every supported OS above) |
| RAM | >= 4 GB |
| Disk free on `C:` | >= 2 GB |
| Architecture | x64 (`amd64`) |
| Joined to a production AD domain? | **No.** Use a workgroup machine or an isolated staging-only OU. |

### 2.2 Authority requirements

- The operator MUST be a local Administrator on the test machine.
  Self-elevation via UAC is acceptable; non-Administrator runs are
  blocked by `01-preflight.ps1` + the installer.
- The operator MUST NOT carry any production secret on the test
  machine. SSH keys, Azure CLI tokens, AWS profiles, etc. that point
  at production accounts are removed BEFORE the test machine is
  provisioned.
- A second reviewer signs the execution report. The reviewer is NOT the
  operator.

### 2.3 Network access requirements

| Endpoint | Direction | Required? | Notes |
|---|---|---|---|
| Staging backend `https://...` (operator-controlled) | Outbound | YES | Tightly scoped FW rule |
| `python.org`, PyPI, Microsoft Store, winget repos | Outbound | **NO** (must NOT be needed) | Architecture Plan v11 corrections #11 + #32 |
| Production NetManager backend | Outbound | **NO** | Forbidden by this plan |
| RDP / WinRM to the test machine | Inbound | YES, from operator workstation only | NOT from the internet |

The validation FAILS as soon as the operator finds that the agent
contacted any host outside the staging backend.

### 2.4 Backend URL / manifest endpoint requirements

- The staging backend MUST expose the two PR #2 runtime endpoints
  (`/api/v1/agents/{agent_id}/download/runtime/windows-amd64/manifest`
  and `/download/runtime/windows-amd64`) with `WINDOWS_AGENT_V2_ENABLED=True`
  on the **staging instance only**.
- The staging backend MAY use a local docker-compose runtime bundle
  built by the
  [`windows-runtime-bundle.yml`](../.github/workflows/windows-runtime-bundle.yml)
  workflow's deterministic build.
- The staging backend MUST emit the four `X-Charon-*` response
  headers on the manifest endpoint (PR #86 hotfix).
- The staging backend MUST NOT proxy to the production backend; if the
  operator finds that the staging instance forwards installer requests
  to a production host, the validation FAILS.

### 2.5 Test config requirements

- The operator copies
  [`test-config.example.json`](../windows-agent-v2-manual-test/test-config.example.json)
  to `test-config.json` inside the unzipped v4 package directory.
- The operator replaces the two `CHANGE-ME-*` placeholders with the
  staging agent ID and staging agent key (issued by the staging
  backend, not production).
- The operator's notebook for the run records: backend URL (staging
  only), agent ID (staging only), and an attestation that no
  production token / secret / key landed on the test machine.

### 2.6 Production secret / credential rule

- **Zero production secrets on the test machine.** Before the operator
  starts the run, they MUST confirm `Get-ChildItem $env:USERPROFILE\.netrc` /
  `Get-ChildItem $env:USERPROFILE\.aws` / `Get-ChildItem $env:USERPROFILE\.azure`
  return either empty or contain only staging-tagged content. Production
  hits anywhere on the box mean the box is repurposed before continuing.

---

## 3. Test Matrix

Each row produces one execution report. The operator picks the rows
that match the validation goal; the minimum sign-off matrix below must
ALL be PASS before a Go decision (see Section 10).

| Tier | OS | Build | PS | Required for staging sign-off? | Required for production rollout (future)? |
|---|---|---|---|---|---|
| T0  | Windows Server 2022 | 20348 | 5.1 | **YES** | YES |
| T1  | Windows Server 2019 | 17763 | 5.1 | YES (BLOCKED if the host is unavailable AND a tier-0 PASS exists with a documented gap) | YES |
| T2  | Windows 10 22H2 | 19045 | 5.1 | OPTIONAL (recommended) | YES |
| T3  | Windows 11 23H2 | 22631 | 5.1 / 5.1 + side-by-side 7.x | OPTIONAL (recommended) | YES |
| T4  | Windows Server 2025 (preview) | >= 26100 | 5.1 | OPTIONAL | TBD |

### 3.1 PowerShell 5.1 compatibility ground rules

- Every script in the v4 package is asserted ASCII-only and PS 5.1
  parseable by [`win-integrate.yml`](../.github/workflows/win-integrate.yml)
  + [`windows-agent-manual-test-package.yml`](../.github/workflows/windows-agent-manual-test-package.yml)
  on every PR. The operator does NOT install PowerShell 7 on the test
  machine for sign-off; if the operator wants to validate PS 7 behaviour,
  it is a separate execution report flagged in the "PowerShell" field.
- The operator MUST NOT modify any script on the test machine. If the
  script is mutated, the SHA-256 of the v4 ZIP no longer matches and
  the run is INVALID.

### 3.2 No-Python / No-winget environment

- A T0 / T1 / T2 / T3 / T4 host **MUST NOT** have a system Python
  installed, a winget client installed, or a Microsoft Store python.exe
  stub on PATH. The validation goal is to prove the v2 agent works
  WITHOUT any of those.
- If the operator's tier host comes with a system Python (T2 / T3 lab
  images sometimes do), the operator uninstalls it first and re-runs
  `01-preflight.ps1`. The expected post-uninstall result is identical:
  `PRECHECK_RESULT=PASS` (correction #11).

---

## 4. Preflight Checklist

Run this BEFORE the operator executes `01-preflight.ps1`. Each row is
verified by the operator and signed off in the execution report.

| # | Check | How verified |
|---|---|---|
| 4.1 | OS build >= 17763 | `(Get-CimInstance Win32_OperatingSystem).BuildNumber` |
| 4.2 | PowerShell version is 5.1.x | `$PSVersionTable.PSVersion` |
| 4.3 | Operator session is elevated | `[Security.Principal.WindowsPrincipal]([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)` |
| 4.4 | Service `NetManagerAgent` does NOT already exist | `Get-Service NetManagerAgent -ErrorAction SilentlyContinue` returns `$null` |
| 4.5 | `C:\ProgramData\NetManagerAgent\` does NOT already exist | `Test-Path -LiteralPath C:\ProgramData\NetManagerAgent\` is `$false` |
| 4.6 | TLS 1.2 is reachable on the staging backend | `Test-NetConnection <backend-host> -Port 443` |
| 4.7 | Manifest endpoint returns the four `X-Charon-*` headers | `Invoke-WebRequest -Uri "<backend>/api/v1/agents/<staging-id>/download/runtime/windows-amd64/manifest" -Headers @{"X-Agent-Key" = "<staging-key>"} -Method Head` |
| 4.8 | `test-config.json` placeholders replaced with staging values | Operator visually inspects |
| 4.9 | NO real production agent key in `test-config.json` | Operator attestation; key shape is staging-issued |
| 4.10 | Staging backend URL is NOT the production URL | Operator attestation; cross-reference internal allowlist |
| 4.11 | NO production secret on the box (`.netrc`, `.aws`, `.azure`, browser-saved prod tokens) | Operator inspection |
| 4.12 | v4 ZIP SHA-256 matches the workflow-published artifact | `Get-FileHash -LiteralPath .\windows-agent-v2-manual-test-v4.zip -Algorithm SHA256` matches the `windows-agent-manual-test-package.yml` job output |

If ANY row fails, the run is BLOCKED. The operator returns to
Section 2 and re-prepares the machine.

---

## 5. Manual Execution Flow

Performed in order; each step records evidence per Section 8.

### 5.1 Download the v4 ZIP

- Operator opens GitHub Actions, picks the
  `windows-agent-manual-test-package` workflow run on the baseline main
  SHA, downloads the `windows-agent-v2-manual-test-v4` artifact.
- Operator verifies the SHA-256 of the downloaded ZIP against the
  workflow job's reported hash.
- ZIP filename MUST be exactly `windows-agent-v2-manual-test-v4.zip`.

### 5.2 Verify ZIP integrity

- Operator computes `Get-FileHash -LiteralPath .\windows-agent-v2-manual-test-v4.zip -Algorithm SHA256`.
- Operator extracts the ZIP (UI right-click "Extract All" or `Expand-Archive`)
  into a fresh empty folder (e.g. `C:\Users\<operator>\Desktop\v4\`).
- Operator runs the SHA256SUMS verifier inside the extracted folder:
  ```powershell
  $expected = Get-Content -LiteralPath .\SHA256SUMS.txt
  foreach ($line in $expected) {
      if (-not $line.Trim()) { continue }
      $parts = $line.Trim() -split '\s+', 2
      $sha = $parts[0]
      $file = $parts[1]
      $actual = (Get-FileHash -LiteralPath ".\$file" -Algorithm SHA256).Hash.ToLower()
      if ($actual -cne $sha) {
          throw "SHA drift on $file: expected $sha, got $actual"
      }
  }
  Write-Host "SHA256SUMS match." -ForegroundColor Green
  ```
- ANY drift -> the run is INVALID; report it as a security alert (the
  workflow's SHA gate normally catches drift before publication).

### 5.3 Copy `test-config.example.json` -> `test-config.json`

- Operator copies (NOT renames) the example file:
  ```powershell
  Copy-Item -LiteralPath .\test-config.example.json -Destination .\test-config.json
  ```
- The example file STAYS intact at its original byte content (so the
  SHA-256 manifest match in step 5.2 remains valid for the next operator).

### 5.4 Replace `CHANGE-ME-*` placeholders

- Operator opens `test-config.json` in Notepad (or any editor that
  preserves CRLF / UTF-8 without BOM is OK; the agent runtime is BOM-
  tolerant via the PR #1 `utf-8-sig` read).
- Operator replaces:
  - `"backend_url": "https://netmanager.example.app"` -> staging URL.
    The URL MUST have NO trailing slash -- a trailing slash causes the
    installer to concatenate `$BackendUrl/api/v1/...` into a
    `//api/v1/...` URL (Run T1.02 BLOCKED-WITH-LEAK postmortem root
    cause). The backend defensively strips trailing slashes when it
    renders the installer body, but the operator-side
    `02-run-installer.ps1` reads the field verbatim, so keep it clean.
  - `"agent_id": "CHANGE-ME-AGENT-ID"` -> staging-issued ID.
  - `"agent_key": "CHANGE-ME-AGENT-KEY"` -> staging-issued key.
- Operator MUST NOT commit, e-mail, screenshot, paste into chat, or
  print the modified `test-config.json`. The file is wiped by
  `06-safe-cleanup.ps1` at the end of the run.

#### 5.4.1 Backend-side staging URL render override

For local docker-compose staging stacks (Run T1.02 setup), the backend's
request-derived base URL collapses to `http://localhost`, so the rendered
installer's `$BackendUrl` literal points at the backend container's own
loopback and is unreachable from the external Windows test machine.

To fix the render at source, set the backend-side environment variable
before bringing the staging backend up:

```yaml
# docker-compose.override.yml (staging only -- NEVER commit)
services:
  backend:
    environment:
      WINDOWS_AGENT_V2_ENABLED: "true"
      WINDOWS_AGENT_V2_EXTERNAL_BASE_URL: "http://10.2.22.24"
```

The setting MUST be the backend's externally reachable origin. Trailing
slashes are normalized away by the backend. Defaults to unset, in which
case the existing X-Forwarded-Host / request.base_url derivation runs
unchanged -- production deploys behind a reverse proxy DO NOT need to
set it.

#### 5.4.2 Headless execution + rollback cleanup guarantee

Manual validation runs are headless by default -- there is no console
to press Enter on. The rendered installer detects this via two signals
and skips every interactive pause:

- `CHARON_NONINTERACTIVE=1` environment variable. The bundled
  `02-run-installer.ps1` sets this on the child process automatically,
  so an operator running the wrapper does NOT need to set it manually.
- `[Environment]::UserInteractive` is false (CI, scheduled task, SSH
  session without a pty). The installer treats this as non-interactive
  even when the env var is unset.

When non-interactive, every `Wait-ForUserIfInteractive` call in the
installer is a no-op; the installer proceeds straight to exit. An
operator running the rendered installer manually from a double-click
console window still sees the "Press Enter to exit" pauses.

The rollback driver guarantees the Section G.7
`SUCCESSFUL_CLEAN_INSTALL_ROLLBACK` post-condition before writing the
result line: a Phase 2.0 transient-cleanup block wipes `payload\new\`,
`staging\runtime-new.zip`, `staging\runtime-new.manifest.json`,
`staging\runtime-new\` and `staging\config.env.new` (any that exist)
BEFORE the M-marker reverse block, and a post-condition verifier
re-checks the absent set before committing the result. If any of these
artifacts is still present at verification time, the run is degraded
to `ROLLBACK_INCOMPLETE / MANUAL INTERVENTION REQUIRED` and exits 2.

### 5.5 Run `01-preflight.ps1`

- Operator runs from inside the extracted v4 directory:
  ```powershell
  .\01-preflight.ps1
  ```
- Operator captures stdout, stderr, exit code, and the produced
  `preflight.txt` file.
- Expected on PASS: 4 positive-report lines (Section 6.1), zero
  `[BLOCK]` lines, `PRECHECK_RESULT=PASS`, exit code 0.
- Expected on BLOCK: at least one `[BLOCK]` line, `PRECHECK_RESULT=BLOCKED`,
  exit code 1. Operator classifies the failure per Section 7.1.

### 5.6 Run `02-run-installer.ps1`

- Operator runs:
  ```powershell
  .\02-run-installer.ps1
  ```
- Operator captures stdout, stderr, exit code, plus the installer's
  own `installer-run.txt` (lives at
  `C:\ProgramData\NetManagerAgent\installer-run.txt`).
- Expected on PASS: exit code 0, no `[ERROR]` / `[CRITICAL]` lines.
- The installer self-elevates via UAC if not already elevated. The
  operator approves the UAC prompt.
- The installer self-cleans its own on-disk file via the all-paths
  `try/finally` block. The operator MUST NOT manually delete the
  installer file; doing so before the installer's `finally` block
  fires races the agent-key wipe.

### 5.7 Run `03-post-install-verify.ps1`

- Operator runs:
  ```powershell
  .\03-post-install-verify.ps1
  ```
- Operator captures stdout, stderr, exit code, and the produced
  `post-install.txt` file.
- Expected on PASS: every `[OK]` line printed (Section 6.6),
  `POST_INSTALL_RESULT=PASS`, exit code 0.

### 5.8 Run `05-collect-diagnostics.ps1`

- Operator runs:
  ```powershell
  .\05-collect-diagnostics.ps1
  ```
- The script produces a `netmanager-agent-diagnostics-<timestamp>.zip`
  in the current working directory.
- Operator INSPECTS the ZIP (Section 8.4) to confirm NO secret-bearing
  path leaked. If any path from the exclusion list (Section 8.2) is
  present, the run is REPORTED as a leak and the ZIP is securely
  destroyed.

### 5.9 Run `06-safe-cleanup.ps1` (default mode)

- Operator runs:
  ```powershell
  .\06-safe-cleanup.ps1
  ```
- Default mode wipes local test-package artifacts (`preflight.txt`,
  `post-install.txt`, `installer-run.txt`, diagnostics ZIP). The agent
  install on disk is preserved so the operator can review it.

### 5.10 (Optional) Run `06-safe-cleanup.ps1 -RemoveAgentFiles`

- After the operator's evidence collection is complete, the operator
  runs:
  ```powershell
  .\06-safe-cleanup.ps1 -RemoveAgentFiles
  ```
- This wipes the agent install in full: payload, staging, bin,
  `config.env`, `config.env.bak`, `staging\rollback-config.failed`,
  `staging\proc-capture\`, the SCM registration.
- After this step the test machine is in "agent never installed" state
  and the VM can be destroyed.

---

## 6. Expected Successful Results

Each subsection lists the literal text / observable state the operator
verifies. Anything different is classified per Section 7.

### 6.1 Preflight PASS

Output contains, verbatim:

```
Private Python runtime      : not installed
Installer action            : private runtime will be downloaded and installed
System Python required      : No
winget required             : No
```

Followed by `Backend reachable           : <staging-url>`, then zero
`[WARN]` / `[BLOCK]` lines, then `PRECHECK_RESULT=PASS`.
Exit code: 0. `preflight.txt` contents: `PRECHECK_RESULT=PASS\n`.

### 6.2 Installer download

`02-run-installer.ps1` reports `[OK] Installer reported success.` and
exit code 0. The installer file in `$env:TEMP` is wiped before this
script returns.

### 6.3 Runtime manifest + ZIP header behaviour

While Stage 4-5 of the installer runs, the manifest endpoint emits the
four `X-Charon-*` headers (per PR #86 hotfix):

- `X-Charon-Runtime-Version`
- `X-Charon-Runtime-Zip-Sha256` (HEX-UPPER)
- `X-Charon-Python-Version`
- `X-Charon-Compatible-Host-Core-Range`

The Stage 5 SHA cross-check passes (manifest header == manifest body
field == disk SHA). Operator captures the headers via a separate
`Invoke-WebRequest -Method Head` from a reviewer machine to confirm
(see Section 8.5).

### 6.4 Service reaches the expected state

The SCM reports `Running` for `NetManagerAgent` 10 seconds after Stage
10 finishes and again 30 seconds after Stage 10 finishes (the
installer's own Stage 11 verification). Operator independently checks
with:

```powershell
& "C:\ProgramData\NetManagerAgent\bin\charon-agent-host.exe" status `
    --service-name NetManagerAgent
```

Expected: exit 0, stdout `Running\n`, stderr empty.

### 6.5 Stage 11 commit barrier

After the installer's Stage 11 commit barrier passes, the following
paths are GONE from disk:

- `C:\ProgramData\NetManagerAgent\payload\previous\`
- `C:\ProgramData\NetManagerAgent\config.env.bak`
- `C:\ProgramData\NetManagerAgent\bin\charon-agent-host.exe.bak`

These were the rollback targets that Stage 11.D `LOGICAL_DELETE`d only
after Stage 11.A/B/C semantic-equivalence verification passed.

### 6.6 Post-install verifier PASS

Output contains all of:

```
[OK] Private Python runtime present at C:\ProgramData\NetManagerAgent\payload\current\runtime\python\python.exe
[OK] Private Python runtime version: Python 3.12.x
[OK] Deployed smoke list byte-identical to v4 package copy (103 bytes).
[OK] Smoke probe: byte-exact RUNTIME_OK, stderr empty.
[OK] Service status: Running (exit 0, stderr empty).
[OK] Host child process is the PRIVATE python.exe at C:\ProgramData\NetManagerAgent\payload\current\runtime\python\python.exe
[OK] SCM registration matches Stage 11.C canonical-equivalence shape.
```

`post-install.txt` contents: `POST_INSTALL_RESULT=PASS\n`.

### 6.7 Diagnostics collection

`05-collect-diagnostics.ps1` produces a ZIP in the operator's CWD.
Inspecting the ZIP confirms (Section 8.4) it contains a
`diagnostics-summary.txt` listing the included paths AND every excluded
secret-bearing path, plus the SCM registration shape. None of the
excluded paths' contents are inside the ZIP.

### 6.8 Safe cleanup

`06-safe-cleanup.ps1` default mode wipes the local txt + ZIP artifacts.
`06-safe-cleanup.ps1 -RemoveAgentFiles` wipes the agent install in
full; a re-run of `Get-Service NetManagerAgent` returns `$null` and
`Test-Path -LiteralPath C:\ProgramData\NetManagerAgent\` returns `$false`.

### 6.9 Linux installer NOT affected

Out-of-band: the operator (or reviewer) confirms on a Linux box that
the Linux installer download from the staging backend still produces a
byte-identical script (modulo the embedded `Generated:` timestamp). The
SHA-256 golden of the timestamp-stripped Linux installer is
`889654588f35eef1d5e43208840078ed6394aecfeeec6c15544c39342f5d5442`
(pinned by
[`test_linux_unchanged.py`](../backend/tests/win_integrate/test_linux_unchanged.py)).

### 6.10 `WINDOWS_AGENT_V2_ENABLED` did not flip on production

Operator independently confirms by reading the production backend's
`/api/v1/agents/<production-id>/download/runtime/windows-amd64/manifest`
response code: it MUST be `404 Endpoint not available`. If it is `200`,
the production flag flipped and this validation immediately escalates
to incident handling.

---

## 7. Failure Classes

When a step in Section 5 fails, the operator classifies it into ONE of
the following categories and records the classification in the
execution report. The classification drives whether the run continues,
aborts to cleanup, or aborts to incident response.

### 7.1 Preflight failure

- Symptoms: `01-preflight.ps1` exits 1, `PRECHECK_RESULT=BLOCKED`, at
  least one `[BLOCK]` line.
- Action: STOP execution, do NOT run `02-run-installer.ps1`. Operator
  fixes the host condition (admin / disk / network) and re-runs from
  step 5.5.

### 7.2 Download / manifest failure

- Symptoms: `02-run-installer.ps1` exits 1 BEFORE the installer's own
  Stage 4 / Stage 5; OR the installer aborts at Stage 4 with manifest
  schema / header / SHA errors.
- Possible root causes: staging backend down, manifest endpoint not
  emitting `X-Charon-*` headers, ZIP corrupt, manifest field drift vs
  Pydantic schema.
- Action: STOP execution, collect diagnostics (Section 5.8), preserve
  `installer-run.txt`, file a defect against the backend / builder.

### 7.3 Header / runtime compatibility failure

- Symptoms: Stage 5 SHA cross-check fails; OR Stage 4 reports the host
  binary version does not satisfy `compatible_host_core_range`.
- Possible root causes: stale runtime bundle on disk, drifted host
  binary, manifest produced by a different bundle than the one being
  served.
- Action: STOP execution, file a defect against the runtime bundle
  publishing pipeline; do NOT proceed.

### 7.4 Service install failure

- Symptoms: Stage 10 install exit code != 0 (other than 17 anomaly).
- Action: The installer's own Section G rollback runs automatically.
  Operator records the rollback mode reported in `installer-run.txt`
  (`SUCCESSFUL_*_ROLLBACK_*` or `ROLLBACK_INCOMPLETE`). If
  `ROLLBACK_INCOMPLETE`, escalate to incident response; the test
  machine is in a state requiring manual intervention.

### 7.5 Service start failure

- Symptoms: Stage 10 start exit code != 0; OR Stage 11 10s/30s status
  verification fails.
- Action: Installer auto-rollback runs; same handling as 7.4.

### 7.6 Post-install verification failure

- Symptoms: `03-post-install-verify.ps1` exits 1; OR any `[FAIL]` line
  present.
- Possible root causes: service running with a SYSTEM Python (NOT the
  private runtime) -> wrong ImagePath argv -> Stage 11.C semantic
  equivalence drift; smoke list drifted; status not `Running`.
- Action: STOP execution, collect diagnostics, preserve
  `post-install.txt`, file a defect against the installer generator
  (PR #3) or the bundle publishing pipeline.

### 7.7 Diagnostics collection failure

- Symptoms: `05-collect-diagnostics.ps1` errors out OR the produced
  ZIP contains a path from the exclusion list (Section 8.2).
- Action: This is a SECURITY incident. Securely destroy the ZIP
  (`Remove-Item` is fine on the staging VM since the VM is destroyed
  later) AND escalate; the operator does NOT continue.

### 7.8 Cleanup failure

- Symptoms: `06-safe-cleanup.ps1` (default OR `-RemoveAgentFiles`)
  errors out OR leaves any of the wipe targets behind.
- Action: Operator manually wipes the install root, then destroys the
  VM. File a defect against `06-safe-cleanup.ps1`.

---

## 8. Evidence Collection

Each execution report (Section 11) carries the following evidence
fields. Operators redact per Section 8.3.

### 8.1 Command outputs

- Full stdout + stderr of every script run in Section 5.
- Exit code per script.
- Time stamp at the start of each script (operator's wall clock).

### 8.2 Secret-bearing paths the diagnostic ZIP MUST exclude

The CI `package-diagnostics-exclusions` job
(`windows-agent-manual-test-package.yml`) asserts these are excluded by
the script's source; the operator INDEPENDENTLY confirms by inspecting
the ZIP that none of these are present:

- `C:\ProgramData\NetManagerAgent\config.env`
- `C:\ProgramData\NetManagerAgent\config.env.bak`
- `C:\ProgramData\NetManagerAgent\staging\config.env.new`
- `C:\ProgramData\NetManagerAgent\staging\rollback-config.failed`
- Anything under `C:\ProgramData\NetManagerAgent\staging\proc-capture\`
- Anything matching the `failed-*` glob anywhere under the install root

### 8.3 What MUST be masked / redacted before sharing the report

- Real staging agent ID (replace with `STAGING-ID-REDACTED`)
- Real staging agent key (replace with `STAGING-KEY-REDACTED`)
- Operator workstation hostname (replace with `OPERATOR-HOST`)
- Operator login (replace with `OPERATOR`)
- Test machine internal IP (replace with `<test-host-ip>`)

### 8.4 Diagnostics ZIP inspection procedure

```powershell
$z = Get-ChildItem .\netmanager-agent-diagnostics-*.zip | Select-Object -First 1
$tmp = Join-Path $env:TEMP ("diag-inspect-" + [guid]::NewGuid().ToString())
Expand-Archive -LiteralPath $z.FullName -DestinationPath $tmp -Force
Get-ChildItem -LiteralPath $tmp -Recurse | Select-Object FullName, Length
$excluded = @(
    "*\config.env",
    "*\config.env.bak",
    "*\config.env.new",
    "*\rollback-config.failed",
    "*\proc-capture\*",
    "*\failed-*\*"
)
foreach ($glob in $excluded) {
    $hit = Get-ChildItem -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -like $glob }
    if ($hit) {
        throw "Diagnostics ZIP leaked a secret-bearing path: $($hit.FullName)"
    }
}
Remove-Item -LiteralPath $tmp -Recurse -Force
Write-Host "Diagnostics ZIP inspection PASS." -ForegroundColor Green
```

### 8.5 Manifest header capture from a reviewer machine

```powershell
$resp = Invoke-WebRequest `
    -Uri "<staging-backend>/api/v1/agents/<staging-id>/download/runtime/windows-amd64/manifest" `
    -Headers @{ "X-Agent-Key" = "<staging-key>" } `
    -Method Head -UseBasicParsing
$resp.Headers.GetEnumerator() | Where-Object { $_.Key -like "X-Charon-*" }
```

Expected: four `X-Charon-*` headers (Version, Zip-Sha256, Python-Version,
Compatible-Host-Core-Range). Capture redacted output in the report.

### 8.6 Event log snippet

```powershell
Get-WinEvent -LogName Application -MaxEvents 100 |
    Where-Object { $_.ProviderName -eq "NetManagerAgent" -or $_.Message -match "NetManagerAgent" } |
    Select-Object TimeCreated, LevelDisplayName, Message
```

### 8.7 Service status snapshot

```powershell
Get-Service NetManagerAgent | Select-Object Name, Status, StartType, ServiceName
Get-CimInstance Win32_Service -Filter "Name='NetManagerAgent'" |
    Select-Object PathName, StartMode, StartName, DisplayName, Description
```

### 8.8 ZIP SHA-256 record

The exact SHA-256 of `windows-agent-v2-manual-test-v4.zip` the operator
downloaded MUST be recorded in the report, matched against the GitHub
Actions artifact's reported hash.

---

## 9. Rollback / Safe Cleanup

### 9.1 Per-step abort behaviour

| Step | If it fails | Operator action |
|---|---|---|
| 5.5 preflight | Stays at `BLOCKED`, no agent files written | Re-prepare host |
| 5.6 installer | Installer's own Section G rollback runs | Operator captures rollback mode |
| 5.7 verifier | No rollback (verifier is read-only) | Operator collects evidence |
| 5.8 diagnostics | No rollback (read-only collection) | Operator captures error |
| 5.9 cleanup (default) | Local txt + ZIP may persist | Operator manually deletes |
| 5.10 cleanup (-RemoveAgentFiles) | Some agent files may persist | Operator manually wipes install root |

### 9.2 After-run safe cleanup checklist

After the last script in Section 5 finishes (PASS or FAIL):

1. Operator confirms `Get-Service NetManagerAgent` returns `$null`
   (after `-RemoveAgentFiles`).
2. Operator confirms `Test-Path -LiteralPath C:\ProgramData\NetManagerAgent\`
   is `$false` (after `-RemoveAgentFiles`).
3. Operator confirms there are no `*.failed-*` glob hits under
   `C:\ProgramData\` or any temp directory used by the installer.
4. Operator confirms `test-config.json` was wiped by the installer's
   own `finally` block OR by `06-safe-cleanup.ps1`.
5. Operator confirms the SHA256SUMS-checked v4 ZIP folder was
   destroyed (operator securely deletes the entire extracted tree).
6. Operator destroys the test VM if the validation is the last
   scheduled run.

### 9.3 Production system non-touch attestation

The operator signs the following statement in the execution report:

> "I attest that this validation run did NOT modify any production
> system, did NOT contact the production NetManager backend, did NOT
> contact production secrets storage, did NOT flip
> `WINDOWS_AGENT_V2_ENABLED` on production, and did NOT run the
> installer or any of its scripts against a production-tagged Windows
> host."

### 9.4 Log / diagnostics retention policy

- The diagnostics ZIP, the execution report, and any redacted command
  output are retained in the operator's secured storage for the
  duration of the validation campaign (typically 30 days).
- After the campaign concludes, the operator securely deletes the
  diagnostics ZIPs. The execution reports are retained as compliance
  evidence.
- The `test-config.json` file is NEVER retained. It is wiped at run end
  per Section 5.

---

## 10. Go / No-Go Criteria

### 10.1 Staging execution PASS

A single execution report is PASS iff ALL of the following hold:

1. Sections 5.5 - 5.10 each completed with the PASS observables in
   Section 6.
2. Section 7 was NOT triggered.
3. Section 8 evidence is captured + redacted.
4. Section 9 safe cleanup is complete.
5. The reviewer counter-signed the report.

### 10.2 Staging campaign sign-off

The validation campaign is SIGNED OFF iff:

1. T0 (Windows Server 2022) is PASS.
2. T1 (Windows Server 2019) is PASS OR has a documented unavailability
   gap approved by the working group.
3. The Linux byte-equal golden re-verification (Section 6.9) PASSED.
4. The production `WINDOWS_AGENT_V2_ENABLED=False` non-flip check
   (Section 6.10) PASSED.
5. The diagnostics ZIP inspection (Section 8.4) PASSED on every run.

### 10.3 Production rollout prerequisites (NOT in scope of THIS plan)

This plan does NOT authorize production rollout. The production
rollout decision belongs to a SEPARATE document (Change Advisory
Board package). For that document to be considered, this plan's
staging campaign sign-off (Section 10.2) is the **minimum**
prerequisite, but the production rollout has additional gates:

- Security review sign-off (out of scope here).
- Production agent provisioning flow signed off by the agent-key
  governance owner.
- Production rollback rehearsal (separate run).
- Production-shape SLO + paging plan.

If those additional gates are not green, the production rollout
package is REJECTED even if THIS plan's staging campaign was PASS.

### 10.4 Hard STOP conditions

The validation is HARD STOPPED (no further runs in the same campaign)
when any of the following triggers:

- Section 7.7 fires (diagnostics ZIP leaked a secret-bearing path).
- The production `WINDOWS_AGENT_V2_ENABLED` flag is found flipped
  (Section 6.10 violation).
- The Linux byte-equal golden (Section 6.9) drifted.
- A run contacts the production NetManager backend at any point.
- The installer's `ROLLBACK_INCOMPLETE` mode fires.
- The operator detects a production secret on the test machine after
  the run started.

In any STOP condition the operator files an incident before destroying
the test VM.

---

## 11. Execution Report Template

The standalone, operator-fill template lives at
[`windows-agent-v2-manual-test/EXECUTION_REPORT_TEMPLATE.md`](../windows-agent-v2-manual-test/EXECUTION_REPORT_TEMPLATE.md).
Operators DUPLICATE that file per execution and fill in the fields.

The minimum fields the template requires are listed below in summary
form for cross-reference:

- Run ID (e.g. `2026-06-15-T0-WS2022-run01`)
- Test date (UTC)
- Operator name
- Reviewer name (counter-signs at the end)
- Machine info: OS name + build + architecture
- PowerShell version (`$PSVersionTable.PSVersion`)
- Backend URL type: `staging` (operator confirms)
- v4 artifact GitHub Actions run ID
- v4 ZIP SHA-256 (recorded; matched against the workflow artifact hash)
- Per-script PASS/FAIL:
  - `01-preflight.ps1`
  - `02-run-installer.ps1`
  - `03-post-install-verify.ps1`
  - `05-collect-diagnostics.ps1`
  - `06-safe-cleanup.ps1` (default mode)
  - `06-safe-cleanup.ps1 -RemoveAgentFiles` (full wipe)
- Diagnostics ZIP inspection result + summary
- Failure class per Section 7 (if any)
- Final decision: PASS / FAIL / BLOCKED
- Notes (operator)
- Reviewer countersignature

---

## Appendix A: Reference URLs / file paths

### A.1 Repo files this plan references

| Purpose | Path |
|---|---|
| Manual test package directory | [`windows-agent-v2-manual-test/`](../windows-agent-v2-manual-test/) |
| Package README | [`windows-agent-v2-manual-test/00-README-START-HERE.txt`](../windows-agent-v2-manual-test/00-README-START-HERE.txt) |
| Preflight script | [`windows-agent-v2-manual-test/01-preflight.ps1`](../windows-agent-v2-manual-test/01-preflight.ps1) |
| Installer orchestrator | [`windows-agent-v2-manual-test/02-run-installer.ps1`](../windows-agent-v2-manual-test/02-run-installer.ps1) |
| Post-install verifier | [`windows-agent-v2-manual-test/03-post-install-verify.ps1`](../windows-agent-v2-manual-test/03-post-install-verify.ps1) |
| Diagnostics collector | [`windows-agent-v2-manual-test/05-collect-diagnostics.ps1`](../windows-agent-v2-manual-test/05-collect-diagnostics.ps1) |
| Safe cleanup | [`windows-agent-v2-manual-test/06-safe-cleanup.ps1`](../windows-agent-v2-manual-test/06-safe-cleanup.ps1) |
| Test config template | [`windows-agent-v2-manual-test/test-config.example.json`](../windows-agent-v2-manual-test/test-config.example.json) |
| Smoke list (verification-only copy) | [`windows-agent-v2-manual-test/runtime-smoke-imports.txt`](../windows-agent-v2-manual-test/runtime-smoke-imports.txt) |
| File hash manifest | [`windows-agent-v2-manual-test/SHA256SUMS.txt`](../windows-agent-v2-manual-test/SHA256SUMS.txt) |
| Execution report template | [`windows-agent-v2-manual-test/EXECUTION_REPORT_TEMPLATE.md`](../windows-agent-v2-manual-test/EXECUTION_REPORT_TEMPLATE.md) |
| Section H 11-stage installer generator | [`backend/app/api/v1/endpoints/agents.py`](../backend/app/api/v1/endpoints/agents.py) (function `_windows_installer`) |
| Linux installer (untouched golden) | [`backend/app/api/v1/endpoints/agents.py`](../backend/app/api/v1/endpoints/agents.py) (function `_linux_installer`) |
| Linux installer golden test | [`backend/tests/win_integrate/test_linux_unchanged.py`](../backend/tests/win_integrate/test_linux_unchanged.py) |
| Runtime bundle builder | [`ops/windows-runtime-bundle/build.py`](../ops/windows-runtime-bundle/build.py) |
| Manual test package CI | [`.github/workflows/windows-agent-manual-test-package.yml`](../.github/workflows/windows-agent-manual-test-package.yml) |
| WIN-INTEGRATE CI | [`.github/workflows/win-integrate.yml`](../.github/workflows/win-integrate.yml) |
| Runtime bundle CI | [`.github/workflows/windows-runtime-bundle.yml`](../.github/workflows/windows-runtime-bundle.yml) |

### A.2 Baseline SHAs

- `main` baseline: `646ff665cda0fc01a7aa12e7c2ee825a7ed3916e`
- Linux installer golden:
  `889654588f35eef1d5e43208840078ed6394aecfeeec6c15544c39342f5d5442`
- Manual test package artifact name: `windows-agent-v2-manual-test-v4.zip`
- Host CLI source pin: `e9becfe42252ad0f7bdc0ce38c9826f1b73e7437`
  (Coosef/netmanager, schema v2)

### A.3 Production allowlist non-touch list

Operator MUST NOT contact:
- The production NetManager backend URL
- Any host on the production NetManager VPS allowlist
- Production observability stacks (Grafana, OpenTelemetry collector)
- Production secret stores
- Production AD domain controllers

---

## Appendix B: Glossary / acronyms

| Term | Meaning |
|---|---|
| v4 package | The manual test package shipped by PR #87, archived as `windows-agent-v2-manual-test-v4.zip`. |
| Section H | The 11-stage installer flow described in Architecture Plan v11 Section H (corrections #66-#72). |
| Stage 11.A/B/C | The installer's pre-commit SCM registration semantic-equivalence checks. |
| Stage 11.D | The post-verification `LOGICAL_DELETE` of backup paths (`payload\previous\`, `config.env.bak`, `bin\charon-agent-host.exe.bak`). |
| LOGICAL_DELETE | A force-delete followed by an explicit non-existence verification (correction #57). |
| `Invoke-ProcessCaptured` | The PS 5.1 compatible helper that captures stdout / stderr / exit code separately (correction #66). |
| `Invoke-HostInstall` | The canonical install invocation wrapping the host CLI's full flag set (correction #58). |
| Smoke list | The 103-byte `runtime-smoke-imports.txt` canonical 12-module list (correction #63). |
| `RUNTIME_OK` | The byte-exact literal the smoke probe MUST emit on stdout. |
| WINDOWS_AGENT_V2_ENABLED | Backend feature flag; production default `False`; this plan does NOT flip it. |
