"""Windows Agent v2 runtime services — pure Python foundation.

PR #1 ships only the pure-Python contract surfaces consumed by the
future installer generator (PR #3) and the future runtime-bundle
endpoints (PR #2). This package is import-safe in any context — it
opens no files, makes no network calls, and reads no environment at
import time.
"""
