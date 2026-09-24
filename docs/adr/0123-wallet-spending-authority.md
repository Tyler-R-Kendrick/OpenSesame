# ADR 0123 — Payment spending authority is a conserved lease, not a pass adapter or a credential

Status: Accepted (implementation in progress)
Date: 2026-09-15
References:
ADR 0005 ([ConnectionRef over SecretRef](0005-authority-handle-connectionref.md)),
ADR 0017 ([host/client product topology](0017-host-client-product-topology.md)),
ADR 0065 ([agent surface parity](0065-agent-surface-parity.md)),
ADR 0086 ([one interaction primitive](0086-wallet-native-interaction-layer.md)),
ADR 0090 ([static frontend complete without a backend](0090-static-frontend-complete-without-backend.md)),
ADR 0119 ([wallet-native control-plane composition](0119-wallet-native-control-plane-composition.md)),
ADR 0120 ([generalized hierarchical authority](0120-generalized-hierarchical-authority.md)),
ADR 0121 ([durable authority invalidation fencing](0121-durable-authority-invalidation-fencing.md)),
[wallet spending (product overview)](../operators/wallet-spending.md),
[wallet threat model](../security/wallet-threat-model.md),
[protocol compatibility](../reference/wallet-protocol-compatibility.md),
[swarm coordination](../archive/wallet-swarm-coordination.md)

**Implementation is in progress on a dirty tree at baseline `4358f7fe`.**
This ADR records binding product decisions for the Wallet spending programme.
No protocol profile may be marked `local_execution_verified` or
`productionEnabled: true` without command-backed evidence under
`docs/evidence/wallet/`. Compatibility rows start `productionEnabled: false`.

## Context

ADR 0086 already settled two payment-adjacent facts that this programme must
not reopen:

1. A `payment_initiation` authorization detail expresses *permission to
   initiate* a payment-like operation — amount (decimal string), currency,
   payee display — and is digested into the interaction. It is an
   authorization model, not a payment executor.
2. Card data is refused mechanically (`assertNoPaymentCredentials`). OpenSesame
   does not issue cards, provision DPANs, or store PAN/CVV. Touching card data
   would pull the system into PCI DSS scope for no product reason.

`packages/wallet` is the vendor-neutral **pass presentation** adapter for
cross-device interaction references (ADR 0086 §5). It is optional, never on the
approval path, and must not be stretched into card issuance or a spending
ledger.

ADR 0119 wires wallet-native Identity prefixes with honest `501` stubs until
owning swarms land; a surface that settles an interaction on its own is
forbidden. ADR 0120 generalizes hierarchical authority that can only narrow,
including budget conservation on the grant lineage. ADR 0121 fences ancestor
revocation so a dead parent cannot leave a live child.

What is still missing is a product decision for **enforceable spending**: a
lease backed by an identifiable budget allocation, with adapters for
delegated transfer, bounded x402, prepaid sessions, and mandate evidence —
without inventing a second authority model, a second vault, or a fintech
custody platform.

Three things people conflate, and which this ADR keeps separate:

| Question | What answers it |
|---|---|
| **What did a person approve?** | Digest-bound consent over immutable policy, purpose, amount, beneficiary, destination, and authorization context (ADR 0086 / CONSENT). |
| **What still holds if a hostile beneficiary bypasses our UI?** | External enforcement — contract caveats, escrow caps, issuer instrument rules, or an owner-operated ledger that controls the actual execution capability. |
| **What has actually happened?** | Observation — reserved exposure, submitted commitments, settlement, failure, uncertainty, verified refunds. |

A signed mandate is authorization evidence. Aggregate spending needs state at
the executing authority. A protocol name is not an enforcement level.

## Decision

### 1. Spending authority redistributes; it never mints budget

A **spending lease** is a typed projection of existing grant / hierarchical
authority (ADR 0120), tied to a wallet, an allocation, a policy version, a
beneficiary (and actor where applicable), and an effective enforcement
assessment. Temporary passes, delegated token transfers, bounded x402
payments, and prepaid sessions are **execution representations** of that
authority. They are not interchangeable security mechanisms.

> New sessions, subagents, browser profiles, keys, or temporary instruments
> may redistribute existing spending authority. They must not manufacture
> additional budget.

Sibling allocations share a counter or are exclusive. A per-child inequality
alone does not conserve a parent budget. Key or instrument rotation preserves
a stable accounting root; a new identifier alone cannot reset spent exposure.
Parent revocation and fencing follow ADR 0121.

### 2. Approval, external enforcement, and observation stay distinct

- **Approval** records what was consented to. It is digest-bound, one-time
  consumable where the interaction layer applies, and never client-authored
  assurance (ADR 0086 §7; the current interaction approve route's residual
  gaps remain named there until CONSENT closes them).
