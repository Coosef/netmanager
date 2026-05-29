# Tech-Debt Backlog

Cross-cutting issues found incidentally during other workstreams. Each is
independent — not owned by the topology or tenancy workstreams.

## TD-1 — `@xterm/*` frontend dependency is unresolvable

`frontend/package.json` declares:

```
"@xterm/xterm": "^6.0.0"
"@xterm/addon-fit": "^0.11.0"
"@xterm/addon-web-links": "^0.12.0"
```

`@xterm/xterm@^6.0.0` does not exist (the package's current major is 5.x),
so `npm install` cannot install it and the modules are absent from
`node_modules`. Consequences:

- `npm run build` fails — `tsc` reports `TS2307: Cannot find module
  '@xterm/xterm'` (+ implicit-any errors) and Rollup fails to resolve the
  import — in `src/components/SshTerminal.tsx` and
  `src/pages/SshTerminalPage/index.tsx`.
- This is **pre-existing**, unrelated to the topology or tenancy work.

**Fix:** pin to the real versions (current: `@xterm/xterm@^5.5.0`,
`@xterm/addon-fit@^0.10.0`, `@xterm/addon-web-links@^0.11.0` — verify
latest), `npm install`, refresh `package-lock.json`, and resolve the
two implicit-`any` parameters in the SSH terminal files. Then `npm run
build` (the `tsc` gate) is green again.

**Priority:** medium — the SSH-terminal feature is broken in a fresh
build, and the broken `tsc` gate masks real type regressions. Does not
block the topology workstream (verified around it with `@xterm`
externalised).

## TD-2 — WS auth dependency bug: `OAuth2PasswordBearer` (HTTP-only) resolved on a WebSocket scope → 5xx

A WebSocket connection raises, server-side:

```
TypeError: OAuth2PasswordBearer.__call__() missing 1 required positional argument: 'request'
```

Traceback runs through `uvicorn/.../websockets_impl.py` → `fastapi/routing.py`
→ `solve_dependencies`, i.e. FastAPI is resolving a dependency that includes
`oauth2_scheme` (`OAuth2PasswordBearer`, defined in `backend/app/core/deps.py:18`,
used by `get_current_user` at `deps.py:38`/`:219`). `OAuth2PasswordBearer.__call__`
expects an HTTP `Request`; on a WebSocket scope there is none → `TypeError` → 5xx.

**Lead (found during T10 C6 smoke):** the WS routes in
`backend/app/api/v1/endpoints/ws.py` do **not** themselves declare this
dependency — they authenticate via a `token: Optional[str] = Query(...)`
param + `decode_access_token()` / `_authenticate_ws()` / `_resolve_ws_scope()`,
and the ws router is included **without** `dependencies=` (`router.py:25`). So the
`oauth2_scheme` is being pulled in because a WebSocket connection is reaching an
**HTTP route's** dependency chain — most likely a path/prefix mismatch between the
frontend WS URL and the mounted `/ws/...` routes (the upgrade falls through to an
HTTP handler that depends on `get_current_user`), rather than from any WS route
declaring it.

**Fix direction:** confirm the exact frontend WS URL vs the mounted WS paths
(prefix `/ws`); ensure WS connects hit a real `@router.websocket` route. If any
WS-reachable path resolves `get_current_user`/`oauth2_scheme`, swap it for the
WS-safe `token` Query + `decode_access_token` pattern already used in `ws.py`.

**Provenance:** pre-existing, NOT a T10 C6 regression — the C6 branch diff touches
no WS/auth files, and `ws.py` was last changed by a T9 commit (`6aa99d8`). The same
error reproduces on `main`.

**Priority:** medium — realtime streams (live events/anomalies/task-progress)
fail to connect; the app degrades to polling. No data-exposure risk (the socket
errors closed). Tackle as a small standalone fix after C6 merge.
