# Audit tick 34 — OAuth provider minted tokens for any audience and any key

Date: 2026-08-08
Scope: `packages/oauth-provider`

## Scanners

| Check | Result |
|-------|--------|
| cve-lite (overrides) | CLEAN (1 PD002 monorepo false positive) |
| semgrep (ERROR+) | CLEAN |
| ast-grep | CLEAN |
| `scripts/task-security-battle-test.sh` | OK |
| `scripts/battle-test.sh` | ALL PASSED |
| Residual review | provider config accepted any resource indicator; production silently ran on ephemeral keys + memory state |

## Findings fixed

### 1. Any client could get a JWT audienced to any resource server (high)

`resourceIndicators.getResourceServerInfo` echoed whatever `resource` the client
asked for straight back as the token `audience`, with `accessTokenFormat: "jwt"`:

```ts
getResourceServerInfo: async (_ctx, resourceIndicator) => ({
  scope: "openid",
  audience: resourceIndicator,   // ← attacker-chosen
  accessTokenFormat: "jwt",
})
```

So any admitted client could obtain a signed JWT with `aud` set to an arbitrary
resource server — the exact audience confusion RFC 8707 resource indicators exist
to prevent, and a laundering path into any RS that trusts this issuer. Note that
`OAuthClientRecord.allowedResources` already existed in the type model; the
runtime simply never consulted any allowlist.

Fix: `canonicalResource` normalizes indicators (absolute `http(s)` URI, no
query/fragment, lower-cased scheme + host, no trailing slash) and
`isResourceAllowed` checks them against `OPENSESAME_ALLOWED_RESOURCES`. With no
allowlist configured the only acceptable audience is the issuer itself — never
"whatever was requested". Rejections raise `errors.InvalidTarget`
(`invalid_target`). Look-alike hosts and deeper paths under an allowed prefix are
rejected, since matching is on the whole canonical form.

### 2. Production silently ran on an ephemeral keypair and in-memory grants (high)

`buildJwks()` generated a fresh RSA key **per process** whenever no `jwks` was
passed, and the adapter defaulted to `MemoryAdapter`. `apps/control-plane`
passes neither, so a production deployment would: sign tokens with keys no other
replica can verify, invalidate every token on restart, and keep grants/sessions
per-process — meaning revocation and device-code state do not hold across
instances.

Fix: `createOpenSesameProvider` now resolves keys as `jwks` option →
`OPENSESAME_JWKS_JSON` → dev keypair, and throws in production if it would reach
the dev keypair or the memory adapter. Malformed `OPENSESAME_JWKS_JSON` is
rejected rather than ignored. The production seam already exists
(`createPostgresAdapterConstructor`); it now has to be wired instead of being
silently skipped.

## Follow-up

~~`apps/control-plane/src/create-app.ts` still constructs the provider without a
`jwks` or adapter~~ — closed in `audit-2026-08-08-issuer-persistence-and-worker.md`:
`createPostgresOidcStore` backs the adapter and the control plane wires it whenever
a database is configured. Signing keys already came from `OPENSESAME_JWKS_JSON`
with production refusing an ephemeral keypair.

## Also fixed — `pnpm run test:all` was red

`packages/cli` still called `pollClaim(claimId)` with one argument after tick 25
made the claim token mandatory, so the workspace `typecheck` (and therefore
`test:all`) had been failing. `claim poll` now takes `--token osc_clm_…` or
`OPENSESAME_CLAIM_TOKEN` and refuses to run without it, matching the API.

## Verification

- `pnpm --filter @opensesame/oauth-provider test` — 18 tests, incl. new
  canonicalization, allowlist and fail-closed cases.
- `pnpm --filter @opensesame/oauth-provider typecheck` / `build`.
- `pnpm --filter @opensesame/control-plane test` — unchanged (dev path).
- `errors.InvalidTarget` confirmed present in the installed `oidc-provider`.
