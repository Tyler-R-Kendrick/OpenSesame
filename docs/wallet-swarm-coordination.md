# Wallet spending — swarm coordination

**Checkout HEAD (directive baseline):** `4358f7feacee97468b17abdd9b5ccc02c81ee68d`  
**Working tree:** dirty (pre-existing feature work present; do not reset)  
**Next ADR:** `0123-wallet-spending-authority`

## Invariant

> New sessions, subagents, keys, or temporary instruments may redistribute existing spending authority. They must not manufacture additional budget.

## Ownership (concurrent)

| Swarm | Owner focus | Shared contract |
|-------|-------------|-----------------|
| DOM | `packages/os-domain/src/wallet/` | AmountUnits, leases, intents |
| POL | `packages/wallet-policy` | ConstraintEnforcement |
| LEDGER | `packages/wallet-budget` | Journal / reserve API |
| CONSENT | `packages/wallet-consent` | Digest-bound approval |
| UI | `apps/pages` `/wallet` | Guest-safe section |
| REGISTRY/AGENT | capability-registry + webmcp | wallet.* capabilities |
| DOCS | ADR 0123 + threat/compat | Claim truthfulness |
| BUILD | `scripts/wallet/` + pnpm scripts | Fail-closed verify |

## Evidence rule

No claim may be marked `local_execution_verified` or `productionEnabled: true` without command output under `docs/evidence/wallet/`. Placeholders stay `blocked` or `specified`.

## Forbidden

Real funds, mainnet, vendor enrollment, fake PANs, silent security downgrade, BFF merge of Identity/Host.
