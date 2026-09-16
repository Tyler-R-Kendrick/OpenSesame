# Wallet BUILD gates

Fail-closed verification for ADR 0123 spending authority. Never point these at
mainnet or real funds. Default `CHAIN_ID=31337` for local Anvil/forge suites.

Requires Foundry (`forge`/`anvil`) on `PATH` (e.g. `~/.config/.foundry/bin`).

## Commands

```bash
CHAIN_ID=31337 pnpm wallet:verify   # domain + contracts + protocols + browser + security
pnpm wallet:verify -- --dry-run     # discovery only (still ok=false)
pnpm wallet:test:domain             # os-domain wallet + wallet-budget + wallet-policy
pnpm wallet:test:contracts          # forge enforcer suites + wallet-evm Vitest
pnpm wallet:test:protocols          # Anvil Exact EIP-3009 settle + x402/consent fixtures
pnpm wallet:test:browser            # Pages Wallet vitest + Playwright QAB (incl. B03/B05)
pnpm wallet:test:security           # domain targets + deny-mainnet + wallet-evm
pnpm wallet:evidence:blocked-adapters
```

## Honesty

| Suite | What runs today | Not claimed |
|---|---|---|
| contracts | `forge` MetaMask pin `bff4b08` enforcer suites (WAL-E01–E06/E09) | `productionEnabled` / target deployment |
| protocols | Anvil Exact EIP-3009 settle + replay refuse (WAL-E11/E13/E14) | Live merchant/mainnet facilitator |
| browser | Vitest + Playwright static QAB-01/03 + WAL-B03/B05 | Full SW-update / SR matrix (B09/B20) |
| security | Conservation + policy + domain + mainnet deny | Hostile-owner / cross-device money |

`local_execution_verified` is written into `docs/evidence/wallet/claims.json` only
after the corresponding harness exits 0. Stubs never pass. Mainnet chain IDs
are hard-denied by `lib/deny-mainnet.mjs`.
