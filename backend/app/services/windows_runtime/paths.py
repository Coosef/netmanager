"""Windows Agent v2 on-disk path constants — Section A of the architecture plan.

Pure constants. No I/O. Mirror exactly the on-disk layout the installer
generator (PR #3) will emit and the post-install verifier (PR #5) will
read. Code that mutates the filesystem belongs in PR #3.
"""
from __future__ import annotations

# Top-level install root. Always absolute, under ProgramData.
INSTALL_DIR = r"C:\ProgramData\NetManagerAgent"

# Go service host (live + backup).
HOST_BIN_DIR = INSTALL_DIR + r"\bin"
HOST_EXE_LIVE = HOST_BIN_DIR + r"\charon-agent-host.exe"
HOST_EXE_NEW = HOST_EXE_LIVE + ".new"
HOST_EXE_BAK = HOST_EXE_LIVE + ".bak"

# Payload root + the three swap dirs.
PAYLOAD_ROOT = INSTALL_DIR + r"\payload"
PAYLOAD_CURRENT = PAYLOAD_ROOT + r"\current"
PAYLOAD_NEW = PAYLOAD_ROOT + r"\new"
PAYLOAD_PREVIOUS = PAYLOAD_ROOT + r"\previous"

# Subtree under any of the three payload swap dirs.
RUNTIME_SUBDIR = r"runtime\python"
APP_SUBDIR = "app"
LICENSES_SUBDIR = "licenses"
METADATA_SUBDIR = "metadata"

# Deployed runtime + app inside the LIVE payload.
PRIVATE_PYTHON = PAYLOAD_CURRENT + r"\runtime\python\python.exe"
PRIVATE_PYTHONW = PAYLOAD_CURRENT + r"\runtime\python\pythonw.exe"
APP_DIR = PAYLOAD_CURRENT + r"\app"
APP_ENTRYPOINT = APP_DIR + r"\run_agent.py"
APP_AGENT_MODULE = APP_DIR + r"\netmanager_agent.py"
LICENSES_DIR = PAYLOAD_CURRENT + r"\licenses"
METADATA_DIR = PAYLOAD_CURRENT + r"\metadata"
SMOKE_LIST_LIVE = METADATA_DIR + r"\runtime-smoke-imports.txt"
RUNTIME_MANIFEST_LIVE = PAYLOAD_CURRENT + r"\runtime-manifest.json"

# Config files (transactional per #17).
CONFIG_ENV_LIVE = INSTALL_DIR + r"\config.env"
CONFIG_ENV_BAK = CONFIG_ENV_LIVE + ".bak"

# Logs + staging.
LOGS_DIR = INSTALL_DIR + r"\logs"
STAGING_DIR = INSTALL_DIR + r"\staging"

STAGING_RUNTIME_MANIFEST = STAGING_DIR + r"\runtime-new.manifest.json"
STAGING_RUNTIME_ZIP = STAGING_DIR + r"\runtime-new.zip"
STAGING_EXTRACTED_DIR = STAGING_DIR + r"\runtime-new"
STAGING_CONFIG_NEW = STAGING_DIR + r"\config.env.new"
STAGING_ROLLBACK_CONFIG_FAILED = STAGING_DIR + r"\rollback-config.failed"
STAGING_PROC_CAPTURE = STAGING_DIR + r"\proc-capture"
STAGING_INSTALL_ABORTED_TXT = STAGING_DIR + r"\install-aborted.txt"

# Installer status / audit file (per architecture plan).
INSTALLER_RUN_TXT = INSTALL_DIR + r"\installer-run.txt"

# Service registration key under HKLM. The probe in PR #3's Stage 2B
# reads this via `Test-Path Registry::HKLM\...\NetManagerAgent`.
SERVICE_NAME = "NetManagerAgent"
SCM_REGISTRY_PATH = (
    r"HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Services\NetManagerAgent"
)

# Required keys in config.env (Stage 7 validation).
CONFIG_REQUIRED_KEYS: tuple[str, ...] = (
    "AGENT_ID",
    "AGENT_KEY",
    "HUB_URL",
)


# Secret-bearing paths (correction #56). The agent key MAY appear ONLY
# in these files; it MUST NOT appear in any other artifact, log, or
# response.
SECRET_BEARING_PATHS: tuple[str, ...] = (
    CONFIG_ENV_LIVE,
    CONFIG_ENV_BAK,
    STAGING_CONFIG_NEW,
    STAGING_ROLLBACK_CONFIG_FAILED,
)
