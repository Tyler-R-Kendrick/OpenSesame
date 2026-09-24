# @opensesame/policy

Authorization policy for the Identity plane: the provisional-principal PEP,
the table of which approval mechanism may back which assurance, the auth.md
AgentAuth scopes, and the mapping from an `AuthorityGrant` onto OpenFGA tuple
keys. Every export is a pure function or a small class over `os-domain`
types; nothing here does I/O.

## Where it fits

- **Used by:** [`apps/control-plane`](../../apps/control-plane) — `ProvisionalPolicy` in `create-app.ts`, the AgentAuth services, and the interaction activation and settlement routes.
- **Builds on:** [`@opensesame/os-domain`](../os-domain) (`Principal`, `AssuranceLevel`, `ApprovalMechanism`, `AuthorityGrant`).
- High-risk actions (`organization.delete`, `principal.merge`, `grant.export_raw_credential`, `admin.impersonate`, …) are denied for every subject; a provisional principal may only take the actions in its allowlist, within quota.
- Only a WebAuthn assertion or a holder-key-bound OpenID4VP presentation may carry phishing-resistant assurance. A route consults this table before sealing an `ApprovalProof`, so an incoherent pairing is refused rather than written.
- Tuple mapping is additive only and never authority: it refuses a revoked grant or a cohort grantee and never derives a wider relation than the grant's actions justify. Live writes stay on the Host projector; the backfill module only plans.

## Surface

| Module | Exports |
|---|---|
| `provisional.ts` | `ProvisionalPolicy`, `quotaFieldFor`, `DEFAULT_PROVISIONAL_QUOTA`, `DEFAULT_VERIFIED_QUOTA`, `AuthorizationRequest` / `AuthorizationDecision` (shaped for a future AuthZEN seam) |
| `approval-mechanisms.ts` | `isPhishingResistantMechanism`, `mechanismSatisfies`, `assertAssuranceCoherent`, `IncoherentAssuranceError`, `interactionRequiresPhishingResistance`, `mechanismPermittedForKind` |
| `agent-auth-scopes.ts` | `AGENT_AUTH_SCOPES`, `AGENT_AUTH_SCOPE_ACTIONS`, `DEFAULT_PRE_CLAIM_SCOPES` / `DEFAULT_POST_CLAIM_SCOPES`, `parseScopeParameter`, `intersectAgentAuthScopes`, `scopesForRegistrationState`, `evaluateAgentAuthScopes` |
| `authority-tuples.ts` | `grantToOpenFgaTuples`, `OpenFgaTupleKey` (matches `provider-openfga`'s `TupleKey`) |
| `authority-tuple-backfill.ts` | `planGrantTupleBackfill`, `planRealmTupleBackfill`, `planTupleBackfillRollback` — dry-run plans |

## Develop

```bash
pnpm --filter @opensesame/policy test
pnpm --filter @opensesame/policy typecheck
```

Tests live in `src/__tests__/`, including PACT suites built on
[`@opensesame/testing`](../testing). The OpenFGA model the tuples target is
[`spec/openfga/model.fga`](../../spec/openfga/model.fga).

## Related

- [ADR 0046](../../docs/adr/0046-relayed-execution-and-authorization-inbox.md) — relayed execution; cites the high-risk action set
- [ADR 0084](../../docs/adr/0084-external-authorization-notifications.md) and [ADR 0086](../../docs/adr/0086-wallet-native-interaction-layer.md) — assurance and approval proofs
- [ADR 0125](../../docs/adr/0125-wallet-native-proof-admission.md) — wallet-native proof admission
- [OpenFGA tuple backfill](../../docs/implementation/general-authority/openfga-tuple-backfill.md)
