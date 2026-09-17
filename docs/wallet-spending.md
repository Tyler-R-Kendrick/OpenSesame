# Wallet spending — local verification

Operational notes for the wallet spending authority work (ADR 0123). **Do not**
point these gates at mainnet or spend real funds.

## How to run

```bash
CHAIN_ID=31337 pnpm wallet:verify   # fail-closed full gate
pnpm wallet:verify -- --dry-run     # inventory only (still non-zero)
pnpm wallet:test:domain             # os-domain wallet + budget + policy
pnpm wallet:test:contracts          # forge enforcer suites + wallet-evm
pnpm wallet:test:protocols          # Anvil Exact EIP-3009 + AP2/UCP fixtures
pnpm wallet:test:browser            # Pages WalletSection + spending-ledger
pnpm wallet:test:security           # conservation + policy + domain parsers
pnpm wallet:evidence                # refresh docs/evidence/wallet/last-run.json
```

Full detail: [`scripts/wallet/README.md`](../scripts/wallet/README.md).

## What is verified today

| Claim | Status | Meaning |
|---|---|---|
| Conserved shared-counter siblings (WAL-D03) | `fixture_verified` | Local journal refuses concurrent overspend |
| Subunit formatting (WAL-D01) | `fixture_verified` | Exact integer strings, no floats |
| Same-origin reload (WAL-D07) | `fixture_verified` | localStorage hydrate; not hostile-owner |
| Digest-bound consent (WAL-B01/B02) | `fixture_verified` | ES256 signature over executable terms; client-written `mechanism`/`assurance` is not evidence |
| Temporary card (WAL-B16) | `fixture_verified` | Issuer unavailable; no fake PAN |
| Guest boot (WAL-B19) | `fixture_verified` | Wallet without Identity API |
| Direct ERC-20 period enforcer (WAL-E01–E06/E09) | `local_execution_verified` (forge) | Real MetaMask pin contracts; `productionEnabled: false` |
| Live x402 Exact EIP-3009 (WAL-E11/E13/E14) | `local_execution_verified` (Anvil) | Shipped `prepareX402Payment`/`executeX402Payment` against loopback RPC |
| AP2/UCP ES256 local mandates (WAL-B10–B12) | `fixture_verified` | Fixture-local trust only; no public merchant |
| Prepaid session / Tempo / OWS / NWC | `blocked` | No escrow implementation in-repo |
| Issuer virtual cards | unavailable | No issuer integration |

Every adapter keeps `productionEnabled: false`. Local Anvil/forge is not a
target deployment.

## Invariant

New sessions, subagents, keys, or temporary instruments may redistribute
existing spending authority. They must not manufacture additional budget.

`Grant.constraints.budgets` attenuation alone is **not** this ledger.

A dedicated preallocated purse (x402 Exact on a funded test token) is
allocation/balance exposure only. It does not independently enforce
recipient or calendar rules against an unrestricted key holder.

## Safety

- Mainnet chain IDs are hard-denied by `scripts/wallet/lib/deny-mainnet.mjs`.
- Evidence under `docs/evidence/wallet/` must not contain secrets.
- A missing suite fails closed — never treat a stub as a pass.
- `local_execution_verified` requires real local-chain / merchant output, not
  JavaScript imitation of contracts.
- `productionEnabled` remains false for every adapter in this assignment.
