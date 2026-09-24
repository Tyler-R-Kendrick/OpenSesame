# Implementation records

Working documents for features built out across many pull requests: the
baseline they started from, who owns which part, the contracts between parts,
and the test plans that say when they are done. They are records of work in
progress, not descriptions of the finished system — for that, read
[architecture](../architecture/README.md). When a programme finishes, its
directory moves to [`archive/`](../archive/README.md).

| Programme | Documents |
|---|---|
| [General authority](general-authority) ([ADR 0120](../adr/0120-generalized-hierarchical-authority.md)) | [Ownership](general-authority/ownership.md) · [repository baseline](general-authority/repository-baseline.md) · [API surface](general-authority/api-surface.md) · [storage](general-authority/storage.md) · [compatibility map](general-authority/compatibility-map.md) · [Host route inventory](general-authority/host-authority-route-inventory.md) · [panel gating](general-authority/panel-gating.md) · [OpenFGA tuple backfill](general-authority/openfga-tuple-backfill.md) · [cross-plane test plan](general-authority/cross-plane-test-plan.md) · [adversarial matrix](general-authority/adversarial-matrix.md) |
| [Capability composition](capability-composition) ([ADR 0130](../adr/0130-operator-controlled-capability-composition.md)) | [Ownership and interface contract](capability-composition/ownership.md) |
| [Product experience](product-experience) | [Baseline](product-experience/baseline.md) · [contracts](product-experience/contracts.md) · `ownership.json` · `traceability.json` |
| Wallet consent | [Consent baseline](wallet-consent-baseline.md) ([ADR 0123](../adr/0123-wallet-spending-authority.md)) |
