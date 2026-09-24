# @opensesame/wallet-budget

The pure budget journal behind wallet spending authority: a tree of budget
nodes with atomic reserve, commit and release over the ancestor chain, and
idempotent payment attempts. Spending authority redistributes budget and
never mints it, and this package is where that is counted. No React, no
network, no EVM.

## Where it fits

- **Used by:** [`packages/app-core`](../app-core) — `spending-ledger.ts` wraps it with browser persistence, and the wallet agent broker reserves transfers and fees through it. The Pages capability classifier lists it.
- **Builds on:** nothing in the workspace; it has no runtime dependencies.
- Every node's projection has four disjoint buckets, and the identity `postedSpending + unresolvedExternalExposure + reservedToChildren + locallyAvailable === ceiling` always holds (`conserves`).
- A parent redistributes as `shared_counter` (children compete for one remainder) or `exclusive_allocation` (a parent must carve a slice before a child can spend).
- Transfer caps and fee exposure are separate remainders: charging gas or relayer fees from the transfer allocation is refused, and a transfer ceiling is never an all-in loss cap.
- The in-memory store's `transact` serializes writers, so two concurrent callers cannot both take the same remainder.

## Surface

| Export | What it does |
|---|---|
| `createBudgetLedger(store)` | `BudgetLedger`: `openNode`, `setCeiling`, `closeNode`, `allocateExclusive`, `reserve`, `commit`, `release`, `project`, `projectAttempt`, `listNodes`, `snapshot` |
| `createInMemoryBudgetStore`, `InMemoryBudgetStore`, `BudgetStore` | The transactional store; persistence adapters replay the same journal shapes |
| `reserveTransferAndFee`, `transferCapAllInLossLabel` | Reserve a transfer and its fee exposure separately |
| `conserves`, `projectionTotal`, `assertAmountUnits`, `isAmountUnits` | Conservation check and amount guards |
| `BudgetError`, `BUDGET_ERROR_CODES`, `budgetErrorMessage` | Typed refusals |

## Develop

```bash
pnpm --filter @opensesame/wallet-budget test
pnpm --filter @opensesame/wallet-budget typecheck
pnpm wallet:test:domain     # os-domain wallet + wallet-budget + wallet-policy
pnpm wallet:test:security   # domain targets, including this package, plus mainnet deny
```

`conservation.test.ts` is a fast-check property over the conservation
identity; `conservation-concurrent.test.ts` races concurrent reserves. The
`pnpm wallet:*` gates are described in [`scripts/wallet/README.md`](../../scripts/wallet/README.md).

## Related

- [ADR 0123](../../docs/adr/0123-wallet-spending-authority.md) — wallet spending authority (§1: redistribute, never mint)
- [`packages/wallet-policy`](../wallet-policy) and [`packages/wallet-consent`](../wallet-consent)
