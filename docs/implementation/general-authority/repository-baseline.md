# Repository baseline — general authority

- **GA-1 stack start SHA:** `4358f7feacee97468b17abdd9b5ccc02c81ee68d` (`origin/main` at GA-1 branch creation)
- **Inspected baseline (spec):** `4358f7feacee97468b17abdd9b5ccc02c81ee68d` (2026-09-14T16:33:13Z)
- **Working branch:** `feat/ga-01-contracts-docs` (docs/contracts only; no wallet or Rust authority implementation)

## Stacked PR sequence (authority trust boundary)

Wallet (ADR 0123 / PR #397) and general authority must not share one review surface.

| Stack | Branch (proposed) | Scope | Merge gate |
|---|---|---|---|
| W | `feat/wallet-spending-adr-0123` | Spending wallet only; strip or land authority separately | CI green → squash |
| GA-1 | `feat/ga-01-contracts-docs` from `main` | ADR 0120/0121, ownership, contract-registry, completion-matrix honesty | docs + matrix lint |
| GA-2 | `feat/ga-02-grant-lineage` on GA-1 | `grant_attenuation`, budgets omit, `ValidatedGrantChain`, AT-RAW-PARENT | `cargo test -p opensesame-domain -p opensesame-authz` |
| GA-3 | `feat/ga-03-storage-fence` on GA-2 | authority schema/migrate/fence/restore/budget | storage + fence tests |
| GA-4 | `feat/ga-04-cohort-snapshot` from `main` | AccessDomain verified; snapshot digest persistence; live offer refuse | domain + cohort/storage tests |
| GA-5 | `feat/ga-05-enforcement` from `main` | descriptors, broker fixture, Wasmtime, Blocky, Discord-or-refuse | adapter + refusal tests |
| GA-6 | `feat/ga-06-scenarios-portal` on GA-5 | `test:authority-fabric`, FIX-* scenarios, Pages templates | fabric gate + evidence |

Do not mark GA complete until recursive revocation, conserved budgets, restore fencing, and four primary E2E scenarios have named executable evidence.

## Honesty rule for this stack

GA-1 lands contracts and ADRs only. `completion-matrix.json` must not claim `verified` for Rust or other implementation that is not present on this branch; those claims move to GA-2+ with command-backed evidence on the matching code.

Rebased onto main after GA-2 (#400) via signed createCommitOnBranch.

## Landed on main (2026-09-16+)

- GA-1 #398, GA-2 #400, wallet #397, INV-REVOCATION #402, GA-4 #403, GA-5 #404, INV-BUDGET #405, INV-CONSISTENCY #406, surfaces honesty #407, GA-A #408, GA-I spawn/enroll #409.
- Remaining open: GA-P-02/Q-03 visual evidence, GA-I-02 membership reconciliation, standing matrix honesty (GA-O-04).
