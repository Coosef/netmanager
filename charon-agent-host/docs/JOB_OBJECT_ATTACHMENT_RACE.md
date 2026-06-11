# Job Object Attachment Race — MVP-0 Decision Record

**Date:** 2026-06-11
**PR:** #76 (Commit 2)
**Status:** Accepted (Option B — race acknowledged + deferred)
**Tracking issue:** to be opened as `WIN-HOST-HARDENING/job-attachment-race`

## What the race is

`internal/child/process.go::Start` launches the child with
`os/exec`'s `cmd.Start()` first, then calls `attachToJob()` which
opens a fresh Job Object and assigns the running child to it:

```go
if err := cmd.Start(); err != nil {        // (1) child already running
    return err
}
p.cmd = cmd
p.exitCh = make(chan ExitInfo, 1)

if err := p.attachToJob(); err != nil {    // (2) assignment happens *here*
    ...
}
```

Between (1) and (2) — a window measured in **single-digit
milliseconds on a typical loaded host** — the child is running but
not yet a member of any Job Object. If the child spawns a
grandchild process during that window (e.g. Python launches an SSH
subprocess in its module-import phase), that grandchild is **not**
covered by `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and can outlive a
host crash as an orphan.

## What we explicitly considered and rejected

A reviewer suggested a fix shaped like:

```go
cmd.SysProcAttr.CreationFlags |= windows.CREATE_SUSPENDED
... start ... attach to job ...
windows.ResumeThread(p.cmd.Process.Handle)   // ❌ wrong handle type
```

This is **technically wrong** and has been explicitly rejected:

- `ResumeThread` takes a **thread** handle, not a process handle.
- `os/exec.Cmd` does not expose the primary thread handle that
  `CreateProcess` returned — it only stashes the process handle on
  `cmd.Process`.
- Calling `ResumeThread(processHandle)` returns the function-style
  error code (no thread resumed); the child stays suspended forever
  and the service start times out.

Any "fix" that calls `ResumeThread` on `cmd.Process.Handle` would
ship a broken host that never starts. It is **not** an acceptable
shortcut.

## Why we are not doing Option A in MVP-0

The correct fix (Option A in the review notes) replaces `os/exec`
entirely with a hand-rolled launcher that calls
`windows.CreateProcess` directly, captures both `hProcess` and
`hThread` from `PROCESS_INFORMATION`, assigns the process to the
Job Object while still suspended, then `ResumeThread(hThread)`.

That work is in-scope for the agent v2 hardening backlog, not for
MVP-0, because it requires re-implementing:

- argv quoting (Windows command-line concatenation rules)
- the environment block (NUL-terminated, double-NUL-terminated)
- stdin / stdout / stderr inheritance + pipe creation
- handle leak prevention across every error path
- a parallel test suite that proves all of the above does not
  regress against `os/exec`'s behaviour today

Doing that work in PR #76 would push the PR past the 4-week MVP-0
budget and introduce a new launcher whose own bugs would be more
expensive than the residual race we are trying to close.

## What we ARE doing in MVP-0 to compress the race

1. `applySysProcAttr` keeps `CREATE_NEW_PROCESS_GROUP`. This does
   NOT close the race but it does isolate the child's console
   group so a future cooperative `CTRL_BREAK_EVENT` (MVP-1) can
   target it without affecting the host.
2. `child.Process.Start` calls `attachToJob` immediately after
   `cmd.Start`, before any other work, so the window is as short
   as the Go scheduler allows.
3. The child the host supervises (the Python NetManager agent v1)
   does not spawn subprocesses during its module-import phase —
   `paramiko` / `netmiko` are lazy; SSH sessions are only created
   after the WebSocket has been negotiated, which takes hundreds
   of milliseconds. Empirically the race window closes long before
   the child can spawn anything.
4. `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` is still set so that any
   grandchild that DOES get assigned to the job will still be
   terminated atomically on host shutdown.

## What we are NOT relying on

We are NOT claiming MVP-0 gives a hermetic orphan guarantee. The
docs/LIFECYCLE.md "Job Object" section is honest about this:

> If the child spawns a subprocess during the very first
> milliseconds after launch — before the host has assigned it to
> the Job Object — that subprocess will not be reaped by
> KILL_ON_JOB_CLOSE.

## Migration path

When the Go-native worker replaces the Python child (later MVP),
the in-process supervisor and the launched workload share an
address space and the Job Object attachment race disappears
entirely. The hand-rolled launcher in Option A becomes obsolete
work that we correctly avoided.

If, before that migration, telemetry shows real orphan grandchildren
in production, the WIN-HOST-HARDENING work item is promoted from
backlog to in-flight and Option A ships in its own PR with its own
test budget.
