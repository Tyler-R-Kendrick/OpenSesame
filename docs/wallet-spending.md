# Wallet spending — local verification

Operational notes for the wallet spending authority work (ADR 0123). **Do not**
point these gates at mainnet or spend real funds.

## How to run

```bash
CHAIN_ID=31337 pnpm wallet:verify   # fail-closed full gate (unit/sim suites)
pnpm wallet:verify -- --dry-run     # inventory only (still non-zero)
pnpm wallet:test:domain             # os-domain wallet + budget + policy
pnpm wallet:test:contracts          # wallet-evm simulation (not Anvil)
pnpm wallet:test:protocols          # Anvil Exact EIP-3009 settle + x402/consent fixtures
pnpm wallet:test:browser            # Pages WalletSection + spending-ledger
pnpm wallet:test:security           # conservation + policy + domain parsers
pnpm wallet:evidence                # refresh docs/evidence/wallet/last-run.json
```

Full detail: [`scripts/wallet/README.md`](../scripts/wallet/README.md).

## What is verified today

| Claim | Status | Meaning |
|---|---|---|
| Conserved shared-counter siblings (WAL-D03) | `fixture_verified` | Local journal refuses overspend |
| Subunit formatting (WAL-D01) | `fixture_verified` | Exact integer strings, no floats |
| Same-origin reload (WAL-D07) | `fixture_verified` | localStorage hydrate; not hostile-owner |
| Temporary card (WAL-B16) | `fixture_verified` | Issuer unavailable; no fake PAN |
| Guest boot (WAL-B19) | `fixture_verified` | Wallet without Identity API |
| Direct ERC-20 / Anvil (WAL-E01…) | `blocked` | Simulation only until Foundry harness |
| Live x402 merchant settlement | `local_execution_verified` (Anvil) | `pnpm wallet:test:protocols`; runtime prepare/execute still blocked |
| Issuer virtual cards | unavailable | No issuer integration |

## Invariant

New sessions, subagents, keys, or temporary instruments may redistribute
existing spending authority. They must not manufacture additional budget.

`Grant.constraints.budgets` attenuation alone is **not** this ledger.

## Safety

- Mainnet chain IDs are hard-denied by `scripts/wallet/lib/deny-mainnet.mjs`.
- Evidence under `docs/evidence/wallet/` must not contain secrets.
- A missing suite fails closed — never treat a stub as a pass.
- `local_execution_verified` requires real local-chain / merchant output, not
  JavaScript imitation of contracts.
