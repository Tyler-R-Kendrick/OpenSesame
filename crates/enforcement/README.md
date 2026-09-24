# opensesame-enforcement

Describes what a platform actually enforces, precisely enough to refuse a grant
it cannot hold. A grant states terms somebody will later try to hold — a
deadline, a revocation, a boundary — and whether they can be held depends on
the platform the subject runs on. That answer is not one number: this crate
replaces a `hard` / `best_effort` scalar with three unordered dimensions
(expiry, termination, isolation), each answered by five independent facts or a
named `Unsupported`. Host / authority plane; no I/O, no credential values, no
clock reads (the caller passes seconds), and `#![forbid(unsafe_code)]`.

## Where it fits

- **Used by:** [`opensesame-authz`](../authz) — `enforcement_gate` projects a
  domain `Grant` onto `GrantTerms` and runs preflight; `issuance` looks the
  platform up in `catalog()`.
- **Builds on:** no workspace crates — `serde`, `thiserror`.
- Ownership is the load-bearing distinction: an enforcement point either is
  independent of the subject or is self-administered. A library inside the
  subject may not claim to be hard to bypass, may not claim to act before the
  subject's next use, and may not report on itself; the effect ledger refuses a
  report from the subject.
- `Desired` and `Observed` are separate states. Nothing copies one into the
  other, and a dimension nothing can observe diverges as unverifiable rather
  than converging.
- There is no iOS or Android adapter in this repository, so `apple-ios` and
  `android` are `AdapterStatus::Absent` with every dimension
  `UnsupportedReason::NoAdapter`, and preflight against them refuses.

## Surface

| Item | What it is |
|---|---|
| `Dimension` | Expiry, termination, isolation — no ordering between them |
| `Guarantee`, `Mechanism`, `Bypass`, `Latency`, `Survival`, `Observability` | One dimension's answer as five facts plus the mechanism; no method returns a score |
| `EnforcementDescriptor` | A platform and surface answering every dimension; building one runs `conformance::audit` |
| `EnforcementPoint`, `SubjectSurface` | Who enforces, and which points are in the call path |
| `Requirement`, `Requirements` | What a grant needs, field by field |
| `preflight`, `Admitted`, `Refusal`, `Shortfall`, `Unmet` | The refusal, with each unmet demand and the platform's `UnsupportedResponse` |
| `grant::{requirements_for, preflight_grant, GrantTerms, OfflineUse}` | Requirements derived from a grant's own constraints |
| `Effect`, `EffectLedger` | Desired versus observed, per dimension |
| `Unsupported`, `UnsupportedReason`, `UnsupportedResponse`, `Remedy` | A named refusal with machine-readable remedies |
| `catalog()`, `Catalog::find` | Checked-in descriptors: `host-brokered-invocation`, `host-minted-token`, `host-minted-token-revocable`, `apple-ios`, `android`, `discord-live`, `blocky-live-saas` |

## Develop

```bash
cargo +1.88.0 test -p opensesame-enforcement
```

Integration suites: `tests/conformance_rules.rs`, `platform_catalog.rs`,
`grant_terms_preflight.rs`, `effect_ledger.rs`, `effect_reconciliation.rs`.
`catalog()` returns every descriptor that fails the conformance audit as an
error, so a new catalogue entry cannot overclaim.

## Related

- [ADR 0120](../../docs/adr/0120-generalized-hierarchical-authority.md) —
  generalized hierarchical authority
- [`crates/dns-enforcement`](../dns-enforcement),
  [`crates/collab-adapter`](../collab-adapter) — the local adapters whose claims
  the `blocky-live-saas` and `discord-live` entries refuse to extend to a live
  service
- [`docs/operators/general-authority-support-matrix.md`](../../docs/operators/general-authority-support-matrix.md)
