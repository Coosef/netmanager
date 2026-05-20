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
