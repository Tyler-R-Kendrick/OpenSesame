# @opensesame/contracts

Zod request and response schemas for the wire, shared by the servers and their
clients. The Identity API (`apps/control-plane`) and its clients read the
principal, project, agent, claim, OAuth-client, interaction and notification
schemas; the Host API client reads the connection, secret-config, sync-target,
TaskBus and transport-security schemas. It also holds the duress policy
compiler and its YAML/JSON import and export.

## Where it fits

- **Used by:** [`apps/control-plane`](../../apps/control-plane),
  [`packages/api-client`](../api-client), [`packages/app-core`](../app-core),
  [`apps/pages`](../../apps/pages), [`examples/agent`](../../examples/agent),
  [`tests/redteam`](../../tests/redteam) and the Jazzer.js targets in
  [`tests/fuzz/jazzer`](../../tests/fuzz/jazzer).
- **Builds on:** [`@opensesame/os-domain`](../os-domain) (scalar grammars and
  domain types), `zod` and `yaml`.
- The transport-security schemas mirror `opensesame_domain::transport` and
  share one JSON corpus with the Rust plane:
  [`fixtures/transport-security/`](fixtures/transport-security) (`valid/`,
  `invalid/`), read by
  [`crates/domain/src/transport/corpus_tests.rs`](../../crates/domain/src/transport/corpus_tests.rs).
  Every object is `.strict()`, timestamps are RFC 3339 with an offset, and
  nothing coerces.
- `"sideEffects": false`.

## Surface

| Entry | What it holds |
|---|---|
| `@opensesame/contracts` | Every schema module re-exported from `src/index.ts`: `principals`, `projects`, `agents`, `agent-auth`, `organizations`, `oauth-clients`, `claims`, `authorization-requests`, `interactions`, `transaction`, `audit`, `trust`, `notifications`, `webhooks`, `authentication-service`, `authority-grant`, `local-access-requests`, `federated-providers`, `connections`, `secret-configs`, `sync-targets`, `sync_blobs`, `taskbus` (plus `taskBusOpenApi`), `transport-security` |
| `@opensesame/contracts/duress` | The duress policy schema, `compileDuressPolicy`, `dryRunDuressPolicy`, `parseDuressWire`, `serializeDuressPolicy`, `importDuressPolicyPreview`, `diffDuressPolicies`, scenarios and attack trees; test data under `src/duress/testdata/` |

## Develop

```bash
pnpm --filter @opensesame/contracts test
pnpm --filter @opensesame/contracts typecheck
```

A change to a transport-security schema needs the matching fixture in
`fixtures/transport-security/` and the Rust corpus test to agree.

## Related

- [ADR 0132](../../docs/adr/0132-optional-mtls-and-workload-identity.md) —
  optional mTLS and workload identity (transport-security contracts)
- [ADR 0130 (duress)](../../docs/adr/0130-duress-profiles-trust-boundaries.md)
  and [ADR 0131](../../docs/adr/0131-duress-profiles.md) — duress profiles
- [ADR 0017](../../docs/adr/0017-host-client-product-topology.md) — the Host
  and Identity APIs stay separate
