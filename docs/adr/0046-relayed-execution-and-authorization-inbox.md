# ADR 0046 — Relayed execution and the authorization-request inbox

Status: Proposed
Date: 2026-08-19
Amends: ADR 0044 (post-claim controls; delegation items gain an execution mode)

## Context

ADR 0044 delegates a connection by minting an attenuated child `Grant`
and letting the delegate invoke through the broker: the gateway holds the
sealed credential and makes the call. That works when the upstream
credential can be narrowed — a GitHub App installation token, an OAuth
scope subset, anything with a token-exchange or down-scoping endpoint.

It does not work at all for the connectors people most want to share.
A personal MCP server, a raw API key, a provider with one all-or-nothing
token: there is no attenuation to mint, so brokering the credential means
handing over the whole thing. ADR 0032 §6 forbids that, and rightly.

The escape hatch is to move the *request* instead of the credential. The
delegator's own runtime — their daemon, holding the credential it already
holds — executes the delegate's call and returns only the result. This is
SSH agent forwarding generalized from signatures to API calls, and it
inherits that design's entire threat history: an agent protocol that
carries no context cannot tell a legitimate request from a hijacked one
(the 2019 Matrix.org compromise), and the forwarding runtime is itself
attack surface (CVE-2023-38408). OpenSSH's answers — destination
constraints bound at load time and enforced by the agent (8.9),
`ssh-add -c` per-use confirmation, FIDO touch-per-signature — are the
answers we adopt.

Relaying also forces a second thing into existence. A request that the
holder must consent to needs somewhere to wait, which means a durable
queue of pending authorizations, which is exactly what a user asking
"who wants what, right now?" needs anyway. OpenID CIBA already specifies
this shape (`auth_req_id`, `expires_in`, `interval`, poll/ping, a
`binding_message` shown on both devices), UMA 2.0 specifies the
third-party variant (`request_submitted`), and GNAP specifies the
key-bound continuation. So relay and the inbox are one system, not two,
and they share one vocabulary: RFC 9396 `authorization_details` is
simultaneously the delegation constraint, the approval prompt, the
enforcement predicate, and the consent echo in the receipt.

Three seams for this already exist in the codebase and have never been
connected: `InvocationState::AwaitingApproval`
(`crates/domain/src/invocation.rs:7`, with legal edges at `:24-45` and no
producer), `approval_id` on `InvocationReceipt` (`receipt.rs:37`, always
`None`), and the reserved event names
`authority.invocation.requested|completed`
(`packages/os-domain/src/types.ts:534`, zero references).

## Decision

1. **Delegation items carry an execution mode.** ADR 0044 offer items
   gain `execution_mode: broker | relay`. `broker` is the existing model.
   `relay` means the credential never reaches the gateway at all: the
   delegate's request travels to the holder's runtime and executes there.
   Relay is a fallback for non-attenuable connectors, never a default —
   it buys reach and pays for it in revocation immediacy and liveness.
2. **The request is a frozen, digest-bound object, and execution refuses
   any digest drift.** Reuse the `FrozenIntentV2` discipline
   (`crates/broker/src/frozen.rs:33-73`): canonical arguments, digest,
   grant coverage, task-state pinning, with RFC 9396
   `authorization_details` as the payload. **If the executed request's
   canonical digest differs from the approved digest, execution fails.**
   This is PSD2 SCA dynamic linking (Commission Delegated Regulation (EU)
   2018/389, RTS Art. 5 — an authentication code must be specific to the
   amount and payee shown, and any change invalidates it) applied to
   arbitrary API calls. It is also the fix for agent forwarding's original
   sin, where a signature request never said what it was for. Without
   this invariant every approval in this ADR is decorative.
3. **Authority is the intersection, never the holder's.** A relay run
   binds an `AuthorityContext` in `ConservativeCommonGrant` mode
   (`crates/domain/src/authority_context.rs:12`) with exactly two
   principals: the delegate and the holder. The holder's process makes the
   call, but the ceiling is the intersection of both grants, so the
   delegate can never reach authority the holder did not delegate — even
   though the credential in play is capable of far more.
