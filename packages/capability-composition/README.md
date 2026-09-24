# @opensesame/capability-composition

Pure, browser-safe capability composition for the Client plane: capability and
module identities, the policy documents each scope writes, the deterministic
resolver that turns them into an effective plan, reason codes, and consent
deltas and receipts. It does no I/O; the same input in any order produces the
same plan and the same digest.

## Where it fits

- **Used by:** [`packages/app-core`](../app-core) (the capability store,
  loader and leases in `src/lib/capabilities/`) and
  [`apps/pages`](../../apps/pages) (the capability build and the bootstrap).
- **Builds on:** [`@opensesame/os-domain`](../os-domain) and `@noble/hashes`
  for SHA-256.
- Core is always approved. An optional capability is approved only when it is
  distributed, permitted by every scope, runtime-supported, network-allowed,
  selected (or pulled in by a clean root), covered by a consent receipt, and
  served by a single worker variant (`src/resolve.ts`).
- A consent receipt covers a capability per exposure digest: a changed
  dependency, egress class or permission drops it back to `CONSENT_REQUIRED`.
- `"sideEffects": false`.

## Surface

| Area | Exports |
|---|---|
| Identities (`ids.ts`) | `isCapabilityId`, `isModuleId`, `isOpaqueId`, `moduleCapability`, `compareIds`, `sortIds`, length limits |
| Digests (`canonical.ts`) | `canonicalize`, `digestOf`, `planDigest`, `exposureDigest`, `receiptDigest`, `sha256Hex` |
| Catalog (`catalog.ts`) | `buildCatalog`, `indexCatalog`, `validateCatalog` |
| Documents | `parseInstancePolicy`, `parseWorkspaceRestriction`, `parseInstallationSelection`, `parseVaultSelection`, `parseDistributionContract`, `parseConsentReceipt` |
| Resolution | `resolveComposition`, `explainCapability`, `diagnoseRuntimeDocuments`, `reviewCompositionChange` |
| Consent | `computeConsentDelta`, `buildConsentReceipt`, `consentCandidatesOf` |
| Reasons and diagnostics | `REASON_CODES`, `BLOCKING_REASONS`, `sortReasons`, `DIAGNOSTIC_CODES` |
| Fixtures | `FIXTURE_CATALOG`, `FIXTURE_POLICIES`, `fixtureResolveInput` … for tests in dependents |

## Develop

```bash
pnpm --filter @opensesame/capability-composition test
pnpm --filter @opensesame/capability-composition typecheck
```

A change to the resolver or a document parser also affects the Pages
capability build: run `pnpm --filter @opensesame/pages build:profile` and
`verify:capability-graph` as AGENTS.md §5 requires.

## Related

- [ADR 0130](../../docs/adr/0130-operator-controlled-capability-composition.md)
  — operator-controlled capability composition
- [ADR 0135](../../docs/adr/0135-always-on-capabilities-and-feature-rollups.md)
  — always-on capabilities and feature rollups
- [Operator guide](../../docs/operators/capability-composition.md) ·
  [Verification method](../../docs/validation/capability-composition.md)
