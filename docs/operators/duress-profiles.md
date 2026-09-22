# Operator guide — duress profiles (presets, consent, delays, rehearsal)

**Audience:** vault owners configuring optional duress on OpenSesame Pages.
**Not a personal safety plan.** Read the limitations section before arming.

Design: [ADR 0130](../adr/0130-duress-profiles-trust-boundaries.md).
Evidence: `docs/evidence/2026-09-21-duress/`.

## When to use this

Use duress profiles only if you understand that:

- Activation is **opt-in** and rehearsed before arming.
- Browser-local behavior is not the same as cryptographic isolation or an
  independent Host/custodian hold.
- Alerts, if configured, are **optional**, value-blind, and do not guarantee
  that a human can help you.
- Local removal and holds do **not** erase historical offline copies or prove
  forensic cleanup.

If you need physical safety, contact appropriate local resources. This product
does not provide that.

## Presets (scenario vocabulary)

Presets map to compiled scenario IDs (fixtures under
`docs/evidence/2026-09-21-duress/examples/` once CONTRACT lands). Labels in UI
must match these semantics — do not invent stronger wording.

| Preset / scenario | Typical trigger | What changes | Honest limit |
|---|---|---|---|
| Alert only (`SC-ALERT-ONLY`) | Application code (or stronger) | Queues/sends a sealed alert; unlock path may stay real-access if configured | Alert queued ≠ delivered ≠ acknowledged; no emergency response |
| Restricted (`SC-RESTRICTED`) | Code | Presentation and access ceiling limited to admitted compartments | Shared-root projects are **not** isolated |
| Decoy (`SC-DECOY`) | Code | Shows an independently keyed decoy compartment | Decoy never forges production success or mutates real providers |
| Local hold (`SC-LOCAL-HOLD`) | Alternate code | Ordinary-looking locked/unavailable; sensitive handles invalidated | **No countdown UI**; local clock is not a tamper clock; expiry ≠ auto-unlock |
| Custodian hold (`SC-CUSTODIAN-HOLD`) | Code | Selected compartments need recovery contributions / optional independent authority | Approval quorum ≠ key custody; disclose historical keys |
| Quarantine (`SC-QUARANTINE`) | Code | Keep a small local compartment; quarantine peer refs | Network reachability alone is not authority |
| Local remove (`SC-LOCAL-REMOVE`) | Code | Enumerated local resources removed; optional sealed outbox retained | Not global wipe; not forensic erasure |
| Limited carry (`SC-LIMITED-CARRY`) | Pre-incident owner action + code | Retain selected everyday items under a ceiling | Explicit pre-incident consent required |
| Approval duress (`SC-APPROVAL-DURESS`) | Code in app-owned approval ceremony | Deny before sign/mint/invoke | No fake success; agents cannot approve |
| Lost device (`SC-LOST-DEVICE`) | Delegated peer request | Local retirement / quarantine path | Peer must present bound delegation, not “on the tailnet” |
| Split scope (`SC-SPLIT-SCOPE`) | Per-owner profiles | Personal vs org compartments differ | Scope expansion requires each affected owner |
| Canary (`SC-CANARY`) | Canary activation | Detection-only | Never escalates to destruction from hits alone |
| Rehearsal (`SC-REHEARSAL`) | Isolated exercise | Proves readiness without arming production effects | Required before arming (INV-02) |

Advanced multi-profile setups use the same compiler; presets are curated
catalogs, not a second security engine.

## Consent and scope review

Before arming:

1. Confirm **affected owner** identity for every compartment in scope.
2. Review the compiler **exposure summary**: admitted/denied compartments,
   unlock-path labels, alternate-wrapper warnings, historical-copy disclosure.
3. Acknowledge destructive effects explicitly (`acceptUnrecoverability` where
   removal is configured; `disclosureAck: true` on holds).
4. Confirm alert routes are **pre-approved**, recipients consented and tested,
   and templates are value-blind (no codes, PRF, shares, or unexpected
   location/media — INV-18).

Importing a policy with `enabled: true` is **preview only**. It does not arm.

## Delays and holds

| Hold kind | Meaning | Operator must know |
|---|---|---|
| `none` | No hold effect | — |
| `local_application` | This origin enforces duration / indefinite refusal | Not tamper-resistant; clock skew possible; expiry only allows a **fresh recovery attempt** |
| `independent_authority` | Host or other enrolled authority must clear | Offline authority ⇒ no fabricated clear |
| `custodial_reenrollment` | Recovery policy / quorum required | Shares must not live only inside the removed compartment |

Do not display a conspicuous countdown during an active local hold. Owners see
duration policy at enrollment time.

## Recipient and custodian planning

Separate roles (do not conflate):

- **Alert recipient** — may learn that an activation package was delivered;
  cannot unlock, approve recovery, or delete by virtue of the alert.
- **Lock / hold custodian** — contributes to clearing an independent hold.
- **Recovery approver** — signs request-digest-bound approvals.
- **Key custodian** — holds recovery shares (Shamir / wrapping secret).
- **Affected owner** — arms, disarms, and authorizes scope.

Plan: how recipients should respond (call a known person, start recovery, do
nothing until a second channel confirms). Document that **notification
acknowledgement never unlocks** (INV-14).

Warn at enrollment that notification traffic may be observable on-network.

## Rehearsal

Isolated rehearsal (`SC-REHEARSAL`) must succeed before arming:

- Uses disposable fixtures / isolated environment — never production recipient
  tokens or real vaults in CI.
- Proves trigger selection, presentation class, and readiness
  (`durableStorage`, `offlineAssets`, `rehearsalPassed`, `ownerConsent`).
- Must not leave a half-armed destructive code on failure.

Replace codes through the supported ceremony; never display stored codes in
settings.

## Related guides

- Inventory, migration, custodial recovery, retirement:
  [duress-inventory-recovery.md](./duress-inventory-recovery.md)
- Troubleshooting:
  [duress-troubleshooting.md](./duress-troubleshooting.md)
- Vault key protection (any-of wrappers):
  [vault-key-protection.md](./vault-key-protection.md)
