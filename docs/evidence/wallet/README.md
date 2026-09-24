# Wallet spending authority — verification evidence

Machine-readable evidence for [ADR 0123](../../adr/0123-wallet-spending-authority.md),
written by the harness in [`scripts/wallet/`](../../../scripts/wallet/README.md)
(`pnpm wallet:verify`, `pnpm wallet:evidence`). Nothing here is claimed for
mainnet or production: every row that is not backed by a harness run says so.

| File | What it records |
|---|---|
| `claims.json` | The claim registry: one row per requirement (`WAL-*`) with its status on the ladder `specified` → `source_inspected` → `fixture_verified` → `local_execution_verified` → `target_deployment_verified`, and the commands that back it. |
| `last-run.json` | The most recent `pnpm wallet:verify`: commit, suites run, pass/fail, and the mainnet denial check. |
| `adapters/` | Adapters that are deliberately blocked (payment channels, mandates) and why. |
| `interaction-evidence.json`, `native-completion-evidence.json` | Requirement-to-test evidence for the wallet-native interaction layer ([traceability](../../validation/wallet-interaction-traceability.md)). |
| `QAB_01_wallet.png`, `WAL_B03_B05_passes.png` | Browser captures from the Pages Wallet journeys. |
