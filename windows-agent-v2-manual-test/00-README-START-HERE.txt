NETMANAGER / CHARON
WINDOWS AGENT V2 - MANUAL TEST PACKAGE

================================================================
PLEASE READ BEFORE TOUCHING ANY SCRIPT
================================================================

This package contains six PowerShell scripts that walk a real
Turkish Windows test machine through the Windows Agent v2 manual
validation gates. NOTHING in this package downloads, builds, or
ships the real installer; that step is delivered separately,
once preflight comes back clean.

The scripts are designed to:
  - run on Windows PowerShell 5.1 (the default shell on tr-TR
    Windows 10/11 and Windows Server 2019/2022)
  - leave the test machine in a recoverable state at every step
  - never write any agent key, token, password, certificate, or
    transcript fragment into the diagnostics bundle that gets
    sent back

================================================================
OPERATOR PROCEDURE
================================================================

Step 1.  Copy windows-agent-v2-manual-test.zip onto the Windows
         test machine via AnyDesk file transfer.

Step 2.  Extract the ZIP to:

             C:\CharonAgentTestPackage

         The extracted folder must contain six .ps1 files plus
         00-README-START-HERE.txt, test-config.example.json and
         SHA256SUMS.txt at its root.

Step 3.  Open a NON-ELEVATED Windows PowerShell window (do not
         right-click "Run as administrator" yet). Run preflight
         first; the wrapper at step 4 handles elevation when the
         installer itself is in play.

             cd C:\CharonAgentTestPackage
             powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\01-preflight.ps1

Step 4.  Open the preflight output:

             C:\Users\Public\CharonAgentTest\preflight.txt

         The LAST line is one of:

             PRECHECK_RESULT=PASS
             PRECHECK_RESULT=BLOCKED

         If PASS: stop here. Send preflight.txt back through the
         AnyDesk operator before continuing. Do not run the
         installer wrapper until you receive an explicit GO and
         a separately delivered installer file path.

         If BLOCKED: also stop. Send preflight.txt back. The
         blocked reasons are listed individually inside the
         output file so the next step can be decided together.

Step 5.  (Only after explicit GO with installer path.)

             powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\02-run-installer.ps1 -InstallerPath "C:\Path\to\netmanager-agent-installer.ps1"

         02-run-installer.ps1 will validate the .ps1 byte
         contract, ParseFile-check it on PowerShell 5.1, refuse
         to run it on any forbidden pattern (iex, sc.exe create,
         IsInRole("Administrator"), etc.), and then launch it
         with -File under UAC. It does NOT pipe content into
         Invoke-Expression. Ever.

Step 6.  After installer success:

             powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\03-post-install-verify.ps1

Step 7.  Optional, only on explicit GO:

             powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\04-service-lifecycle-test.ps1

         This script will ask the operator to TYPE the word
         TEST before doing anything destructive-ish. It only
         touches the NetManagerAgent service and the verified
         Python child PID of that service. It never kills the
         Go host process directly, never uninstalls, never
         deletes files.

Step 8.  Diagnostics collection (always safe to run):

             powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\05-collect-diagnostics.ps1

         This produces:

             C:\Users\Public\CharonAgentTest\diagnostics\
             C:\Users\Public\CharonAgentTest\CharonAgentDiagnostics-<UTC>.zip

         The bundle is masked: config.env contents, X-Agent-Key
         headers, JWT/Bearer/Authorization values, AGENT_KEY=
         lines, and UUID-shaped tokens are scrubbed.

Step 9.  When the test campaign ends:

             powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\06-safe-cleanup.ps1 -CleanupDiagnostics
             powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\06-safe-cleanup.ps1 -UninstallAgent
             powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\06-safe-cleanup.ps1 -UninstallAgent -RemoveAgentFiles

         Each escalation path requires a separate typed
         confirmation: UNINSTALL-NETMANAGER-AGENT and
         DELETE-AGENT-FILES.

================================================================
HARD RULES
================================================================

- Do NOT pipe any installer content through iex / Invoke-Expression.
- Do NOT change ExecutionPolicy at the LocalMachine / CurrentUser
  scope. ExecutionPolicy Bypass is only used per-process when
  invoking these scripts.
- Do NOT send the contents of:
      C:\ProgramData\NetManagerAgent\config.env
      C:\ProgramData\NetManagerAgent\bin\charon-agent-host.exe.bak
      C:\ProgramData\NetManagerAgent\logs\agent.stdout.log
      (if it contains key material)
  back through chat or AnyDesk. The diagnostics ZIP is the only
  approved channel and it applies masking.
- Do NOT add a real production agent ID/key to test-config.json.
  The example config has no secrets on purpose.
- Do NOT run scripts in any order other than the one above.

If at any stage the output reports BLOCKED, FAIL, or exit code
2 ("manual intervention required") - stop, collect diagnostics
with 05-collect-diagnostics.ps1, and send the ZIP back. Do not
attempt remediation until the next instruction.

================================================================
WHERE OUTPUTS GO
================================================================

All output files are created under:

    C:\Users\Public\CharonAgentTest\

These are the only files this package writes:

    preflight.txt
    installer-run.txt
    installer-exit-code.txt
    installer-sha256.txt
    installer-parser-result.txt
    post-install.txt
    service-lifecycle.txt
    diagnostics\
    CharonAgentDiagnostics-<UTC>.zip

Nothing is written to HKLM, HKCU, system32, the Windows
firewall, the antivirus, or anywhere else. The only system
state change happens when you explicitly run 02-run-installer
or 06-safe-cleanup.

================================================================
END OF README
================================================================
