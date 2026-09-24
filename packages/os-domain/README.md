# @opensesame/os-domain

The canonical OpenSesame domain model, at the bottom of the TypeScript
dependency graph. It holds the types and pure state machines every other
package speaks in: principals and assurance levels, authorization requests,
claims, device authorization, interactions and presentations, notifications,
trust, access domains and authority grants, wallet payment intents, duress
types and transport-security contracts. Canonical principals live here, not in
Better Auth user ids.

## Where it fits

- **Used by:** nearly every TypeScript package and app in the workspace
  (Identity, Client and SDK packages, `packages/control-plane`, `apps/pages`, the
  MCP servers, the examples and the test suites).
- **Builds on:** nothing. It has no runtime dependencies.
- It **must not** import Better Auth, oidc-provider, Hono, Drizzle or React
  ([CONTRIBUTING.md](../../CONTRIBUTING.md), AGENTS.md §5).
- The browser entry (`src/browser.ts`, chosen by the `browser` export
  condition) leaves out the Node HMAC and digest helpers so Pages, the PWA and
  the extension never pull `node:crypto`; it uses `crypto/digest-browser.ts`
  instead. `crypto/interaction-ref.ts` is Node-only.
- The transport-security types mirror the Rust `opensesame_domain::transport`
  module; the zod wire schemas for them live in
  [`@opensesame/contracts`](../contracts).

## Surface

| Entry | What it holds |
|---|---|
| `@opensesame/os-domain` | Everything below, plus the Node crypto helpers |
| `@opensesame/os-domain` (browser condition) | The browser-safe subset |
| `@opensesame/os-domain/wallet` | Amounts, payment intents and wallet errors |
| `@opensesame/os-domain/authority-templates` | Audience templates and their parser |

| Area (`src/`) | What it holds |
|---|---|
| `types.ts`, `errors.ts`, `json.ts`, `invariants.ts` | Core types (`PrincipalId`, `AssuranceLevel`, `ExternalIdentity` …), `DomainError`, JSON guards (`isJsonObject`, `readString`, `overlapCast` …), invariant checks |
| `machines/` | State machines: authorization request, claim, device auth, interaction, presentation, provisional resource, agent registration |
| `crypto/` | Claim tokens and user codes, agent-auth tokens, manifest and request digests, interaction references and digests |
| `interaction*.ts`, `approval-ceremony.ts`, `presentation.ts` | The cross-device interaction envelope and approval proof binding |
| `notifications.ts`, `trust.ts` | Channel kinds and the closed capability record, settlement evaluation, trust and assurance |
| `access-domain/`, `authority-*.ts`, `permission-*.ts`, `authorization-details.ts`, `cohort/` | Realms and access domains, generalized authority grants, membership lineage, permission scopes |
| `wallet/`, `duress/`, `transport-security/` | Payment intents, duress semantic types, transport policy, bindings, selectors and status views |

`fixtures` (from `src/__tests__/fixtures.ts`) is also exported from the main
entry for tests in dependents.

## Develop

```bash
pnpm --filter @opensesame/os-domain test
pnpm --filter @opensesame/os-domain typecheck
```

`src/__tests__/browser-entry.test.ts` covers the browser entry. A change here
reaches almost every package; run `pnpm quality:packages` to see the
dependency picture.

## Related

- [ADR 0017](../../docs/adr/0017-host-client-product-topology.md) (topology),
  [ADR 0084](../../docs/adr/0084-external-authorization-notifications.md)
  (notification channels),
  [ADR 0086](../../docs/adr/0086-wallet-native-interaction-layer.md)
  (interactions and approval proofs),
  [ADR 0120](../../docs/adr/0120-generalized-hierarchical-authority.md)
  (generalized authority),
  [ADR 0132](../../docs/adr/0132-optional-mtls-and-workload-identity.md)
  (transport contracts)
