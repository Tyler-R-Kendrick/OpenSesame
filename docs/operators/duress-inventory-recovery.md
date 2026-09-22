# Operator guide — duress inventory, migration, recovery, retirement

**Audience:** owners migrating key graphs, planning custodians, or retiring a
device after a duress incident.
**Companion:** [duress-profiles.md](./duress-profiles.md),
[vault-key-protection.md](./vault-key-protection.md).

## Copy / wrapper inventory

Before claiming isolation, restricted presentation, two-input protectors, or
local removal, inventory **every admitted unlock path** for the vault:

- Password / PIN (full KDF floors — a real-data PIN is a real unlock method)
- WebAuthn-PRF and UV-only authenticators (UV ≠ biometrics, ≠ PRF)
- Age recipients, recovery keys, cloud KMS envelopes
- Legacy standalone wrappers left beside a “stronger” migration
- Project keys that still share a root with non-selected compartments

The duress compiler / KEYS inventory must surface **alternate wrapper
warnings**. Stronger claims are refused until alternatives are removed,
migrated to independent keys, or explicitly accepted as residual exposure.

Shared-root legacy projects are **not** isolated compartments (INV-05).

## Migration

1. Prefer **independent compartment roots** for restricted/decoy presentation.
2. Two-input (`prf_and_code`) requires both inputs on **every** admitted path
   (INV-08). Leaving a standalone PRF or password wrapper that opens the same
   root invalidates the claim.
3. Crash during migration must leave either the previous valid published state
   or the verified new state — never an unverified last-path loss.
4. Older clients / feature-off builds must **fail closed** on unsupported
   profile formats — no silent fallback to unrestricted wrappers (INV-29).

## Custodial recovery

Roles stay separate: alert recipient ≠ recovery approver ≠ key custodian.

- Approvals bind a **request digest**, target device proof, incident/policy/key
  epochs, and are non-reusable.
- Reconstruct wrapping secrets with authenticated share context; do not cache
  enough local plaintext shares to bypass the hold.
- Custody-domain accounting: several credentials from one domain do not count
  as independent custodians unless disclosed and policy allows.
- Circular custody (all shares only inside the removed vault) is rejected at
  readiness (INV-20).
- Perform a **real custody drill** before arming local removal that depends on
  preserved recovery (INV / AT-075 class).

Lost custodians: rotate generation, revoke old grants, enroll replacements.
Old signed contributions for revoked generations must fail.

## Device retirement vs content deletion

| Action | Means | Does not mean |
|---|---|---|
| Device retirement | This device binding cannot newly admit protected authority without recovery/re-enrollment | Shared content deleted everywhere |
| Local enumerated removal | Exact owner-approved resource refs cleaned in this origin | Forensic wipe; other tenants; designated backups |
| Provider revocation | Real adapter call with honest receipt | All derivative sessions everywhere gone |
| Cryptographic erasure claim | Only if keys are gone **and** no historical copy remains usable | Root rotation alone (historical copies may still decrypt — INV-24) |

Peers notified of retirement must **not** treat the message as backup purge.

## Restore and historical residual access

- Importing an old backup into a current authority-governed context must not
  lower epochs, clear incidents, or silently authorize a retired device
  (INV-21, INV-24).
- A complete pre-incident offline snapshot plus its old root remains
  decryptable — **disclose this** at enrollment and in exposure summaries.
  Documentation must never claim that local removal erased those copies.
- Designated safe backups should refuse unilateral destructive mutation from
  the affected device when that policy is enrolled.

## After an incident

1. Treat incident state as monotonic until authorized recovery resolves it
   (INV-13). Normal unlock after alert-only does **not** auto all-clear.
2. Verify effect statuses separately: `applied_local`, `accepted_remote`,
   `confirmed_remote`, `failed`, `expired`, `completion_unknown` (INV-12).
3. Rehearse replacement codes on a recovered device before re-arming.
