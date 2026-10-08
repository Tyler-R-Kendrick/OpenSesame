# Implementation records

Working documents for features built out across many pull requests: the
baseline they started from, who owns which part, the contracts between parts,
and the test plans that say when they are done. They are records of work in
progress, not descriptions of the finished system — for that, read
[architecture](../architecture/README.md). When a programme finishes, its
directory moves to [`archive/`](../archive/README.md). The status column below
is as of 2026-10-08; a document whose body no longer reads as current opens with
a dated status line of its own.

| Programme | Documents | Status |
|---|---|---|
| [Native host and self-issued identity](native-host/README.md) ([ADR 0138](../adr/0138-self-issued-identity-one-native-host.md), proposed) | [Plan](native-host/README.md): one native process per machine, identity self-issued by default, MCP in every app, `apps/` reduced to products | Live, partly landed |
| [General authority](general-authority) ([ADR 0120](../adr/0120-generalized-hierarchical-authority.md)) | [Ownership](general-authority/ownership.md) · [repository baseline](general-authority/repository-baseline.md) · [API surface](general-authority/api-surface.md) · [storage](general-authority/storage.md) · [compatibility map](general-authority/compatibility-map.md) · [Host route inventory](general-authority/host-authority-route-inventory.md) · [panel gating](general-authority/panel-gating.md) · [OpenFGA tuple backfill](general-authority/openfga-tuple-backfill.md) · [cross-plane test plan](general-authority/cross-plane-test-plan.md) · [adversarial matrix](general-authority/adversarial-matrix.md) · `completion-matrix.json` · `contract-registry.json` · `local-ledger-inventory.json` | Landed; 47 of 48 matrix items verified (GA-O-04 is a standing item that never closes) |
| [Ceremonies into Pages](ceremonies-into-pages) ([ADR 0140](../adr/0140-pages-hosts-every-ceremony.md)) | [Plan and inventory](ceremonies-into-pages/README.md): every link-opened ceremony becomes a Pages route and the three apps that served them are deleted | Landed |
| [Capability composition](capability-composition) ([ADR 0130](../adr/0130-operator-controlled-capability-composition.md)) | [Ownership and interface contract](capability-composition/ownership.md) | Landed |
| [Product experience](product-experience) | [Baseline](product-experience/baseline.md) · [contracts](product-experience/contracts.md) · `ownership.json` · `traceability.json` | Baseline and contracts; every path in `traceability.json` resolves |
| Wallet consent | [Consent baseline](wallet-consent-baseline.md) ([ADR 0123](../adr/0123-wallet-spending-authority.md)) | Baseline record |
| Browser-hosted sessions | [Acceptance](browser-sessions/acceptance.md) — three-process strict-direct proof against ADR 0150 live sessions | Point-in-time proof |
