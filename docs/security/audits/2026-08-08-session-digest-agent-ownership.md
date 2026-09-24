# Audit tick 40 — session bearers at rest, agent claim ownership

Scanners (cargo-audit, ast-grep, osv-scanner, cve-lite) were clean on `main`
(79ff390). Both findings come from reading the Host API session middleware and
the Identity plane agent routes.

## 1. Host API session bearers were stored in cleartext

`opaque-session:<id>` *is* the bearer, and the id was the key of
`AppState.sessions` — with the same cleartext value repeated inside the stored
metadata (`session_id`). Worse, `require_session` handed that cleartext id back
to callers, and `sync.rs` persisted it as the value of `blob_owners`, so a live
credential sat in two maps. Device codes and claim tokens have been digest-only
since ticks 25/27; sessions had been missed.

Fix:

- Sessions are keyed by `hash_secret(session_id)`.
- The stored metadata copy carries the digest in `session_id`; the response to
  the device-token client is unchanged, so `opensesame login` and the CLI's
  `session.json` fallback still work.
- `require_session` returns the digest, which is what sync-blob ownership
  compares — ownership semantics are identical, minus the cleartext.

Regression test `session_bearer_is_never_retained` asserts the bearer is neither
a key nor present in the serialised stored metadata.

## 2. Any principal could start a claim over another principal's agent

`POST /v1/agents/:id/claim` only checked that the agent existed. The claim it
creates carries `targetManifest.ownerPrincipalId = <caller>`, and completing an
agent claim flips the agent to `claimed` — so a foreign caller could run a
takeover ceremony for someone else's agent, and could enumerate agent ids by
status code.

`Agent` now records `ownerPrincipalId` (set at registration), and the claim route
answers 404 for anything the caller does not own. Schema: `agents.owner_principal_id`
with an FK to `principals` and an index (migration `0002_curvy_norman_osborn.sql`).

Test: `fences agent claim ceremonies to the registering principal` — intruder
gets 404, owner gets 201.
