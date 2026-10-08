# Wallet consent baseline (CONSENT swarm)

> Status (2026-10-08): a record of the baseline before `@opensesame/wallet-consent`
> was added ([ADR 0123](../adr/0123-wallet-spending-authority.md)); the
> package now exists (`packages/wallet-consent`). Its verifier is no longer a
> stub: `verifyDigestBoundApproval` also takes `trustedKeys` (enrolled SPKI
> keys) and checks an ES256 signature over the digest against them, refusing
> `key_not_enrolled` and `signature_invalid`.

How `payment_initiation` approvals work today, and what CONSENT adds without
touching those routes.

## Today (Identity plane)

1. **Create** (`packages/control-plane` `interaction-handoff`): RFC 9396
   `authorizationDetails` are validated (`assertAuthorizationDetails` —
   card-data deny-list). Binding message is server-derived. Digest is
   `canonicalRequestDigest` over kind, subject, opaque handles, details,
   message, resource, expiry (`packages/os-domain` `crypto/request-digest.ts`).
   Wire shape for a payment is positive in `@opensesame/contracts`
   (`PaymentInitiationDetailSchema`: amount decimal string + payee name).

2. **Decide**: Client may echo `requestDigest` (+ opaque `activationId` on
   approve) only — `ApproveInteractionSchema` / `assertOnlyDigestEcho`. A
   client-built `ApprovalProof` (`mechanism`, `assurance`, …) is refused.
   Approve spends a transaction-bound WebAuthn activation
   (`spendInteractionActivation`); the server seals mechanism/assurance from
   what it verified. Deny is digest-echo only (authority shrinks).

3. **Surfaces**: `@opensesame/ceremony-kit` `createInteractionClient` drives
   resolve/read/approve/deny and never ships a proof. Display copy is
   `renderInteractionSummary` (sanitized text). Settlement recomputes the
   same digest (`subject-adapters` `recomputeDigest`).

4. **Assurance broker**: `@opensesame/trust-broker` `evaluateApprovalCeremony`
   composes channel settlement + assurance + activation binding (ADR 0084).
   Channel ceilings never promote a callback’s self-asserted
   `phishing_resistant` string into a fact.

## Gap for wallet spending

Interaction digests bind the **whole ceremony envelope**. Wallet spend needs a
narrower digest over **executable payment terms** (amount, currency,
recipient) that agents/leases can recompute, plus a verify stub that fails
closed on forged assurance strings with no verified assertion bytes.

## CONSENT addition

`@opensesame/wallet-consent` — additive only; does not alter handoff routes.

- `buildPaymentApprovalDigest(intent)` → hex over canonical terms
- `verifyDigestBoundApproval({ expectedDigest, proof })` → rejects
  caller-supplied `mechanism`/`assurance` without verified bytes
