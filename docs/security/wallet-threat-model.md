# Threat model — Wallet spending authority (stub)

Companion to [ADR 0123](../adr/0123-wallet-spending-authority.md).
Product overview: [wallet spending](../operators/wallet-spending.md).
Compatibility evidence: [protocol compatibility](../reference/wallet-protocol-compatibility.md).

This is an **initial stub**: enough structure to extend as adapters land.
Do not treat rows below as completed reviews or as proof that a profile is
safe in production. Reproductions and evidence refs stay empty until a
command under `docs/evidence/wallet/` records them.

## Scope

In scope: browser-local Wallet workspace, budget allocations and spending
leases, digest-bound consent, protocol adapters (delegation, x402, AP2/UCP,
Tempo sessions, card metadata / issuer adapters), agent proposal tools, and
observation/reconciliation of payment attempts.

Out of scope for this model (see ADR 0123): universal card issuance, bank
scraping, mandatory vendor wallets, mainnet/real-funds operations, and
ambient authority that never entered a lease.

## Assets

| Asset | Why it matters |
|---|---|
| Budget allocations and remaining capacity | Minting or double-allocating is direct loss of the conserved-budget invariant |
| Spending leases and their policy digests | Binding between approval and executable terms |
| Reserved / pending exposure | Crash or retry must not invent a second charge |
| Constrained workload / delegate keys | Abuse should remain within independently enforced limits |
| Root / funding keys and recovery destinations | Compromise is full purse or treasury exposure |
| Approval proofs and assurance records | Forged assurance is worse than no record (ADR 0086 §7) |
| Merchant / resource binding for HTTP payments | Wrong binding turns a valid signature into payment for the attacker |
| Escrow deposits and signed vouchers | Overclaim or double-count drains the channel |
| Card metadata and opaque instrument refs | Must never widen into PAN/CVV collection |
| Local journal / observation log | Tampering undercuts reconciliation honesty |

## Attackers / actors

- Compromised same-origin page script or malicious extension in the Wallet
  origin (Workers are not an independent key boundary)
- Hostile beneficiary holding a delegated key or payment session
- Malicious or compromised merchant / facilitator / RPC
- Sibling workloads racing shared parent capacity
- Agent / MCP client asking for root signing, PANs, or arbitrary paid fetch
- Child or low-privilege principal escalating budget, recovery, or clock
- Operator misconfiguration that flips `productionEnabled` without evidence
- External observer of notifications, QR/pass references, or logs (references
  authorize nothing; payloads must stay secret-free)

## Trust assumptions

1. **Owner root is not compromised** for claims that depend on root honesty.
2. **Independent enforcement** (contract, escrow, issuer, owner-operated
   ledger that controls execution) is required before advertising hard
   amount/recipient/time limits against a bypass of the OpenSesame UI.
3. **Browser-local ledger consistency** is not cross-device or hostile-owner
   tamper resistance; disclose that when the mode is local-only.
4. **Non-extractable WebCrypto keys** limit export; they are not a spending
   policy and do not imply hardware-backed chain signing.
5. **Pinned OSS bytecode / SDK digests** match what was assessed; upgrades
   invalidate evidence until re-verified.
6. **Fixture issuer trust is local** until a real merchant/network trust
   root is configured and verified.
7. **ADR 0121 fencing** (or equivalent) applies to revoked ancestor spending
   authority; pending revocation must not be labeled complete.

## Trust boundaries (sketch)

```
  owner consent (digest-bound)     local broker / Pages origin
           │                                │
           ▼                                ▼
  approval proof ──► lease + reservation ──► adapter.prepare / execute
                                              │
                     ════════ external enforcement boundary ════════
                                              │
                         chain / escrow / issuer / owner service
                                              │
                     ════════ observation boundary ════════
                                              │
                         receipts, unknowns, refunds, reorgs
```

Possession of an interaction reference, pass barcode, or agent tool handle
is not spending authority (ADR 0086 §3; ADR 0119).

## Entry points to review as code lands

| Entry | Primary risks |
|---|---|
| Wallet UI forms / approval sheet | Digest mismatch, silent downgrade, unsafe rendering of merchant text |
| Exact-origin signer channel | Wrong window, replay, null origin, oversized messages |
| Agent / WebMCP `wallet.*` tools | Capability sprawl, secret leakage, settlement verbs |
| Delegation / enforcer contracts | Alternate executors, ERC-1271 read-only "consumption", sibling races |
| x402 / HTTP payment headers | CORS gaps, redirect credential forwarding, `upto`/Permit2 fallback |
| Prepaid session / voucher path | Overclaim, lease-expiry misreported as voucher cancel |
| AP2/UCP / VI verifiers | Issuer substitution, constraint stripping, signature-as-budget |
| Card / issuer adapter | Fake PAN paths, UI boolean unlocking issuance |
| Journal reconcile APIs | Double-count refunds/vouchers, optimistic success |

## Residual risks (stated plainly; extend, do not delete)

1. **Unrestricted purse key.** A preallocated purse bounds *allocation
   exposure* only. Whoever holds the unrestricted key can spend the purse
   balance; recipient/period claims are not independently enforced unless a
   different profile says so with evidence.

2. **Approval without external enforcement.** `approval_only` constraints
   stop cooperative UI paths; they do not stop a beneficiary who already
   holds broader ambient funds.

3. **Local storage hostility.** Clearing, cloning, or editing beneficiary
   browser storage can confuse local accounting; independent on-chain or
   service enforcement is what remains bounded.

4. **Merchant-dependent recovery.** Some escrow/refund paths need merchant
   or facilitator cooperation; delays and unilateral options must be shown
   honestly when tested.

5. **Same-origin compromise.** A malicious script in the Wallet origin can
   abuse whatever signing material that origin can reach. Route or Worker
   separation is not a second origin.

6. **Evidence lag.** Compatibility rows may remain `source_inspected` or
   `blocked` while core Wallet UX works. Marketing language must not leap
   ahead of the matrix.

## Reproductions

| ID | Status | Notes |
|---|---|---|
| *(none yet)* | — | Add WAL-* adversarial cases with command output refs as swarms land |

## Related

- [ADR 0123](../adr/0123-wallet-spending-authority.md)
- [ADR 0086](../adr/0086-wallet-native-interaction-layer.md)
- [notification approval threat model](notification-approval-threat-model.md)
- [base threat model](threat-model.md)
