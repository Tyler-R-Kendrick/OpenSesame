# Wallet protocol compatibility (skeleton)

Companion to [ADR 0123](adr/0123-wallet-spending-authority.md).
Evidence rule: [swarm coordination](wallet-swarm-coordination.md).

Statuses below are **honest placeholders**. No row claims
`local_execution_verified` or `target_deployment_verified` without command
output under `docs/evidence/wallet/`. Every profile starts with
`productionEnabled: false`.

## Evidence status vocabulary

| Status | Meaning |
|---|---|
| `specified` | Profile described; no source pin exercised yet |
| `source_inspected` | Upstream source/docs inspected at a recorded commit/version |
| `fixture_verified` | Cryptographic or structural fixtures pass in-repo |
| `local_execution_verified` | Real local chain/counterparty/browser run recorded |
| `target_deployment_verified` | Configured non-fixture deployment verified |
| `blocked` | External or source gap; unavailable with reason |

## Profiles

| Profile | Mechanism | Intended role | Source pin (initial) | Evidence status | `productionEnabled` | Notes / blockers |
|---|---|---|---|---|---|---|
| `delegation.erc20-transfer` | MetaMask-style delegation / enforcer (direct ERC-20 transfer) | Shared-ancestor amount/recipient/time where composed | Inspect candidate: MetaMask delegation-framework `bff4b08f…` (hypothesis only; re-pin before activate) | `specified` | `false` | Direct-transfer profile only; do not compose Permit2/x402/channel deposits without evidence |
| `x402.exact` | x402 exact payment | Bounded HTTP resource payment + local settlement | *unset — pin OSS SDK/mechanism before activate* | `specified` | `false` | No default `upto`, Permit2, or allowance path |
| `ap2-ucp.direct-checkout` | AP2 / UCP mandate evidence | Direct-checkout crypto + negative fixtures vs local counterparty | *unset — pin schemas; record AP2/UCP algorithm wording conflict* | `specified` | `false` | No public merchant-acceptance claim; no recursive AP2 subdelegation |
| `tempo.mpp-session` | Tempo / MPP prepaid session | Funded cap, cumulative vouchers, closure/recovery | *unset — compare with x402 batch; choose or dual-implement with record* | `specified` | `false` | Local lease expiry ≠ voucher cancel; keep unavailable until escrow proven |
| `tempo.native-permissions` | Tempo TIP-style per-key limits | Capability descriptor + tests if isolated node available | *unset* | `specified` | `false` | Per-key ≠ org-wide cap; `Mainnet` label ≠ verified target |
| `cards.metadata-checkout` | Existing-card metadata + user-mediated checkout | Label / network / last-four / opaque ref; assisted open | N/A (product path, not issuer) | `specified` | `false` | No PAN collection; return from merchant ≠ verified payment unless integration proves it |
| `cards.issuer-virtual` | Real issuer-backed virtual card | Adapter contract only until issuer present | *none authorized* | `blocked` | `false` | Issuer unavailable by default; UI boolean cannot unlock; no fake PANs |

## Runtime / deployment tuples

| Tuple id | Environment | Profiles eligible | Recorded run | Status |
|---|---|---|---|---|
| `local-test.unconfigured` | Deterministic local fixtures (orchestrator-owned) | none activated | — | `specified` |
| `static-pages.guest` | `apps/pages` static / guest Wallet review | metadata / local approval only | — | `specified` |
| `production.*` | Any hosted production | — | — | `blocked` — no production activation in this foundation stub |

## Unavailable capabilities (typed)

| Capability | Result | Reason |
|---|---|---|
| Universal card wrapping / local disposable network card | unavailable | ADR 0123; no authorized issuer |
| Recursive AP2 agent-to-agent payment delegation | unsupported | AP2 v0.2 leaves it out of scope; keep authority internal (ADR 0120) |
| Offline settlement / fabricated balances | refused | Browser-local signing ≠ network settlement |
| Unlimited ERC-20 / Permit2 approvals as spending pass | refused | Out of scope; escape hatch for enforcers |
| Claiming `productionEnabled` from this table alone | refused | Requires `docs/evidence/wallet/` command output |

## Example evidence record shape (illustrative only)

```json
{
  "claimId": "wallet.shared-period-token-cap",
  "profileId": "local-test.direct-erc20-delegation",
  "scope": "one configured chain, asset, account and shared ancestor",
  "status": "specified",
  "assumptions": [],
  "constraints": ["amount", "fixed-interval"],
  "evidenceRefs": [],
  "productionEnabled": false
}
```

This schema example is **not** evidence that a test passed.

## Related

- [ADR 0123](adr/0123-wallet-spending-authority.md)
- [wallet spending](wallet-spending.md)
- [wallet threat model](security/wallet-threat-model.md)
- [protocol conformance](protocol-conformance.md)


## Current execution evidence (2026-09-15 dirty tree)

| Profile | Status | Command evidence |
|---|---|---|
| Conserved local journal (shared_counter) | `fixture_verified` | `CHAIN_ID=31337 pnpm wallet:verify` |
| Digest-bound lease issue (no forged assurance) | `fixture_verified` | `pnpm wallet:test:browser` |
| ERC-20 restricted transfer (Anvil) | `blocked` | Foundry/Anvil not installed; simulation only |
| x402 exact local merchant | `blocked` | No pinned x402 SDK / facilitator harness |
| Issuer virtual card | `blocked` | No authorized issuer |
