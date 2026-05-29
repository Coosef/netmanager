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

## TD-2 — WS auth dependency bug: `OAuth2PasswordBearer` (HTTP-only) resolved on a WebSocket scope → 5xx — ✅ RESOLVED (branch `t10/td2-ws-auth-fix`)

A WebSocket connection raised, server-side:

```
TypeError: OAuth2PasswordBearer.__call__() missing 1 required positional argument: 'request'
```

**Confirmed root cause (≠ original lead):** it was **not** a frontend path/prefix
mismatch. `backend/app/api/v1/router.py` included the **agents** router with a
router-level user-auth feature gate:

```python
api_router.include_router(agents.router, prefix="/agents", dependencies=_feat("agents"))
```

`_feat("agents")` = `[Depends(require_feature("agents"))]`, and `require_feature`'s
checker depends on `get_current_active_user` → `get_current_user` → `oauth2_scheme`
(`OAuth2PasswordBearer`, `deps.py:18`). A **router-level dependency applies to every
route in that router — including the WebSocket route** `@router.websocket("/ws/{agent_id}")`
(agents.py). So an agent connecting to `/api/v1/agents/ws/{agent_id}` made FastAPI
resolve `oauth2_scheme` on a **WebSocket** scope, where `__call__(request=...)` has no
`Request` → `TypeError` → 5xx, handshake dropped. The agent WS authenticates by
`key` (agent_key) Query param, not a user session, so the user-auth gate was both
broken AND semantically wrong there. The `ws.py` routes (included at `/ws` **without**
`dependencies=`) were never affected.

**Fix:** the agent WebSocket route now lives on a separate `agent_ws_router`
(agents.py) included **without** `_feat(...)` (router.py), preserving the path
`/api/v1/agents/ws/{agent_id}` and its existing `key` Query-token auth. No HTTP
user-auth dependency reaches any WS endpoint. The HTTP agents routes keep the
feature gate + auth.

**Verification:**
- Reproduced pre-fix: agent WS handshake → HTTP **500** + `OAuth2PasswordBearer`
  traceback; post-fix → controlled handshake rejection (no 5xx, **0 tracebacks**).
- Valid-token `/ws/events` connect → **101 accept** (realtime stream intact).
- Regression tests: `backend/tests/test_td2_ws_auth.py` (6 tests) — agent WS &
  ws.py routes carry **no** user-auth dependency; HTTP agents route **does**;
  no/invalid-token `/ws/events` → controlled 4001 close; `GET /agents/` → 401.
- Full backend suite green (709 passed).

**Provenance:** pre-existing, NOT a T10 C6 regression — the gate was added in T10
Faz A1; reproduced on `main`.
