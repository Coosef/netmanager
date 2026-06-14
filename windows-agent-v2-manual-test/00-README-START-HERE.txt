PACKAGE VERSION: v4

This is the v4 NetManager Windows Agent v2 manual test package.

Do not use v1, v2, or v3 of this package. They predate the private
Python runtime + Section H 11-stage installer and are incompatible
with the production backend's runtime endpoints. If you have an
older copy on disk, delete it before continuing.

============================================================================
NetManager Windows Agent v2 - Manual Test Package (v4)
============================================================================

Six hard rules:

  1. Do not install Python manually.
  2. Do not install winget manually.
  3. Do not modify the system PATH.
  4. The Windows Agent installer provides its own private runtime.
  5. Target machine requires HTTPS access only to the configured
     NetManager backend.
  6. No direct access to python.org, PyPI, Microsoft Store, winget
     repositories, or other third-party package services is required.

Execution order on the target Windows Server / Workstation:

  01-preflight.ps1
      Confirm the box can host the agent. Emits PRECHECK_RESULT=PASS or
      PRECHECK_RESULT=BLOCKED with a list of blockers.

  02-run-installer.ps1
      Download the production installer from the configured NetManager
      backend over HTTPS (uses the agent-id + agent-key from
      test-config.json) and run it elevated. The installer itself is
      authored by the backend and follows the Section H 11-stage flow
      (Architecture Plan v11): private Python runtime extracted to
      payload\current\runtime\python\, transactional swap, Stage 11
      commit-barrier with SCM registration semantic equivalence.

  03-post-install-verify.ps1
      Confirm the agent process is running with the PRIVATE python.exe
      (NOT a system Python), that the on-disk smoke import set matches
      the deployed copy byte-for-byte, and that the SCM registration
      ImagePath argv matches the canonical Stage-10 install shape.

  04 is reserved for controlled-failure rollback testing
      (operator-optional; not part of the standard regression path).

  05-collect-diagnostics.ps1
      Bundle a redacted diagnostic ZIP for support. EXCLUDES every
      secret-bearing path: config.env / config.env.bak / config.env.new /
      staging\rollback-config.failed / staging\proc-capture\*.

  06-safe-cleanup.ps1
      Default cleanup leaves the installed agent in place. Passing
      -RemoveAgentFiles also wipes payload\, staging\, bin\, config.env,
      config.env.bak, staging\rollback-config.failed, and
      staging\proc-capture\, returning the box to a clean-install state.

============================================================================
Configuration
============================================================================

Copy test-config.example.json to test-config.json (in the same folder as
the scripts above) and fill in:

  backend_url            HTTPS URL of the configured NetManager backend
  agent_id               Agent identifier the backend issued for this box
  agent_key              Agent key the backend issued (keep this secret)

Never commit test-config.json or any artifact that embeds the agent key
into version control. The installer itself wipes the on-disk installer
file from PSCommandPath in its finally block; this package's scripts
DO NOT carry the agent key in their text (they read it from
test-config.json at run time).

============================================================================
What this package does NOT contain
============================================================================

  - The installer itself. 02-run-installer.ps1 downloads it from the
    backend; no version of the installer is checked in here.
  - Any production secret, credential, or private key.
  - Any binary larger than a few KB. The private Python runtime + Go
    host binary are served by the backend at install time.

============================================================================
What this package DOES contain
============================================================================

  - This README (00-README-START-HERE.txt)
  - The five operator scripts above (01, 02, 03, 05, 06)
  - runtime-smoke-imports.txt - the 103-byte canonical smoke list, kept
    here as a VERIFICATION-ONLY byte copy that 03-post-install-verify.ps1
    compares against the deployed copy at
    payload\current\metadata\runtime-smoke-imports.txt.
  - test-config.example.json - template configuration.
  - SHA256SUMS.txt - SHA-256 of every file in this package, sorted
    alphabetically. The CI workflow regenerates this on every change
    and the package ZIP fails if any file's hash drifts.

All scripts are ASCII-safe + PS 5.1 compatible + locale-independent.
