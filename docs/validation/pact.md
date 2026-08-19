# PACT — Property, Adversarial, Chaos, Contract

OpenSesame’s failure-scenario tests share one pattern so each plane does not
invent a one-off style. The four layers:

| Layer | Question | Typical assertion |
|-------|----------|-------------------|
| **P**roperty | Does the invariant hold for many inputs? | exclusive claim, capacity caps, KDF bounds |
| **A**dversarial | Does attacker-controlled input fail closed? | hop headers, path ids, SSRF, wildcard `postMessage` |
| **C**haos | Does a partition / publish failure drop durable work? | TaskBus down, append rollback, lease/claim |
| **T**ransport/contract | Do wire shapes match the published contract? | OpenAPI/Zod, status codes, no secret fields |

Rust helpers live in `opensesame_host_core::pact` (source-order oracles,
check-then-set mutant kill). TypeScript helpers live in `@opensesame/testing`
(`pact.ts`). Gateway webhook/backup tests are the reference call sites.

## Required failure scenarios

Every durable enqueue / quota / consent path must cover:

1. **Partition after durable write** — bus/publish fail must not drop the row.
2. **Append failure after claim** — claim rolls back (no poison idempotency key).
3. **Concurrent exclusive claim** — check-then-set mutant loses; one winner.
4. **Duplicate delivery / idempotent retry** — one side effect.
5. **Capacity / rate fence under interleaving** — increment-before-check or a lock.
6. **Authz fail-closed** — missing token, wrong org, malformed signature.

Do not add a suite that only documents the happy path.

## Coverage matrix

