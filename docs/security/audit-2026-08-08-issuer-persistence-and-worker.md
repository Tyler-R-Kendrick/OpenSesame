# Audit 2026-08-08 — issuer persistence, and a worker that admitted what it does

Two long-standing follow-ups: the OIDC provider ran on the in-memory adapter in
every deployment, and the standalone cleanup worker reported healthy ticks while
expiring nothing.

## 1. The issuer kept its own models in memory (tick 34)

`createOpenSesameProvider` has taken an adapter since it was written, and
`createPostgresAdapterConstructor` has been waiting for a store. Nothing
implemented one, so the control plane ran the provider on `MemoryAdapter` whatever
`DATABASE_URL` said. In that shape every restart invalidates live sessions and
refresh tokens, and a consumed authorization code stops being remembered as
consumed — the record it would be recognised by is gone with the process.

`createPostgresOidcStore` (in `packages/database`) backs the adapter with an
`oidc_payloads` table (migration `0004_oidc_payloads.sql`), and `createControlPlane`
wires it whenever a database is configured. Two rules are worth naming:

- An expired row is never returned. A token that outlived its TTL must not be
  honoured because a cleanup job has not run yet.
- `consume` stamps the row instead of deleting it. The provider decides what a
  replayed authorization code means, and it has to see a consumed code rather than
  a missing one to say "already redeemed" instead of "never existed".

Signing keys already resolve from `jwks` or `OPENSESAME_JWKS_JSON`, and
`createOpenSesameProvider` refuses an ephemeral per-process keypair in production,
so there was nothing left to wire there — the follow-up's other half was already
closed.

## 2. The standalone worker enforced nothing and said nothing (tick 53)

Claims, provisional sessions and temporary projects live in the control plane's
process. The standalone worker was handed empty maps for all three, so it logged a
successful tick every interval while inspecting nothing. That is worse than not
running it: an operator watching healthy ticks concludes TTLs are being enforced.

Those dependencies are now optional, a tick reports `expiryEnforced`, and the
standalone entrypoint logs at start that it publishes the outbox and that expiry
runs in-process in the control plane. Sharing the state properly still means
moving provisional sessions and projects behind repositories, which is the design
change this note has been deferring — but it no longer claims to have happened.

## Not fixed here

- Provisional sessions and temporary projects still have no repository, so their
  expiry is only enforced where the maps live.
- `oidc_payloads` rows past their TTL are refused on read but only removed by
  `pruneExpired`, which nothing calls on a schedule yet.

## Verification

- `packages/database`: 4 new tests (lookup-key extraction, TTL refusal, consumed
  stamp, no mutation of the stored payload) — 9 total
- `apps/worker`: 1 new test (a tick with no state says so) — 4 total
- `pnpm -r typecheck`, full workspace tests green
