# ADR 0130 — Duress profiles: trust boundaries

- **Status:** Accepted (implementation in progress on `feat/duress-profiles`)
- **Date:** 2026-09-21
- **Deciders:** OpenSesame maintainers
- **Evidence:** `docs/evidence/2026-09-21-duress/`

## Context

OpenSesame Pages is a browser-local static PWA. Operators want optional
*duress profiles*: alternate unlock inputs that change presentation, hold
authority, send preconfigured alerts, quarantine peers, revoke providers, or
remove enumerated local resources — without a mandatory Host, Identity plane,
daemon, cloud, or Tailscale dependency after enrollment.

Four different assurance classes are easy to conflate in UI copy:

1. **Browser-local application policy** — what this origin’s JS and durable
   storage will refuse or present.
2. **Cryptographic isolation** — what keys exist and which inputs recover them.
3. **Independent authority** — a Host, custodian quorum, or external signing
   hold that this browser cannot unilaterally clear.
4. **External observation** — relays, peers, and providers that may queue,
   deliver, or revoke with separately reported outcomes.

Mixing those classes produces false safety claims (forensic erasure, personal
safety guarantees, tamper-proof local timers, “recipient received = emergency
handled”).

## Decision

### 1. Product surface

Duress is an **opt-in** Pages feature (INV-01). Never-enrolled and feature-off
builds keep ordinary unlock/IAM behavior and perform no duress network traffic.
Arming requires affected-owner authorization, explicit scope review, and a
successful isolated rehearsal (INV-02). Import/`enabled: true` is preview only
and never silently arms.

### 2. Trust boundary table

| Boundary | What it can honestly assert | What it must not claim |
|---|---|---|
| Browser-local | Scoped presentation; local holds; enumerated local removal; durable incident fence in this origin’s storage | Tamper-resistant clocks; forensic disk wipe; undetectable activation against a skilled observer of the device |
| Cryptographic | Independent compartment keys; two-input protectors; sealed alert packages that do not open the protected root | Shared-root “isolation”; UV ≡ biometrics; PIN as a hidden weak verifier; retroactive secrecy after root rotation |
| Independent authority | Host/custodian-enforced hold or recovery contribution when enrolled and reachable | That a disconnected phone still enforces a remote hold; that alert ACK unlocks anything |
| External effects | Queued ≠ delivered ≠ recipient-received ≠ human-acknowledged; provider revoke only via real adapters | Emergency response; global replica deletion; success when completion is unknown |

### 3. Authority model preserved

Host/Identity separation and ConnectionRef+Intent remain. Duress does not mint
agent authority to enroll triggers, export roots, approve recovery, or inherit
human emergency actions (INV-32). Opaque `AccessContext` evidence — not JSON
session copies — authorizes protected operations (INV-09, INV-11).

### 4. Effect composition

A profile is a compiled `ProfileEffectSpec`: presentation, hold, optional
alert, peer quarantine, provider revocation refs, removal, recovery policy,
and operation ceiling. The pure compiler (`packages/contracts` duress module)
rejects contradictions with stable error codes. Unsupported required
capabilities **fail closed** and are labeled unsupported — never stubbed
success (INV-29).

### 5. Honest limitations (non-negotiable copy)

- **No personal-safety guarantee.** This feature does not replace a personal
  safety plan, physical security, legal counsel, or emergency services.
- **No forensic-erasure claim.** Local removal is enumerated application
  cleanup of owner-approved resources. It is not cryptographic erasure of all
  historical copies, provider-side deletion, or disk sanitization (INV-22,
  INV-23, INV-24).
- **Local holds are not tamper clocks.** Client clock changes can affect
  local-only duration. Expiry permits a fresh recovery *attempt*; it never
  auto-decrypts or restores privileges (INV-19).
- **Alerts are not emergency response.** Acknowledgement never unlocks
  (INV-14, INV-16). Notification failure never triggers unconfigured
  destruction (INV-17).
- **Historical copies remain.** Old ciphertext plus an old usable key is a
  disclosed residual exposure; root rotation is not retroactive secrecy
  (INV-24).

## Consequences

- Settings → Security hosts enrollment, rehearsal, and status; decoy/restricted
  foregrounds must not leak sensitive labels or require new permission prompts
  at activation (INV-27).
- Evidence pack under `docs/evidence/2026-09-21-duress/` maps INV/SC/AT/task IDs;
  COORD fills execution results. REDTEAM owns adversarial findings text in
  `security-review.md`.
- Operator guides document presets, inventory/recovery, and troubleshooting
  without marketing undetectability.

## References

- ADR 0084 (notification ≠ authorization), ADR 0090 / 0128 (Pages without Host),
  ADR 0129 (vault key protection any-of)
- `.duress-swarm/SEMANTIC_CONTRACT.ts` (informative); Zod in
  `packages/contracts/src/duress/` (authority)
- Invariants INV-01…INV-32 in the duress execution mandate
