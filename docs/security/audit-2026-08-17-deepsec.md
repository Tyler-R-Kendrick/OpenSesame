# Audit — 2026-08-17 — deepsec install + scan + AI process

## What we did

1. Installed [vercel-labs/deepsec](https://github.com/vercel-labs/deepsec) into
   `.deepsec/` (`deepsec@2.3.5`), linked a dedicated Vercel project for AI
   Gateway OIDC, and wrote OpenSesame-specific `INFO.md` +
   `deepsec.config.ts` (priority paths for Host/Identity/auth crates).
2. Ran the free pattern scan: **503 matcher hits across 200 files**.
3. After AI Gateway credits were available, ran AI `process` with
   **`zai/glm-5.2` / Pi / medium thinking** over **all 200 tracked files**.
   Deepsec defaults now use that model.

Earlier AI-route blockers (Claude local proxy, Codex `approval_policy=Never`,
free-tier Gateway 403/429) are documented in git history of this file; they
no longer apply to the completed process pass.

## Pattern scan headline

| Matcher | Hits |
|--------|-----:|
| insecure-crypto | 114 |
| rs-axum-route | 69 |
| secret-in-log | 51 |
| process-env-access | 43 |
| ssrf | 40 |
| crypto-usage | 40 |
| auth-bypass | 24 |
| mcp-tool-handler | 15 |
| xss | 14 |
| open-redirect | 10 |

## AI process headline (2026-08-18)

All 200 files analyzed. **110 open findings** exported to
`.deepsec/findings/` and `.deepsec/data/opensesame/reports/`.

| Severity | Count |
|----------|------:|
| CRITICAL | 0 |
| HIGH | 1 |
| MEDIUM | 64 |
| HIGH_BUG | 4 |
| BUG | 41 |

Gateway cost across process runs (reported by deepsec): roughly **$20.2**
and **~6.5M tokens** (`$0.21 + $2.87 + $4.75 + $3.20 + $0.15 + $4.34 + $3.23 + $1.45`).

### HIGH (1)

- **SSRF without DNS pinning** — `packages/oauth-provider/src/metadata/safe-fetcher.ts`
  (`assertSafeMetadataUrl` checks hostname literals / IP strings only; CIMD
  fetch can still hit private/metadata IPs via DNS). CIMD is off by default
  and the fetcher is not wired into oidc-provider yet.

### HIGH_BUG (4)

- Webhook claim-then-append: event lost if `append_outbox` fails after
  `try_claim_host_kv` (`apps/gateway/src/github_webhook.rs`)
- Lock-order inversion / deadlock in agent-claim (`apps/gateway/src/routes/agents.rs`)
- In-memory pairwise subject store in production
  (`packages/oauth-provider/src/pairwise/store.ts`)
- `completeClaim` drops `ClaimDecision.claimToken`
  (`packages/sdk-browser/src/client.ts`)

## Remediation (2026-08-18)

AI findings were revalidated and patched in-tree. HIGH and HIGH_BUG items
are closed. MEDIUM/BUG items that were real were patched rather than deferred.

### HIGH

- `SafeMetadataFetcher` now DNS-resolves every address (`lookup({ all: true })`),
  refuses if any is private/special, pins the GET to a verified IP with SNI/Host
  of the original name, refuses redirects, caps the body at 64KiB, and requires
  `application/json`.

### HIGH_BUG

- GitHub webhooks claim the HMAC-verified **body digest**, roll back the claim
  if `append_outbox` fails, and reject a malformed signature before DB lookup.
- Agent-claim locks are always `claims` then `claim_user_code_attempts`; poll
  and complete honour `expires_at`; `narrowed_actions` is persisted.
- Production `createOpenSesameProvider` refuses an in-memory pairwise store;
  control-plane wires `createPostgresPairwiseStore` next to the OIDC adapter.
- Browser `completeClaim` sends `claimToken` (body + `x-claim-token`) and
  path-encodes `claimId`. Identity verifies the token when present.

### MEDIUM (selected)

- Correlation ids allowlisted; claim store TTL/capacity prune; claim complete
  ownership on project/agent activation; device-approve `redirect: "error"`
  and generic Host errors; MFA fence increments before verify; mapping-resolve
  uses SHA-256 then `timingSafeEqual`; provisional revoke requires origin for
  cookie; changelog requires `can_configure_integrations` and stamps actor/org
  from the caller; NATS callout ignores self-asserted `project_ids` and strips
  system subjects in release; rotation jobs are org-scoped; TaskBus URLs redact
  userinfo; sync-blob auth before work + body limits; IPv4-mapped IPv6 SSRF in
  SDK CLI/server; production CORS refuses the unset-env dev allowlist;
  callback-edge webhooks require HMAC; health authority/degraded are opaque.
- Daemon proxy: shared HTTP client, hop/`X-Forwarded-*` stripped, `claim_id`
  path-id allowlist, unauthenticated `/health` is `{status,service,tailscale_url}`
  only, request **and** response bodies capped at 2MiB.
- Pages vault: non-extractable CryptoKey, PIN length ≥8 + 1.2M PBKDF2, prefix
  filters, `auth.js` origin-bound authorize links.
- Worker `/health/ready` and `/v1/providers` require operator/worker token;
  probe results cached 10s; outbox drain claims unpublished rows
  (`claim:<deadline>` + `FOR UPDATE SKIP LOCKED`) so two workers cannot double
  publish; process-local drain lock serializes ticks.
- Control-plane: per-principal mutation serialization for quota, idempotency
  inflight lock, claim.create quota, MFA anonymous fingerprint fence + map cap,
  audit chain `timingSafeEqual`.
- Gateway: device authorize capacity under one lock, backup resync rate, sync
  blob caps, changelog per-org ring, TaskBus partition does not drop outbox.
- Packages: `cloneClaim` deep-clones nested decision objects; OIDC memory
  adapter purges secondary indexes on expiry; CLI `emit()` redacts JSON on
  both human and `--json` paths and refreshes expired access tokens; MCP host
  `toolError` uses `forAgent` and Host audience pin; mobile-mfa masks the
  session token; credential-agent recovers poisoned mutexes and binds mint to
  `session_id`; in-memory task store caps at 512 and prunes expired runs.

### PACT coverage

Failure-scenario tests follow [docs/validation/pact.md](../validation/pact.md)
(Property / Adversarial / Chaos / conTract). Shared helpers live in
`opensesame_host_core::pact` and `@opensesame/testing` (`pact.ts`).

Covered scenarios: exclusive claim vs check-then-set mutant; webhook/backup
TaskBus partition (durable outbox / actor notify survive); claim-before-append
rollback; concurrent org/claim quota and idempotency; MFA/anon rate fence;
outbox exclusive claim + drain partition; OpenAPI 401 on every secured Identity
path; Host device capacity under interleaving; rotation job survives bus down;
sync blobs fail closed without a session; callback-edge HMAC + path fence;
Pages non-extractable vault key / PIN floor / claim tokens off disk; MCP
`forAgent` + Host audience pin; CLI emit redaction. See
[docs/validation/pact.md](../validation/pact.md) for the coverage matrix.

Scanner hygiene (over-redaction of a field named `code`, pattern-scan SSRF on
build-time Vite URLs) is not a vulnerability and is not tracked as deferred
work.



## How to resume / revalidate

```bash
cd .deepsec
vercel env pull .env.local --environment=development --yes
pnpm deepsec revalidate --project-id opensesame
pnpm deepsec export --project-id opensesame --format md-dir --out ./findings
pnpm deepsec report --project-id opensesame
```

Everyday pattern scan (no AI):

```bash
pnpm audit:deepsec
```

## eve agent (Blackbox GLM, no `deepsec process`)

`apps/eve-deepsec` is a standalone eve app: model `zai/glm-5.2` with
`providerOptions.gateway.only: ["blackbox"]`. It runs the pattern scanner and
triages hits itself. It refuses `deepsec process` (that was the paid Pi path).

```bash
cd apps/eve-deepsec && pnpm install --ignore-workspace
pnpm eve:deepsec
```

Requires Node 24+ and Gateway auth. Promo is eve+Blackbox through 2026-08-27;
`glm-5.2-fast` is excluded.

Optional AI process (already complete; reruns skip analyzed files unless
`--reinvestigate`):

```bash
DEEPSEC_PROCESS=1 pnpm audit:deepsec
```

## Repo wiring

- `.deepsec/` workspace (config + INFO committed-friendly; secrets gitignored)
- `apps/eve-deepsec/` — eve + Blackbox GLM triage (`pnpm eve:deepsec`)
- `scripts/deepsec-gate.sh` + `pnpm audit:deepsec`
- Tooling evaluation: pattern gate in “use now”; AI process uses Gateway + `zai/glm-5.2`
