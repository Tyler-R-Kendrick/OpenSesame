# @opensesame/wallet-policy

The typed vocabulary of wallet spending constraints and the assessment of
how each one is enforced. `assess` compares what was requested, what a person
approved, and what a provider actually granted, and reports each constraint
as `enforced`, `approval_only` or `unsupported`. Pure: no UI, no chain, no
crypto dependency.

## Where it fits

- **Used by:** [`packages/wallet-x402`](../wallet-x402) (`ConstraintEnforcement` in its bounded x402 assessment); run by `pnpm wallet:test:domain` through [`scripts/wallet`](../../scripts/wallet).
- **Builds on:** nothing in the workspace; it has no runtime dependencies.
- Natural-language instructions are not constraints. Only the six `CONSTRAINT_KINDS` — `amount`, `recipient`, `period`, `fee`, `redelegation`, `asset` — may enter `assess`.
- Amounts are `AmountUnits`: canonical non-negative integer strings in the smallest subunit, never a JS number.
- A provider grant broader than the approval is refused (`POLICY_WIDENING_REFUSED`) even when adjustment is allowed. A calendar period against a fixed-interval-only mechanism is `PERIOD_SEMANTICS_UNSUPPORTED`, never silently mapped to 86 400 seconds.
- Ancestor intersection keeps inherited limits: a field missing on a child does not drop its parent's limit.

## Surface

| Export | What it does |
|---|---|
| `assess(requested, approved, providerEffective?)` | `ConstraintEnforcement[]`, one per constraint, with requested and effective digests and a detail code |
| `intersectAncestors`, `indexByKind` | All-ancestor intersection of constraint sets |
| `isBroaderThan`, `isNoBroaderThan`, `tighten`, `amountAtMost`, `parseAmountUnits` | Narrowing and comparison |
| `constraintDigest` | Deterministic, versioned digest of a constraint for equality checks |
| `CONSTRAINT_KINDS`, `POLICY_DETAIL_CODES`, and the constraint types | The vocabulary |

## Develop

```bash
pnpm --filter @opensesame/wallet-policy test
pnpm --filter @opensesame/wallet-policy typecheck
pnpm wallet:test:domain   # os-domain wallet + wallet-budget + wallet-policy
```

## Related

- [ADR 0123](../../docs/adr/0123-wallet-spending-authority.md) — §2: approval, external enforcement and observation stay distinct
- [`packages/wallet-budget`](../wallet-budget) — the budget journal these constraints are counted against
- [`scripts/wallet/README.md`](../../scripts/wallet/README.md) — the `pnpm wallet:*` gates
