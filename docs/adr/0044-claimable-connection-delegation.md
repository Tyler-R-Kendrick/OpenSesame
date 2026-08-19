# ADR 0044 — Claimable connection delegation (shareable connector auth)

Status: Proposed
Date: 2026-08-19

## Context

A user who has authorized a connector (e.g. GitHub OAuth exercised through
MCP) has no way to share that authority. Every shipping connected-account
broker we compete with (Zapier MCP, Composio, Nango, Arcade, Anthropic
connectors, both projects named "OpenConnector") stops at "your own
connection, mediated" — none lets an owner mint a disposable, claimable
delegation of an existing connection to another human or agent. We already
have the analogous ceremony for identity: guest/anon principals with later
claim (PR #143), and single-use claim sessions with peppered tokens and
user codes (ADR 0009).

The codebase has anticipated this feature without wiring it:

- `claim_sessions.type` admits `'connection'` and `'resource_bundle'`,
  and `claim_items.requested_action` admits `'delegate'` — with per-item
  accept/reject, dependency closure, and manifest-digest immutability all
  implemented — yet no production code path creates connection claims or
  any `claim_items` at all
  (`packages/database/src/schema/index.ts:500,575`).
- `Shareability::Delegable`, `ConnectionPolicy.maximum_delegation_depth`,
  `consent_subject_id`, `permitted_actor_kinds` are modeled and parsed but
  have no enforcement consumer (`crates/domain/src/connection.rs:17-33`,
  `crates/connection-broker/src/lib.rs:1770`).
- `Grant.parent_grant_id` + `delegation_depth` +
  `Grant::validate_attenuation` + `DelegationChain::validate` implement
  attenuation-only child grants (`crates/domain/src/grant.rs:78`,
  `crates/domain/src/delegation_chain.rs`, `crates/grants/src/lib.rs:3`).
- The identity-plane `delegations` table exists with zero readers/writers
  (`packages/database/src/schema/index.ts:345`).
- `connection.delegated` is a reserved, unemitted audit event type
  (`packages/os-domain/src/types.ts:538`).

Standards give us every primitive: RFC 8628 supplies the claim-code state
machine (already implemented twice in this repo); RFC 8693 supplies
delegation semantics (`act`/`may_act`), currently a profile slug only;
GNAP (RFC 9635) legitimizes approver ≠ claimant as a first-class flow;
Vault response-wrapping supplies single-use claim semantics with
malfeasance detection; GitHub App installation tokens supply provider-side
attenuation (repo + permission subset, ≤ 1 h) that
`crates/connection-broker/src/installation.rs` can already mint.

## Decision

1. **A delegation is authority-plane state, like the connection it
   narrows** (ADR 0032 §1). New tables `connection_delegation_offers` and
   `connection_delegations` live beside `connections` in the gateway's
   store. The identity-plane `delegations` table becomes a read-model
   projection (via outbox), never the source of truth.
2. **The underlying credential never moves.** A claimed delegation yields
   a child `Grant` (attenuation-validated against the owner's grant, depth
   +1) plus a `connection_bindings` row for the claimant — never token
   bytes, never a copy of the sealed credential. Delegates exercise
   authority through the same ConnectionRef → authorize → invoke → receipt
   pipeline (ADR 0005); Level 3 stays denied; `raw_credential_export`
   can never widen through a delegation (`validate_attenuation` already
   refuses it).
3. **Offers are claimable, disposable, and spend-once.** An offer carries
   a peppered claim token (`osc_dlg_` purpose-separated per
   `docs/claims.md`), a mandatory user code, a TTL (default 10 min,
   ceiling 24 h), and one or more **items**, each naming a connection and
   its proposed attenuation (actions ⊆, resources ⊆, audiences ⊆,
   expiry ≤, budgets ≤ that connection's owner grant). Present is the
   single-use spend point: first claimant wins atomically; a second
   present is malfeasance evidence — the offer is burned **and every
   delegation already minted from it is revoked** (fail closed: a token
   seen twice means the link leaked; availability is sacrificed for
   integrity, Vault response-wrapping semantics).
4. **An offer may cover a group of connections.** Offers always carry
   items (a single-connection offer is a one-item offer); the item model
   reuses the dormant `claim_items` shape — per-item required/optional
   flags, dependencies with closure enforcement, and an immutable
   manifest digest. Every item must independently pass the mint fences
   (ownership, shareability, attenuation, depth): one ineligible
   connection fails the whole mint rather than being silently dropped.
   Claiming mints one child grant + one delegation row per accepted item,
   grouped by the offer id as the delegation set; the set revokes as one
   and members revoke individually. Egress stays per-connection — a
   bundle never widens any member's provider allowlist.
5. **Claimants are principals, provisional or full, human or agent.** A
   guest claims with a provisional principal (existing `pst_` machinery);
   identity upgrade preserves the principal id, so the delegation
   survives claiming the guest session. An agent claims with its
   registered instance; the claim binds `proof_key_jkt`, which the claim
   ceremony now verifies instead of merely storing.
6. **Delegates get invoke-only authority.** The ADR 0032 owner fence is
   unchanged: read/authorize/re-key/refresh/revoke/bind stay
   owner-or-operator. A delegate's binding admits `Describe` and
   L1 `Invoke` (L2 only if the offer says so and the parent binding
   allows it), inside the connection's existing egress allowlist.
   Delegations default to `maximum_delegation_depth = 0` on the child: no
   re-delegation unless the owner opts in, and never deeper than
   `ConnectionPolicy.maximum_delegation_depth`.
7. **`Shareability` becomes enforced, fail-closed.** `Private`
   connections refuse offer creation; `Delegable` allows owner-minted
   offers. `OrganizationWide`'s ambient claim-without-offer semantics
   **wait for the OpenFGA tuple-writer follow-up ADR 0038 already
   lists** — until then an `OrganizationWide` connection behaves as
   `Delegable` (offers work; ambient org claims are refused), because
   approximating org membership without real tuples would be an
   authorization check that lies. Today the field is decorative; this
   gives it its first consumer.
8. **Revocation is immediate for new work, mediated for in-flight work.**
   Revoking a delegation (or its parent grant, or the connection) fails
   the next authorize; in-flight task runs follow ADR 0018 (mediated
   restriction, not retroactive cancellation). Offer revocation is a new
   `DELETE` on the offer; the identity-plane claim engine's dormant
   `revoke` transition gets its first caller.
9. **Every step is audited and receipted.** New audit events
   `connection.delegation_offered | .claimed | .burned | .revoked |
   .expired` join the reserved `connection.delegated`;
   `AUDIT_METADATA_ALLOWLIST` gains the delegation keys (`delegationId`,
   `offerId`, `connectionId`, `granteePrincipalId`, `shareability`,
   `expiresAt`) — today the redactor would silently drop them. Invocation
   receipts already carry `delegation_chain`; delegated invocations must
   populate it.
10. **Security-first resolutions of the open design choices.**
    The claim ceremony is hosted by the **console** (the authenticated
    surface with fragment transport, principal pinning, and claim-page
    security headers already proven in `ClaimPage`), never the static
    Pages origin. Burned offers surface in the console offer list plus
    the audit trail — there is no silent path, and no notification
    channel is invented for v1. **Budgets decrement atomically and
    synchronously** in the broker, in the same transaction as intent
    insertion, and **deny when the decrement cannot be performed**
    (exhausted, contended past retry, or quorum-unavailable — the same
    fail-closed posture as `authority_quorum_ok`); receipt-count
    reconciliation is an audit backstop, not the enforcement point.
    OpenBao-style `credential-connections` are **refused at mint time**
    in v1 — only broker `connections` rows are delegable.

## Consequences

- The dormant seams get wired: claim `'connection'`/`'delegate'`
  vocabulary gains a producer, `Shareability` gains an enforcement path,
  `delegations` gains a writer (as projection), `connection.delegated`
  gets emitted, `proof_key_jkt` gets verified.
- Two prerequisites in the gateway invoke path stop being deferrable:
  `POST /api/v1/intents` must resolve the submitted `connection_ref`
  instead of binding it to `_requested_ref` and executing against the
  hard-coded `demo-conn`, and `authorize_authority_use` must actually run
  on that path — a delegate-aware authorization cannot be layered on an
  authorization that is not consulted.
- Delegation extends the attack surface of the authority plane: claim
  links become phishable artifacts (mitigated by state-blind landing
  pages, user codes, single-use spend, proof-key binding) and provider
  rate limits/abuse now have multi-principal attribution (mitigated by
  budgets in `GrantConstraints` and per-delegation receipts).
- RFC 8693 remains a semantic mapping, not a wire protocol: the "token
  exchange" happens inside the broker (subject = owner, actor = claimant,
  recorded in grant lineage and receipts), which is consistent with the
  MCP spec's ban on token passthrough and with
  `docs/implementation/one-shot-connector-auth-broker-prompt.md` ("do not
  add `/connections/{id}/token` for agents").
- Full analysis, API sketches, schema, threat table, and phasing:
  `docs/implementation/claimable-connection-delegation.md`.
