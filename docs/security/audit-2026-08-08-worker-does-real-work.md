# Audit 2026-08-08 — the cleanup worker did nothing, quietly

Date: 2026-08-08
Scanners: cve-lite, osv-scanner, gitleaks, semgrep, ast-grep, clippy, cargo-deny —
all clean. This came from following up an open item in
`audit-2026-08-08-issuer-persistence-and-worker.md` and reading
`apps/worker/src/main.ts` again.

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| Medium | The standalone worker called `createRepositories()` with no arguments. That falls back to `DATABASE_URL`, and when it is unset returns **in-memory** repositories. For the control plane that is a usable dev mode, because the process writing the outbox is the one reading it. A separate worker process reading its own empty map does nothing at all, forever, while logging healthy ticks. | The worker requires `DATABASE_URL` and exits rather than impersonating a working one. |
| Medium | `oidc_payloads` rows past their TTL were refused on read but only removed by `pruneExpired`, which nothing called. Sessions, authorization codes, refresh tokens, device flows and grants accumulated with no bound — a table that only grows, holding authorization state long after it stopped meaning anything. | The cleanup tick prunes them every interval; the worker constructs the store to do it. |

The first one is the same shape as the finding the previous tick fixed. That tick
stopped the worker from *claiming* expiry it could not perform; it left the worker
still unable to perform the one job it did claim.

## How pruning is wired

`CleanupDeps.oidcStore` takes just `Pick<OidcStore, "pruneExpired">`, so a tick
needs nothing else from the store and tests can pass a two-line stub. The prune is
best-effort and wrapped: a store that throws logs and the tick continues to publish
the outbox, because reads already refuse an expired row. A failed prune is a table
that stays large, not a token honoured late. `prunedOidcRows` is absent rather than
zero when there is no store, so "nothing to prune" and "no store to prune from" do
not read the same in the logs.

The prune uses the tick's clock, not wall time, which the test asserts — a fake
clock that does not reach the store would be testing a different TTL.

## Not fixed here

- Rows the provider stores with no TTL are its long-lived models and are left alone.
  Nothing yet reaps a grant that was never revoked and never expires.
- The control plane does not run this loop; claims expire lazily on read there.
  A deployment that runs no worker still never prunes.
- Provisional sessions and temporary projects still have no repository, so their
  expiry remains confined to the process holding the maps.

## Verification

- `apps/worker` — 5 passed (1 new, covering the pruned count, the tick's clock
  reaching the store, a throwing store not costing the outbox, and an absent store
  differing from an empty prune)
- Confirmed by running it: with `DATABASE_URL` unset the worker logs the reason and
  exits instead of looping
- `pnpm -r typecheck`, `packages/database` tests, biome — green
- cve-lite, osv-scanner, gitleaks, semgrep, ast-grep, clippy, cargo-deny — clean
