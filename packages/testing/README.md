# @opensesame/testing

Shared test utilities for the TypeScript workspace: sentinel secret values
that must never appear in logs, traces or audit metadata, and the PACT
(Property / Adversarial / Chaos / conTract) helpers the other packages' suites
are written with. It is a dev dependency only; no production code imports it.

## Where it fits

- **Used by:** the test suites of most apps and packages — among them [`packages/control-plane`](../../packages/control-plane), [`packages/mcp-host`](../../packages/mcp-host), [`packages/mcp-client`](../../packages/mcp-client), [`packages/app-core`](../app-core), [`packages/policy`](../policy), [`packages/sdk-browser`](../sdk-browser), [`tests/redteam`](../../tests/redteam) and [`tests/fuzz/jazzer`](../../tests/fuzz/jazzer).
- **Builds on:** [`@opensesame/os-domain`](../os-domain) (types only).
- Diagnostic logs are separate from the audit trail; the sentinel scan is how a test proves a secret reached neither ([ADR 0015](../../docs/adr/0015-audit-vs-diagnostic-logging.md)).

## Surface

| Export | What it checks |
|---|---|
| `sentinelValues`, `assertNoSentinels(haystack)` | Throws if any `*_TESTSECRET` sentinel (claim secret, device code, refresh token, authorization code) appears in a string |
| `countConcurrentWins`, `assertExclusiveClaim`, `assertAtMostWins` | Property: run a worker 32 times concurrently; exactly one, or at most N, may succeed |
| `checkThenSetAdmitsDoubleClaim` | The naked read-then-write mutant, kept to show why production must not use it |
| `assertSourceOrder(src, markers)` | Mutation oracle: markers appear in order in the production part of a source file (before `#[cfg(test)]` or the first `describe(`) |
| `assertNoSecretFields(value, allow)` | Contract: a JSON body carries no `access_token`, `refresh_token`, `client_secret`, `webhook_secret`, `private_key`, `claim_token` / `claimToken` |
| `assertFailClosedStatuses(responses, required)` | Contract: an OpenAPI responses object documents the fail-closed statuses (default `401`) |
| `assertDurableSurvivesPartition(count, publish)` | Chaos: durable work is still present after a failed publish |

## Develop

```bash
pnpm --filter @opensesame/testing test
pnpm --filter @opensesame/testing test:security   # src/security.test.ts only
pnpm --filter @opensesame/testing typecheck
pnpm test:security                                # the same, from the root
```

The package's own suite also holds one repository check that is not about
these helpers: `fuzz-toolchain.test.ts` (nightly-pinned `cargo fuzz` in the
fuzz scripts).

## Related

- [PACT](../../docs/validation/pact.md) — the validation method these helpers implement
- [ADR 0015](../../docs/adr/0015-audit-vs-diagnostic-logging.md) — audit vs diagnostic logging
