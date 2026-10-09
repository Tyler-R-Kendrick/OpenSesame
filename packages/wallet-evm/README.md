# `@opensesame/wallet-evm`

Payment-adapter foundation for EVM wallet spending
([ADR 0123](../../docs/adr/0123-wallet-spending-authority.md)): the
`AdapterManifest` / `PaymentAdapter` boundary types and a direct ERC-20
delegation adapter, `createDirectErc20DelegationAdapter`. The source is pure
TypeScript. The adapter's live mode stays fail-closed (its readiness is
`awaiting_harness`); the Solidity enforcer tests in `forge/test/` run through
`pnpm wallet:test:contracts`, not through this package's TypeScript.

## Candidate pin (not a deployment certificate)

MetaMask [delegation-framework](https://github.com/MetaMask/delegation-framework)
commit **`bff4b08f8006ad94322a6e3da8d90f274e20325d`** is the inspected candidate
source for direct `ERC20.transfer` period limiting and ancestor caveat
invocation (`ERC20PeriodTransferEnforcer.sol`, `DelegationManager.sol`).

Inspect the release/audit relationship before choosing a final pin. Naming this
commit is `source_inspected` evidence at most — never
`local_execution_verified` or `productionEnabled: true` without command output
under `docs/evidence/wallet/`.

## Contract tests

`pnpm wallet:test:contracts` runs this package's Vitest **simulation** suite
(in-memory shared-ancestor counter), then the Foundry suites in `forge/test/`
(`SiblingSharedPeriodCap`, `WalE04MixedAssetCaveat`, `WalE05RecipientAndValue`,
`WalE06E09MethodAndExpiry`) and the upstream `ERC20PeriodTransferEnforcerTest`,
against a clone of the delegation-framework at the pin under the git-ignored
`vendor/delegation-framework` (see
[`scripts/wallet/contracts-harness.mjs`](../../scripts/wallet/contracts-harness.mjs)).
It needs `forge` and `anvil` on `PATH` and fails, never skips, when they are
missing; mainnet chain ids are denied. The Vitest suite is **not**
`local_execution_verified`. A green forge run is what records
`local_execution_verified` in `docs/evidence/wallet/claims.json`, scoped to
those enforcer suites on a local chain, with `productionEnabled` still false.

## Simulation mode (unit tests only)

The `directErc20Delegation` adapter may be created with
`mode: { kind: "simulation", enforcer }`, where `enforcer` is an
`InMemorySharedAncestorCounter`. That path demonstrates overspend rejection semantics
in pure TS. It is **NOT contract verification** and must not be reported as
on-chain enforcement.
