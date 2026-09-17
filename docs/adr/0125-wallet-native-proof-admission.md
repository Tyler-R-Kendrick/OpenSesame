# ADR 0125 — Wallet-native proof admission and consume drain

## Status
Accepted

## Context

ADR 0086 made an `Interaction` the one envelope for a cross-device question,
and ADR 0119 wired the wallet-native HTTP mounts. Two gaps remained:

1. **Proof admission was incomplete.** Approve already required a spent
   activation, but the sealed proof, the durable attempt ledger, and the
   kind-scoped phishing-resistance table were not the same path. A TOTP code
   could be presented as if it were a WebAuthn assertion, and a client-supplied
   extra field on the approve body was stripped rather than refused.
2. **Consume did not drain.** Spending an approval appended an outbox command
   and left it unpublished. There was no fenced execution reservation, no
   Identity-plane apply for `authorization_request` / `claim` / `grant_claim`,
   and the applied audit row could carry a device session id.

Subjects that live on the Identity plane (`authorization_request`, `claim`,
`grant_claim`) were also mintable against ids that did not exist, so a
reference could front a ceremony the caller was not entitled to.

## Decision

1. **Consume is a reserved drain.** `consumeAndSettle` acquires an
   `executionReservations` lease (60s), settles the subject via the outbox
   adapter, applies Identity-plane rows (`authorization_request` to `approved`,
   `claim`/`grant_claim` to `completed`), applies Identity-owned ceremony
   rows (`device_authorization` to `consumed`, `pairing` to `paired`,
   `transaction_authorization` to `authorized`), commits the reservation, and
   writes `interaction_subject.applied` with `interactionId`, `subjectKind`,
   `eventType`, `execution: "succeeded"`, and optional `requestDigest`. The
   audit metadata never includes `subjectId`. The consume route then
   `markPublished(command.id)` after the transaction so unpublished `*.settle`
   events drain. A `session_reauth` proof cannot consume a phishing-resistant
   kind (T-40).

2. **Memory reservations are visible in the same unit of work.**
   `executionReservations.acquire` applies immediately and defers, so a
   same-UoW `commit` can see the held row.

3. **Create is entitled.** `resolveEntitledSubject` checks existence and
   caller entitlement for every kind. A missing or unentitled subject is
   `404 interaction_not_found`. Device, pairing, and transaction rows are
   Identity-owned ceremony records that must already exist; a requester cannot
   squat another principal's live slot (T-09).

4. **Proofs are sealed from server facts.** `spendInteractionActivation` calls
   `sealApprovalProof`, records `interactionProofAttempts`, and consults
   `mechanismPermittedForKind`. TOTP maps to `out_of_band`.
   `interactionApprovalPolicyDigest(kind)` is weaker when
   `!interactionRequiresPhishingResistance(kind)`.

5. **TOTP is a first-class activation method, refused for high-risk kinds.**
   `POST /:ref/activation` accepts optional `method: webauthn | totp`.
   `POST /:ref/activation/totp` completes a TOTP activation. Begin with `totp`
   is refused for kinds that require phishing resistance.

6. **Durable wallet-native state.** `DurableWalletRegistrationStore` and
   `DurableOpenid4vpSessionStore` back the mounts through `DurableMap` when
   `createControlPlane` has a database. Memory remains the test/dev default.

7. **Wire schemas are closed.** `ApproveInteractionSchema` and
   `DenyInteractionSchema` are `.strict()`. Extra proof fields are
   `invalid_request` (400), not stripped into a digest-only approve.

8. **Policy table.** `interactionRequiresPhishingResistance` and
   `mechanismPermittedForKind` are exported from `@opensesame/policy`.
   High-risk kinds: `authorization_request`, `transaction_authorization`,
   `grant_claim`. Session kinds may use `out_of_band`.

9. **Proof-attempt mechanisms.** Migration 0026 expands
   `interaction_proof_attempts.mechanism` to the full `ApprovalMechanism`
   union: `webauthn`, `openid4vp`, `session_reauth`, `out_of_band`.

10. **The Host API is optional.** Consume settlement is complete on the
    Identity plane (ceremony/claim/authorization rows). Host HTTP is extra
    dispatch only when an operator token and a non-default Host URL are
    configured. A missing or unreachable Host must not un-succeed Identity
    execution or reopen a consumed approval.

## Consequences

Consuming an approval is the Identity-plane effect, not a dangling outbox
row and not a Host-API requirement. A reviewer of `interaction_subject.applied`
sees the kind and the digest, never the device session id. TOTP cannot
approve a payment. A fabricated proof body is refused at the schema boundary.
