# @opensesame/trust-broker

The one evaluator for "may this approval stand?" on the Identity plane. It
checks held identity evidence and authentication facts against an
`AssuranceRequirement`, and composes that with channel settlement and
transaction-bound activation into a single approval decision. The
authorization inbox, provider callbacks and the in-app ceremony all settle
through it.

## Where it fits

- **Used by:** [`packages/control-plane`](../../packages/control-plane) (`routes/authorization-requests.ts`, `routes/notification-callbacks.ts`).
- **Builds on:** [`@opensesame/os-domain`](../os-domain) — `evaluateDirectSettlement`, `evaluateActivation`, `channelAuthenticationCeiling`, `normalizeApprovalPolicy` and the assurance types all live there.
- `evaluateApprovalCeremony` requires all three of: the channel may carry a decision (settlement), the person met the bar (assurance), and the proof is bound to this transaction and unspent (activation). None stands in for another, and absent evidence is a refusal.
- A channel is credited with its capability ceiling, never with what a provider callback asserts about itself; only an in-app activation supplies its own authentication facts.
- The approver must be the principal the request is addressed to (`approver_mismatch`).

## Surface

| Export | What it does |
|---|---|
| `evaluateAssurance({ evidence, authentication, trustSession, requirement, now })` | `AssuranceDecision`: `allowed`, `satisfied`, `missing`, the evidence ids used, `reasonCodes`, `legacyProjection` |
| `projectLegacy(vector, auth)` | Projects an assurance vector onto the legacy `AssuranceLevel` ladder |
| `evaluateApprovalCeremony(input)` | `ApprovalCeremonyDecision`: `allowed`, `refusals`, `assurance`, `required`, `achieved` |
| `requiredReasonCodes(policy)` | The bar as reason codes, for the receipt |
| `ApprovalRefusal` | Settlement and activation refusals plus `assurance_insufficient`, `channel_cannot_meet_assurance`, `approver_mismatch` |

## Develop

```bash
pnpm --filter @opensesame/trust-broker test
pnpm --filter @opensesame/trust-broker typecheck
```

## Related

- [ADR 0084](../../docs/adr/0084-external-authorization-notifications.md) — external authorization notifications; one evaluator
- [ADR 0086](../../docs/adr/0086-wallet-native-interaction-layer.md) — approval proofs bound to a request digest
- [Notification approval threat model](../../docs/security/notification-approval-threat-model.md)
- [`packages/policy`](../policy) — which approval mechanism may back which assurance
