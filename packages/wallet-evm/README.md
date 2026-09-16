# `@opensesame/wallet-evm`

Payment-adapter foundation for Swarm EVM (wallet spending). Pure TypeScript
until BUILD ships a local-chain harness.

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
(in-memory shared-ancestor counter). That is **not**
`local_execution_verified` on-chain. Real Foundry/Anvil deployment remains
blocked until anvil/forge is available in the environment.

## Simulation mode (unit tests only)

`directErc20Delegation` may run with `mode: "simulation"` and an in-memory
shared-ancestor counter. That path demonstrates overspend rejection semantics
in pure TS. It is **NOT contract verification** and must not be reported as
on-chain enforcement.