- **External enforcement** is whatever still applies when OpenSesame's UI is
  skipped. An assessment may report `enforced`, `approval_only`, or
  `unsupported` per constraint. Unsupported *mandatory* constraints refuse;
  switching to approval-only is a new digest, never a silent downgrade.
- **Observation** tracks reserved, pending, settled, failed, and unknown
  outcomes. Preflight success is not settlement. Reorgs, duplicate retries,
  and crash-after-submit leave exposure reserved until reconciled.

`packages/wallet` (passes) remains presentation-only. Payment secret fields
(PAN, CVV, network tokens, seed phrases, root keys) stay out of approval
details, passes, agent tools, URLs, and logs. Existing
`authorization-details` credential refusal is extended, never weakened.

### 3. Browser-local default; OSS first; issuer unavailable by default

Consent, configuration, local key custody where permitted, policy evaluation,
and the primary Wallet UI run in the static Pages PWA (ADR 0090). Boot and
required local journeys must not require a daemon, browser extension, central
Identity server, vendor wallet account, or application API key.

Pinned open-source cryptographic, payment-protocol, and account-contract
implementations are preferred. Mandatory Google Wallet, Apple Pay, Crossmint,
Coinbase CDP, Ramp, Stripe, hosted bundler, proprietary RPC, or WalletConnect
Cloud subscriptions are out. A configured RPC or merchant endpoint is still an
external dependency and is stated as such. Offline review of policy and
pending records is allowed; fabricating authoritative balances or claiming
offline settlement is not.

There is **no universal credit-card wrapping**. Default card UX is metadata
plus user-mediated checkout. A typed virtual-card capability may exist only
as an adapter that reports unavailable until a real issuer integration is
present and evidence-gated. No fake PANs, pretend issuers, bank scraping, or
autofill extraction.

### 4. Sessions are not accounting

`TrustSession`, `VaultSession`, workload identity, a spending lease, and a
provider payment session have different lifecycles. Closing a tab stops local
execution; it does not automatically revoke previously issued external
authority. A tab restart does not reset an allowance.

### 5. Adapters are evidence-gated; production stays off until proven

Protocol adapters (MetaMask-style delegation, x402, AP2/UCP, Tempo sessions,
cards) plug through one broker-shaped boundary. Each advertises evidence
status (`specified` → `source_inspected` → `fixture_verified` →
`local_execution_verified` → `target_deployment_verified`, or `blocked`) and
`productionEnabled`. Initial compatibility rows are documented in
[`docs/reference/wallet-protocol-compatibility.md`](../reference/wallet-protocol-compatibility.md)
with **`productionEnabled: false`**. An activation flag cannot manufacture
deployment evidence or issuer capabilities.

Recursive agent-to-agent payment subdelegation is not invented on top of AP2
v0.2's out-of-scope gap; OpenSesame keeps recursive authority internal
(ADR 0120) and emits only purchase-specific supported evidence.

### 6. Product contracts this programme does not touch

Identity and Host APIs stay separate (ADR 0017). Guest access stays
reachable. Agent tools register through `packages/capability-registry`
(ADR 0065) with no raw root-key, PAN, generic signing, or arbitrary paid-fetch
capability. Wallet-native mounts remain composition-honest (ADR 0119).

## Out of scope (condensed)

This assignment does **not** include: general-purpose virtual-card issuance;
card vaulting; bank-site automation or screen scraping; universal
payment-handler injection; a mandatory browser extension; automated
credit-card onramps; exchange trading; NFT support; arbitrary DeFi calls;
unlimited ERC-20 / Permit2 approvals; automatic multi-chain bridging;
calendar-aware on-chain recurring contracts invented from scratch; trusted
hardware claims without hardware evidence; a custody service; a new root
identity system; production compliance / PCI certification; moving real
funds, mainnet activity, or vendor enrollment; or silent security downgrade
via protocol fallback.

Ambient authority outside delegated leases (unrelated saved merchant cards,
paid API keys, unrestricted root wallet keys) is disclosed as a coverage
boundary, not claimed as governed.

## Consequences

- Spending becomes expressible as conserved allocations and leases on the
  existing authority lineage, without a second AccessLease engine or a
  repurposed pass package.
- UI, agents, and docs must speak in requested-versus-effective enforcement
  and evidence status — not brand names as guarantees.
- Residual risks (hostile same-origin code, unrestricted purse keys, merchant
  cooperation for recovery, local-only ledger tamper resistance) are named in
  the threat model rather than papered over.
- No test, build, or protocol execution evidence is claimed by this ADR alone.
  Compatibility and claim matrices stay honest until swarms land command
  output under `docs/evidence/wallet/`.

## Related

- [wallet spending overview](../operators/wallet-spending.md)
- [wallet threat model](../security/wallet-threat-model.md)
- [wallet protocol compatibility](../reference/wallet-protocol-compatibility.md)
- [wallet swarm coordination](../archive/wallet-swarm-coordination.md)
- [wallet interaction layer](../architecture/wallet-interaction-layer.md)