| Surface | Property | Adversarial / mutant | Chaos | Contract |
|---------|----------|----------------------|-------|----------|
| Identity claims / quota / MFA | `pact-chaos.test.ts` exclusive + quota + serializeKeyed | check-then-set; fence increment-before-verify | concurrent idempotency / org+claim quota | OpenAPI: every `security` path documents 401 |
| Identity audit chain | concurrent appends stay one chain (`packages/audit` `pact.test.ts`) | `timingSafeEqual` source-order | failed append does not advance the tip | no secret fields on chained events |
| Worker outbox drain | exclusive `claimUnpublished` | claim → publish → mark → release source-order | TaskBus partition keeps the row | CloudEvent has no secret fields |
| Database outbox | exclusive memory claim | Postgres `SKIP LOCKED` + `outboxClaimToken` source-order | release after failed mark; live SKIP LOCKED via PGlite (or `DATABASE_URL`) | claimed row has no secret fields |
| Host GitHub webhook | exclusive delivery claim | HMAC → claim → append → rollback | TaskBus partition; duplicate body | 401 malformed signature |
| Host backup / TaskBus | capacity/rate under lock | configurator before outbox; ping gated; session `pending_events` is 0 (no global depth leak) | wake despite bus down | TaskBus OpenAPI 401/403/422 |
| Host changelog | org-scoped list | event-type allowlist; no cross-tenant read | concurrent records from two orgs never mix | metadata-only rows |
| Host device / agents / rotation / sync | device capacity under lock (≤512); approve failure fence holds the lock across the guess | operator before complete locks; session before opaque JSON; store_path rejects `..` | device interleaving at cap; concurrent wrong codes ≤10 then 429; rotation job survives bus down; sync 401 | opaque sync blobs |
| Host NATS callout | unmapped principal denied across many subjects | ignores self-asserted `project_ids` | mapping partition → deny (not allow); missing token 401 | deny JSON has no shared secret |
| Callback-edge | HMAC verify_slice | path segments reject traversal | unconfigured secret is 503 not open | health `{status:ok}`; 401 bad MAC |
| Daemon | hop-header strip | path-id allowlist; proxy rejects `..` | upstream partition → 502 `upstream_unreachable` | opaque `/health` |
| Pages vault / queue / auth.js | non-extractable VK; PIN ≥8 | postMessage origin pin; iss then aud | claim tokens never hit OPFS | TaskBus GET schema rejects secrets |
| MCP host | no secret tool names (`src/pact.test.ts`) | `toolError` → `forAgent`; Host audience pin | Host fetch throw → `host_unavailable` | credential-shaped payloads refused |
| Client CLI | session file 0600 via temp+rename | `emit` redacts before print | partitioned refresh leaves the file | `token_type` kept; tokens redacted |
| Browser extension | loopback `hostApiBase` only | remote rewrite refused | health error does not persist an unnormalized host | popup saves only after `normalizeLoopbackBaseUrl` |
| Contracts package | claim types round-trip | Zod rejects http NATS URLs + extra secrets | extra TaskBus credential fields rejected | `pact-contract.test.ts` |
| OAuth provider | pairwise `getOrCreate` stable in-process | production refuses MemoryAdapter + MemoryPairwiseSubjectStore | concurrent getOrCreate keeps one `sub` | JWKS / adapter / pairwise source-order |
| Policy | `claim.create` denied at provisional cap | check-then-set mutant admits double claim | concurrent evaluators at the cap all deny | quota reasons include `quota_claims` |
| Browser SDK | `completeClaim` encodes id then sends `claimToken` | claim id is path-encoded (`encodeURIComponent`) | complete without session never hits the network | `x-claim-token` header |
| MCP client | no secret tool names | materialize aliases refused | Host/Issuer URL pin before tools | `toolsManifest` |
| Resource-server SDK | required claims include `exp` | default algs are asymmetric (`HS*`/`none` absent) | discovery partition still rejects the token | `jwtVerify` after claim list |
| Workload worker | operator compare is length-hiding | empty token → 503; wrong token → 401 | probe task join fail → 503 | `/health/ready` and `/v1/providers` gated |
| Claims engine | exclusive `completeClaim` CAS | completed session JSON has no raw token | 8-way complete: one `won` | token stays off the session record |
| Device-auth projection | slow_down interval caps at 60s | projection has no secret fields | 20 slow_downs stay at 60s | no `user_code` / `device_code` in UI JSON |
| Observability | `token_type` kept; depth ceiling before recurse | nested `access_token` / `pin` redacted | cyclic objects terminate | `[Redacted]` not plaintext |
| QR | empty payload refused | `assertPayload` before encode | concurrent encodes of one payload are identical | `QrEncodeError` |
| Client-core | `sealDevOnly` gated by `isDevOrTestEnv` | no `getSecret(` | production NODE_ENV never XORs | blobs are ciphertext-only |
| CLI device SDK | `expires_in >= 0` is real expiry | printed instructions omit `device_code` | `expires_in: 0` does not spin | interval floor 5, cap 60 |
| Auth-upstream | `principalId` stable on upgrade | no email auto-link | concurrent upgrades to one upstream keep a single mapping | unknown principal throws |
| os-domain | terminal claims stay terminal | malformed claim tokens parse as null | concurrent complete does not mutate the original session | fixtures have no secret fields |
| agent-protocols | concurrent renders are deterministic | secret-shaped config refused | poisoned field yields no partial doc | `assertSafeConfig` before interpolate |
| telemetry | allowlisted events only | forbidden values dropped not redacted | concurrent secret tracks never leak | sanitize before capture |
| identity-atproto / nostr | DID/pubkey format required | garbage DID/pubkey refused while disabled | concurrent verify never succeeds | factory disabled unless flag is exactly `true` |
| Pages PWA / console / mobile-mfa | loopback operator pin; b64url round-trip | remote operator headers empty; empty QR refused | claim stash stays in sessionStorage; QR encode stable | no `getSecret`; stash JSON only |
| mock-upstream-idp | loopback listen | PKCE required | authorization code is single-use | `codes.delete` before PKCE verify |
| example RPs / agent / headless | pairwise `sub` differs by sector | claimToken / `device_code` never printed | poll/device partition fails closed | mock `DO_NOT_PRINT` device_code |
| redteam / visual-contract | corpus covers four classes; identical PNGs match | 404 mock has no secrets; dimension mismatch fails; live mcp-host confused-deputy / credential / malformed / injection-as-data | unmatched routes stay 404; inverted PNG exceeds budget | no `getSecret` tool; Playwright `test` vs `.impeccable/screenshots`; `VISUAL_UPDATE` opt-in |
| fuzz oracles / env-spec / config | terminal claims; `@sensitive` values null; strict tsconfig | secret fields redacted; missing schema exits 2 | concurrent parse stays secret-free | JSON parser id; package exports tsconfig only |
| grants / static-mesh / toolbar / credential-agent | attenuation increments depth; advertise/resolve stable | expanded actions refused; path ids refused; remote daemon URL refused | cross-org child refused; unknown service empty; missing operator 401 | grant/mesh JSON has no secret fields; mint returns null secrets |
| TaskBus NATS URL | nats/tls accepted | http and embedded userinfo refused | system types stay on `opensesame.events.system` | `validate_nats_url` before `async_nats::connect` |
| Sealed-store paths | nested logical names round-trip | `..` / NUL / absolute refused | interleaved rejects stay closed | `.osseal`/`.age` strip to logical names |
| Human-vault envelopes | KDF band accepts what wrap writes | hostile Argon params fail closed | bad nonces error, never panic | envelopes are ciphertext-only |
| Host redaction | `token_type` kept across shapes | substring `token` does not redact `token_type` | concurrent redact never leaks values | redacted JSON has no secret values |
| Connection env sync | vercel/railway only | doppler/infisical/craft-bar ids refused | interleaved checks stay fail-closed | https host pin before `send()` |
| eve-deepsec (out of workspace) | GLM 5.2 pinned to blackbox | `deepsec process/sandbox` refused before spawn | missing install fails closed | README keeps the app out of `pnpm-workspace.yaml` |

Reference call sites: `apps/gateway/src/github_webhook.rs`,
`apps/gateway/src/main.rs` (`pact_coverage`),
`apps/control-plane/src/__tests__/pact-chaos.test.ts`,
`apps/worker/src/__tests__/pact.test.ts`,
`apps/callback-edge/src/main.rs`,
`apps/daemon/src/main.rs`,
`apps/pages/src/lib/pact.test.ts`,
`packages/audit/src/__tests__/pact.test.ts`,
`packages/contracts/src/__tests__/pact-contract.test.ts`,
`packages/api-client/src/index.test.ts` (extension loopback pin),
`packages/oauth-provider/src/__tests__/pact.test.ts`,
`packages/policy/src/__tests__/pact.test.ts`,
`packages/sdk-browser/src/pact.test.ts`,
`packages/sdk-server/src/pact.test.ts`,
`apps/mcp-client/src/pact.test.ts`,
`apps/browser-extension/tests/pact.test.mjs`,
`packages/os-domain/src/__tests__/pact.test.ts`,
`packages/agent-protocols/src/pact.test.ts`,
`packages/telemetry/src/__tests__/pact.test.ts`,
`packages/identity-atproto/src/__tests__/pact.test.ts`,
`packages/redteam/src/pact.test.ts`,
`packages/redteam/src/structural.pact.test.ts`,
`packages/visual-contract/src/compare.pact.test.ts`,
`packages/visual-contract/tests/vault-visual-contract.spec.ts`,
`apps/mcp-host/src/pact.test.ts`.
