# Wallet protocol compatibility

Companion to [ADR 0123](../adr/0123-wallet-spending-authority.md).
Evidence rule: command output under `docs/evidence/wallet/`.

Every profile has `productionEnabled: false`. Local Anvil/forge is not a
target deployment. Fixture issuer keys are not public merchant trust.

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

| Profile | Mechanism | Intended role | Source pin | Evidence status | `productionEnabled` | Notes |
|---|---|---|---|---|---|---|
| `local-test.direct-erc20-period-delegation` | MetaMask delegation-framework ERC20PeriodTransferEnforcer | Shared-ancestor amount/period; recipient/value/method/expiry composed | `bff4b08f8006ad94322a6e3da8d90f274e20325d` | `local_execution_verified` (forge) | `false` | Direct `transfer` only. Mixed-asset duplicate caveats share one hash — refused at assess. |
| `local-test.x402-exact-eip3009` | x402 Exact + EIP-3009 | Bounded HTTP resource payment + local settlement | `@x402/core@2.26.0` `@x402/evm@2.26.0` | `local_execution_verified` (Anvil 31337, shipped adapter) | `false` | No `upto`, Permit2, allowance, or refill. Purse is allocation exposure, not recipient/calendar enforcement. |
| `ap2-v0.2-es256-local` | AP2/UCP mandate JWTs | Direct-checkout crypto + negative fixtures | `jose@6.2.8` ES256 | `fixture_verified` (fixture-local) | `false` | AP2/UCP algorithm-wording conflict recorded; ES256 only. No public merchant acceptance. No recursive AP2 subdelegation. Signatures are not a budget engine. |
| `tempo.mpp-session` | Tempo / MPP prepaid session | Funded cap, cumulative vouchers | none | `blocked` | `false` | No pinned OSS escrow harness in-repo |
| `tempo.native-permissions` | Tempo TIP-1011 | Per-key limits | none | `blocked` | `false` | Isolated Tempo node not available; source Mainnet label is not target proof |
| `ows.nwc` | OWS / NIP-47 | Optional owner-operated wallet service | none | `blocked` | `false` | Not a browser default; key-file/token model is not a hostile-runtime boundary |
| `cards.metadata-checkout` | Existing-card metadata + user-mediated checkout | Label / last-four / opaque ref | N/A | `fixture_verified` | `false` | No PAN collection |
| `cards.issuer-virtual` | Real issuer-backed virtual card | Adapter contract only | none | `blocked` | `false` | UI/config boolean cannot unlock issuance |

## Consent

Payment approval is digest-bound over executable terms (amount, currency,
recipient) and verified as ES256. Client-written `mechanism: webauthn` or
assurance labels are ignored. Dummy bytes are `signature_invalid`.

## Algorithm / entropy note (AP2/UCP)

UCP currently notes disagreement with AP2 on algorithm and nonce/entropy
wording. This repository pins **ES256** via `jose` and does not invent
signature or nonce primitives to paper over the conflict. Trust is
fixture-local; this is not public merchant acceptance.

## Unavailable capabilities (typed)

| Capability | Result | Reason |
|---|---|---|
| Universal card wrapping / local disposable network card | unavailable | ADR 0123; no authorized issuer |
| Recursive AP2 agent-to-agent payment delegation | unsupported | AP2 v0.2 leaves it out of scope |
| Offline settlement / fabricated balances | refused | Browser-local signing ≠ network settlement |
| Unlimited ERC-20 / Permit2 approvals as spending pass | refused | Out of scope; escape hatch for enforcers |
| Calendar-day mapped to 86400 seconds | `PERIOD_SEMANTICS_UNSUPPORTED` | Duration ≠ calendar |
| Worker as origin isolation for root keys | refused | Same-origin; workers are not a trust boundary |
| Claiming `productionEnabled` from this table alone | refused | Requires `docs/evidence/wallet/` command output |

## Current execution evidence

| Profile | Status | Command evidence |
|---|---|---|
| Conserved local journal (shared_counter) | `fixture_verified` | `CHAIN_ID=31337 pnpm wallet:verify` |
| Digest-bound lease issue (ES256, no forged assurance) | `fixture_verified` | `pnpm wallet:test:browser` |
| ERC-20 restricted transfer (forge) | `local_execution_verified` | `pnpm wallet:test:contracts` |
| x402 exact local merchant (Anvil, shipped adapter) | `local_execution_verified` | `pnpm wallet:test:protocols` |
| AP2/UCP ES256 mandates | `fixture_verified` | `pnpm --filter @opensesame/wallet-mandates test` |
| Prepaid session / Tempo / OWS | `blocked` | No escrow harness |
| Issuer virtual card | `blocked` | No authorized issuer |

## Related

- [ADR 0123](../adr/0123-wallet-spending-authority.md)
- [wallet spending](../operators/wallet-spending.md)
- [wallet threat model](../security/wallet-threat-model.md)
- [protocol conformance](protocol-conformance.md)
