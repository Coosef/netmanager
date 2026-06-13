# NetManager Windows Agent v2 — runtime bundle build inputs

This tree is the canonical, version-controlled build input for the
Windows Agent v2 runtime bundle. The bundle itself (a ~30 MB ZIP plus a
detached `.sha256` and `.manifest.json`) is produced offline by the
backend's CI workflow `windows-runtime-bundle.yml` (lands in PR #4).
PR #1 ships only this tree + the backend pure-Python services + tests.

## Files

| Path | Purpose |
|---|---|
| `release-pins.toml` | Version + URL + SHA-256 pins (no timestamp). |
| `requirements-windows.lock` | `pip-compile --generate-hashes` output for the runtime's Python deps. |
| `runtime-smoke-imports.txt` | Authoritative 12-module smoke-import list (UTF-8 no-BOM LF; 103 bytes for the canonical set). |
| `build.py` | Builder script. Implements `--check` in PR #1; `--build` lands in PR #4. |
| `EMBEDDED_PYTHON_SOURCE.md` | Pinned python.org embedded distribution. |
| `README.md` | This file. |

## SOURCE_DATE_EPOCH is REQUIRED

The builder MUST be invoked with `SOURCE_DATE_EPOCH` set in the
environment. Missing, empty, negative, non-integer, or out-of-range
values cause an immediate `BUILDER_ERROR` and `exit 1`. There is no
wall-clock fallback. This is enforced in both `--check` and `--build`
modes.

The same epoch value drives:

- the detached manifest's `built_utc` field (formatted from the original
  epoch),
- every ZIP entry timestamp (formatted from the DOS-bucket-normalized
  epoch — `epoch - (epoch % 2)`, per the MS-DOS 2-second resolution).

Two clean builds at different wall-clocks but the same explicit
`SOURCE_DATE_EPOCH` produce byte-identical ZIP + manifest + `.sha256`.
Two clean builds with different `SOURCE_DATE_EPOCH` values that fall in
different MS-DOS 2-second buckets produce different ZIP SHA-256 AND
different manifest `built_utc`.

## Offline / online

Build TIME requires internet (the wheelhouse populates from PyPI and
the embedded Python ZIP downloads from python.org).

INSTALL time on the target Windows machine does NOT require internet to
python.org, PyPI, Microsoft Store, winget, or any other third-party
package source. The installer only needs HTTPS to the configured
NetManager backend.

This is the "third-party-package-offline" contract — see Section B of
the architecture plan.

## Running `--check` locally

```
$ SOURCE_DATE_EPOCH=1735689600 python3 ops/windows-runtime-bundle/build.py --check
runtime_version         : 1.0.0
python_version          : 3.12.6
platform                : windows-amd64
compatible_host_core_range : >=2.0.0 <3.0.0
SOURCE_DATE_EPOCH       : 1735689600 (2025-01-01T00:00:00Z)
ZIP DOS-bucket epoch    : 1735689600
smoke modules           : 12 (ssl, socket, ctypes, asyncio, netmanager_agent,
                              websockets, netmiko, paramiko, cryptography,
                              bcrypt, nacl, psutil)
lock entries            : 11
CHECK_RESULT=OK
```

Without `SOURCE_DATE_EPOCH`:

```
$ python3 ops/windows-runtime-bundle/build.py --check
BUILDER_ERROR: SOURCE_DATE_EPOCH is REQUIRED (correction #22). ...
$ echo $?
1
```

## What is NOT in this PR

- The full `--build` flow (download + extract + pip install --target +
  deterministic ZIP assembly + detached manifest emission).
- The `windows-runtime-bundle.yml` CI workflow that exercises the
  builder on `windows-2022` against real wheels.
- The backend endpoints serving the bundle / manifest.
- Any modification to `_windows_installer()` in `agents.py`.
- Any change to `windows-agent-v2-manual-test/`.

These ship in PR #2 through PR #6. See the sprint plan in the
implementation handoff notes.