4. **The holder re-authorizes; it never trusts the relay.** Before
   executing, the holder's daemon independently validates the request
   against the delegation's stored `authorization_details`. This is
   OpenSSH 8.9's destination constraints: when the upstream protocol
   supports no attenuation, attenuation is enforced *at the credential
   holder*. Gateway authorization and holder authorization are both
   required; either refusing is a refusal. The relayed payload is hostile
   input and is parsed as such.
5. **Liveness fails closed.** A relayed call is `A2AuthorityRequired` or
   `A3ExternalSideEffect`, and `AvailabilityClass::allow_without_quorum`
   (`crates/domain/src/availability.rs:22`) already refuses both without
   quorum. Relay additionally forbids `OfflineUse::PreAuthorized`: the
   holder's live runtime *is* the authority here, so there is no
   queue-it-and-execute-when-they-return. A delegate whose delegator is
   offline gets a typed refusal, not a promise.
6. **Per-use confirmation is a property of the delegation**, not a global
   setting: `auto | prompt | prompt_once_per_window`. The windowed mode
   follows 1Password's SSH-agent model — an approval caches against
   (delegate, connection, purpose, window) rather than blanket-approving
   the delegate. Sensitive operation classes pin `prompt` and cannot be
   cached.
7. **Channel: JSON-RPC 2.0 framing, three transport tiers.** Framing stays
   MCP-compatible, since MCP permits custom transports that preserve
   JSON-RPC. Tier 1 is the existing per-principal NATS inbox
   `opensesame.callout.principal.{id}.>` (`crates/authz/src/callout.rs:72`)
   with xkeys-sealed payloads — already granted bidirectionally, so no new
   permission rule, and a dedicated consumer is a `filter_subject` config
   change. Tier 2 is a WSS relay through the gateway, payloads still
   sealed so the relay is a courier and not a reader. Tier 3 is a WebRTC
   data channel (RFC 8831) for peer-to-peer, with **DTLS fingerprints
   signed by OpenSesame device/proof keys at the application layer** —
   RFC 8827's identity-provider binding is effectively undeployed, so
   without app-layer signing a signaling server can MITM by swapping
   fingerprints. TURN relays (RFC 8656) forward ciphertext only. Sealing
   uses xkeys recipient public keys; per ADR 0042 the deployment seal key
   is never xkey material.
8. **Pending authorizations are durable, CIBA-shaped objects.**
   `auth_req_id`, `expires_in`, `interval`, poll and ping delivery, and a
   `binding_message` rendered identically to the requester and the
   approver. Following FAPI-CIBA, the request as presented is retained in
   verifiable form, so an approval can be audited against exactly what the
   human saw. The state machine mirrors the existing
   `AwaitingApproval` edges rather than inventing a parallel one.
8b. **An inbox is addressed by a handle, not by a principal id.**
   Creating a request names the approver by an opaque, server-minted
   handle (`inbox_<id>.<mac>`, the id under an HMAC keyed by the
   deployment pepper), issued only to its owner by
   `GET /v1/authorization-requests/inbox-ref`. Knowing who somebody is
   must not be enough to put attacker-authored text in front of them, and
   an addressable-by-id inbox answers, for any id, whether it exists —
   the create route would be a principal-id oracle with a 201/404 split.
   Holding the handle *is* the authorization to ask, the same shape as the
   claim links this service already hands out. A handle that fails its MAC
   and a handle for a principal that is gone answer identically, so
   nothing is left to probe. This does not replace per-request
   authorization: it makes the addressing itself unguessable, and the
   relationship model that would let the server say *why* a given
   requester may ask a given approver is still owed (the identity plane
   has no repository for delegations or ownerships today).
9. **Multi-approver by set, not by count.** An `ApprovalSet` mirrors
   `AcknowledgementSet` (`crates/domain/src/mediation.rs:74`): it records
   *which* approver settled *which* requirement, refuses an approver the
   request never asked for, and is idempotent on retry — because counting
   would let one approver answer twice and stand in for a silent one. The
   shape is reused; the trust ratchet's no-widen invariant is not, since
   an approval gate permits an action rather than shrinking a ceiling.
10. **Post-claim controls are attenuation-only edits.** Narrowing a live
    delegation — removing an item, shrinking scope, shortening TTL — is a
    **revoke-and-replace**: mint a narrower child grant validated against
    both the parent grant and the current child (a new
    `Grant::validate_replacement`), because ADR 0044's manifest digest is
    immutable by design and must stay that way. **Widening is never an
    edit**: it is a new offer and a new claim ceremony, appended to the
    same delegation set. This keeps "what was agreed" and "what is in
    force" both auditable, and keeps every existing attenuation invariant.
