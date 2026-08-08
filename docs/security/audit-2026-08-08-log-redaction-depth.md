# Audit tick 32 — structured log redaction only reached one level deep

Date: 2026-08-08
Scope: `packages/observability`

## Finding (medium — credential disclosure in diagnostics)

`createLogger` relied entirely on pino's `redact.paths`. Pino's `*` wildcard
matches exactly one level, so the configured `*.access_token` / `*.token`
entries covered `{ outer: { token } }` but **not** anything deeper. Reproduced
before the fix:

```
log.info({ ctx: { session: { access_token: "LEAKED-DEEP" } }, outer: { token: "x" } });
=> {"ctx":{"session":{"access_token":"LEAKED-DEEP"}},"outer":{"token":"[Redacted]"}}
```

Nested request/session context is exactly how bearer tokens, claim tokens,
device/user codes and sync ciphertext travel through this codebase, so a single
`log.info({ ctx })` in the control plane or worker could write live credentials
to disk or a log shipper. Audit events were unaffected (`packages/audit` uses a
key allowlist), this was diagnostic logging only — the split ADR 0015 draws.

## Fix

- Added `SENSITIVE_KEY_PATTERN` (tokens, codes, secrets, passwords, private
  keys, DPoP proofs, ciphertext) and `redactDeep`, a depth-limited, cycle-safe,
  array-aware walk that censors matching keys at **any** depth.
- Wired `redactDeep` in as pino's `formatters.log` so every merged log object
  passes through it; `redact.paths` is kept for `req`/`res` header paths.
- Depth ceiling of 12 and a `WeakSet` cycle guard keep a hostile or self
  referential object from stalling the logger; non-plain objects (Error, Date,
  Buffer) are left to pino's serializers.

## Also fixed this tick — `pnpm run build` was red on `main`

`apps/console`, `apps/pwa`, `apps/mobile-mfa`, `apps/example-rp-alpha` and
`apps/example-rp-beta` had no `build.target`, so Vite used its legacy default
set and esbuild 0.28 aborted on ordinary `const [a, b] = useState()` forms.
All five now carry the same modern target `apps/pages` already documented
(`es2022`/`chrome100`/`firefox100`/`safari15`). Workspace build: 14/14 green.

## Verification

- `pnpm --filter @opensesame/observability test` — deep nesting, arrays and
  cycles covered by new cases.
- `pnpm --filter @opensesame/control-plane test`, `--filter @opensesame/worker
  test`, `--filter @opensesame/audit test` — consumers unchanged.
- Scanner rotation (ast-grep, semgrep, osv-scanner) clean this tick.
