# Service Identity — MVP-0 Decision Record

**Date:** 2026-06-11
**PR:** #76
**Status:** Accepted

## Decision

The MVP-0 host runs as **`LocalSystem`**.

This is encoded in `internal/config/config.go` (`Validate` rejects any
other value) and in `internal/service/manager_windows.go` (the
`ServiceStartName` field is left empty, which is the SCM idiom for
LocalSystem).

## Why not LocalService / NetworkService

The Python child process the host supervises makes the following
calls:

| Subsystem  | Requirement                                            |
|------------|--------------------------------------------------------|
| SSH        | Outbound TCP 22 (source port ≥ 1024, no privilege)     |
| SNMP poll  | Outbound UDP 161 (source port ≥ 1024, no privilege)    |
| SNMP trap  | Inbound UDP 162 (requires bind privilege below 1024)   |
| ICMP ping  | Raw socket (requires SeCreateGlobalPrivilege)          |
| File I/O   | Read/write `C:\ProgramData\NetManagerAgent\…`          |

ICMP raw sockets and SNMP trap listener (UDP 162) are the constraints.
`LocalService` lacks raw-socket privilege by default; `NetworkService`
similarly cannot bind to low ports without an explicit grant.

Manually granting `SeCreateGlobalPrivilege` to a non-LocalSystem
account is possible, but doing so as part of a single-shot installer
in a customer's Active Directory domain is brittle and Active
Directory-policy-dependent. The MVP-0 priority is "service that
actually runs"; the privilege profile gets cleaned up in MVP-1.

## Risk acknowledged

Because the host runs as LocalSystem:

- The Python child inherits LocalSystem.
- Any RCE in the agent or its dependencies is a SYSTEM compromise.
- `C:\ProgramData\NetManagerAgent` is ACL-hardened by the PowerShell
  installer (SID-based: `S-1-5-18` SYSTEM + `S-1-5-32-544`
  Administrators only) so non-admin local users cannot read the
  agent key or substitute the agent script.

## MVP-1 plan

The privilege footprint is logged as a `MVP-1` follow-up:

1. Profile actual `SeXxxPrivilege` use in production for two weeks.
2. Identify the minimum set required by raw socket + trap listener.
3. Switch to `NetworkService` and add the minimum privileges via
   `secedit` at install time.
4. Move the agent key from `config.env` (plaintext) to DPAPI
   (`ProtectedData.Protect`, LocalMachine scope) so even root local
   read no longer leaks it.

That work is **out of scope for PR #76**.