11. **Agent approvers are envelope-bounded and never open-ended.**
    `HIGH_RISK_ACTIONS` (`packages/policy/src/provisional.ts:81`) denies
    `claim.force_complete` and `admin.impersonate` to every subject, and
    that does not change. A registered approval hook may decide only
    inside an envelope its owner pre-authorized (request class ⊆, scope ⊆,
    budget, TTL, expiry), may never decide a high-risk action, and may
    **never approve a request that would widen its own authority**. The
    receipt records `decidedByKind: human | agent` distinctly — an
    agent-approved action must never be indistinguishable from one a
    person approved. `AuthorizationDecision.obligations` carries
    `["requires_human_approval", authReqId]` as the denial's remedy.
12. **Hooks are signed event streams.** Outbound notification uses
    SSF/CAEP-shaped streams carrying RFC 8417 Security Event Tokens, push
    (RFC 8935) or poll (RFC 8936); the simple tier follows Standard
    Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature`,
    HMAC-SHA256, `whsec_` secrets, ±5 minute tolerance, `webhook-id` as
    the idempotency key). This is the repo's first *outbound* dispatcher —
    everything today is inbound — so it inherits the ADR 0039 backup-actor
    saga: the outbox is the source of truth, the bus only accelerates,
    failures compensate with backoff, and poison batches dead-letter.
13. **Anti-fatigue is a requirement.** A tap-to-approve inbox without it
    is an MFA-fatigue engine (the 2022 Uber breach). Sensitive request
    classes require number matching — a code shown on the requesting
    surface and transcribed on the approving one, per CISA guidance —
    repeated or previously denied requests throttle and escalate, and
    duplicate requests dedupe by digest.
14. **Audit metadata must be digest-shaped, because the redactor's deny
    pass runs first.** In `packages/audit/src/redact.ts` the `DENY_KEY`
    test at `:77` executes *before* the allowlist check at `:78`, and its
    pattern matches `token`, `value`, `secret`, `user.?code` and
    `device.?code`. Inbox metadata is therefore keyed `authReqId`,
    `approvalId`, `requestDigest`, `bindingMessageDigest`,
    `decidedByKind`, `connectionId`, `delegationId`. A key named
    `userCode` or `bindingToken` would be dropped silently even after
    being allowlisted, leaving the one event a reviewer needs blank.

## Consequences

- Relay is the first execution path where the gateway is not the executor.
  Receipts must therefore name the executing runtime: `lease_owner`
  (`crates/domain/src/invocation.rs:50`, today the literal
  `"worker-local"`) becomes meaningful, and `delegation_chain` is
  populated alongside `approval_id`.
- Revocation semantics differ by mode and must be stated to users plainly:
  a brokered delegation dies the moment the grant is revoked, while a
  relayed one additionally depends on the holder's runtime honoring
  revocation — which it does, because it re-authorizes per request
  (decision 4), but only when it is online to be told.
- The inbox makes `AwaitingApproval` reachable, which means the broker's
  invoke path gains a suspend/resume shape it has never had
  (`crates/broker/src/lib.rs:73-133` is synchronous today). That is a
  substantial change to the most security-sensitive path in the system and
  lands behind the inbox slice, not with it.
- **Relay execution is gated on two prerequisites that are still open**
  (ADR 0044 §1.3): `apps/gateway/src/routes/intents.rs:88` discards the
  submitted `connection_ref` in favor of a hard-coded `demo-conn`, and
  `authorize_authority_use` (`crates/authz/src/authority_use.rs:36`) —
  the real ADR 0005 fence — never runs on the invoke path. Until both are
  fixed there is no correct place to enforce decision 3 or decision 4.
  This ADR therefore ships a handshake **stub** that refuses execution
  with a typed `501`, and says so rather than implying relay is close.
- Scaffolded in this slice: the inbox (schema, repository, CIBA-shaped
  endpoints, approve/deny/poll, audit events) and the relay handshake
  stub. Design-only: relay execution itself, the WSS and WebRTC tiers, the
  hook dispatcher, and agent-approver registration.
