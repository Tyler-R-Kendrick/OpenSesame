# ADR 0049 — Derived short-lived materialization

Status: Accepted
Date: 2026-08-19
Amends: ADR 0005 (Level 3 materialization), ADR 0032 §6 (credential
material boundary); supplements ADR 0044 (delegation receipts)

## Context

ADR 0005 denies Level 3 materialization — an agent never receives
credential bytes — and ADR 0032 §6 enforces it: no endpoint returns an
access token, a refresh token, or a client secret. ADR 0048 decision 6
confronts that invariant with reality: git credential helpers, docker
credential helpers, AWS `credential_process`, and kubectl exec plugins
are protocols whose *only* output is usable secret material on stdout.
A developer who wants `git push` to work through OpenSesame either gets
bytes from us or keeps the token in a plaintext file — the floor ADR
0048 exists to raise.

The resolution is a distinction ADR 0032 already gestures at but never
names. Its §6 reads "credential material never crosses the API
boundary," and the credential it means is the **sealed stored
credential** — the long-lived thing a human pasted or authorized. A
provider-natively minted, short-lived, revocable derived token is a
different artifact: it is issued *by the provider* for a narrower
purpose, it expires on the provider's clock, it is revocable
independently of the stored credential, and it has its own audit trail
at the provider and at the gateway. GitHub App installation tokens
(≤ 1 h, repo + permission subset, already minted by
`crates/connection-broker/src/installation.rs` for ADR 0039 backup)
are the existence proof. Handing an agent a derived token is not
materializing the stored credential; it is delegating authority in the
provider's own currency.

## Decision

1. **"Credential material" in ADR 0032 §6 means the sealed stored
   credential.** This ADR amends 0005/0032 narrowly: a provider-natively
   minted, short-lived, revocable derived token is a new artifact class
   and may cross the boundary under the fences below. Materialization of
   a stored credential stays denied with no exception.
2. **A per-connection policy gates it:**
   `materialization: deny | derived_short_lived`, default `deny`. No
   connection participates unless its owner opted that connection in.
3. **One endpoint: `POST /api/v1/connections/{id}/mint`.** It is
   ownership-fenced exactly as ADR 0032 §2 (owner or operator, like
   refresh and revoke) and policy-gated by decision 2. Provider mapping:
   github → GitHub App installation tokens via the existing
   `installation.rs` path, scoped to a repo + permission subset and
   ≤ 1 h; aws → STS `GetSessionToken`/`AssumeRole`. **A provider with
   no native mint path answers `422 UNMINTABLE`** and is never offered
   helper mode — there is no fallback that decrypts the stored
   credential to satisfy a helper.
4. **Helper binaries are thin clients of the mint path.**
   `git-credential-opensesame`, `docker-credential-opensesame`,
   `opensesame-credential-process`, and `opensesame-kube-exec` are
   minimal UDS clients to the daemon, which forwards to the gateway
   mint endpoint. They carry no crypto, no storage, and no credential
   handling of their own. They operate in mint mode only; a connection
   without a mint path fails the helper at request time, typed and
   audited.
5. **Receipts record the RFC 8693 mapping.** Every mint and every
   helper-mediated use records subject = owning principal, actor =
   requesting agent, in the receipt shape ADR 0044 already defines for
   delegated invocations (`delegation_chain` populated). The mapping is
   semantic, not a wire protocol — but because it is recorded in 8693's
   own terms, future OAuth identity-chaining or GNAP interop is a
   mapper, not a rewrite.
6. **This is the only exception, and it is opt-in per connection.**
   Level 3 materialization of stored credentials remains denied. The
   derived-token path does not weaken the stored credential's fences,
   does not widen any egress allowlist, and cannot be enabled by
   delegation (ADR 0044's attenuation-only rule means a delegate can
   never raise `materialization` on a connection it does not own).

## Consequences

- The helper protocols become reachable without touching stored
  credential bytes: the plaintext `.git-credentials` and
  `~/.aws/credentials` files this displaces are strictly worse than an
  hour-scoped revocable token, which is the point.
- Mint events and helper uses are new audit events with the
  subject/actor split recorded, so "which agent got which token, for
  what, expiring when" is answerable from the trail alone.
- Providers without a mint path (raw API keys, most MCP servers) are
  permanently outside helper mode; their acquisition story remains
  ADR 0048's invoke-through and import modes, and `422 UNMINTABLE`
  keeps that answer honest instead of degrading into decryption.
- The daemon's helper surface reuses its existing fences (ADR 0047's
  operator gating, ADR 0048's tailnet identity); the helpers add no new
  listener and no new trust boundary.
