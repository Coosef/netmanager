# Service Lifecycle

This is the operational contract between the host and the SCM, plus
the host and its Python child. Anyone debugging a stuck or flapping
agent should be able to read this and predict what every component
will do.

## SCM ↔ host

```
SCM Start                       ┌────────────────────────────┐
   │                            │ status: StartPending       │
   ▼                            │ (sent IMMEDIATELY — before │
charon-agent-host run …         │  any setup work)           │
   │                            └──────────────┬─────────────┘
   │                                           │
   │   logger init                             │
   │   event log open                          │
   │   build env from EnvFile (BOM-stripped)   │
   │   start Python child                      │
   │   attach to Job Object                    │
   │                                           ▼
   │                            ┌────────────────────────────┐
   │                            │ status: Running            │
   │                            │ accepts: Stop | Shutdown   │
   │                            └────────────────────────────┘
   │
   │   ◄ child exits unexpectedly ─►  backoff (1s/5s/15s/30s/60s)
   │                                   then restart
   │
SCM Stop received
   │                            ┌────────────────────────────┐
   │                            │ status: StopPending        │
   ▼                            └──────────────┬─────────────┘
   try child.Stop(5s grace)                    │
       └─ TerminateJobObject (force)           │
   ▼                                           ▼
   status: Stopped                  process exits
```

## host ↔ Python child shutdown sequence

Critical claim: **CTRL_BREAK_EVENT is NOT used as a guaranteed shutdown
mechanism.** Console control events are unreliable inside a Windows
service (no console attached by default), so the host does not rely
on them. The sequence is:

1. **Cooperative signal** *(MVP-1 future)* — a named event
   `Global\NetManagerAgent-Shutdown` the Python agent watches. Not
   implemented in MVP-0.
2. **Grace window** — the host waits up to 5 seconds for the child to
   exit on its own (e.g. via its WebSocket disconnect handler noticing
   it has been orphaned).
3. **Job Object force termination** — the only guaranteed step.
   `TerminateJobObject(exitCode=1)` atomically kills the entire
   process tree assigned to the job.

The host also configures `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` on the
job, so even if the host itself crashes (panic, taskkill from outside,
BSOD recovery) the kernel still reaps the entire child tree when the
host's handle goes away.

## Crash-recovery responsibility split

| Crash         | Recoverer | Mechanism                                          |
|---------------|-----------|----------------------------------------------------|
| Python child  | host      | Backoff schedule (1s/5s/15s/30s/60s, reset @ 60s)  |
| host          | SCM       | Service Recovery Actions: 10s/30s/60s              |

These are non-overlapping by construction. A host crash kills the
Python child (Job Object), then SCM relaunches the host, which
performs an initial child start (no backoff, because counters are
in-memory).

## Windows Event Log IDs

Source: `NetManagerAgentHost`

| ID    | Severity | Meaning                                  |
|-------|----------|------------------------------------------|
| 1000  | Info     | Service started                          |
| 1001  | Info     | Service stopped (graceful)               |
| 1002  | Warning  | Child process exited unexpectedly        |
| 1003  | Warning  | Restart backoff at cap (still trying)    |
| 2000  | Error    | Failed to start child process            |
| 2001  | Error    | Configuration invalid                    |
| 2002  | Warning  | Service shutdown forced (grace timeout)  |
| 9999  | Error    | Unexpected host panic (recovered)        |
