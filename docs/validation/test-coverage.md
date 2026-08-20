# Test coverage

OpenSesame uses complementary test types rather than treating line coverage as
a proxy for security. The commands below are local, deterministic gates unless
they explicitly require a live service.

| Test type | Evidence | Command |
| --- | --- | --- |
| Atomic unit | Vitest suites in 38 TypeScript workspaces; Rust unit tests across the workspace | `pnpm test`; `cargo +1.88.0 test --workspace --all-targets` |
| Snapshot / characterization | Vitest snapshots in `packages/agent-protocols`; Playwright pixel baselines in `packages/visual-contract` | `pnpm --filter @opensesame/agent-protocols test`; `pnpm test:visual` |
| Contract | OpenAPI/WIT schemas and PACT transport/adversarial suites documented in `pact.md` | `pnpm test:integration`; `pnpm test:task-access` |
| Chaos | Concurrent append, replay, fail-closed, stale-state, partial-failure, and outbox retry scenarios in the PACT suites | `pnpm test`; `pnpm test:integration` |
| Fuzz / property | Rust libFuzzer targets (including the connector-discovery parsers: `mcp_config`, `ini_parse`, `whois_response`, `promote_request`), Jazzer.js targets, proptest, and bounded proof gates | `pnpm audit:fuzz`; `pnpm test:fuzz`; `pnpm audit:kani`; `pnpm audit:shuttle` |
| Dependency budget | Daemon/discovery dependency closure pinned against the ADR 0048 §5 allowlist; credential-exchange surface (sqlx, oauth2, jsonwebtoken, chacha20poly1305, task bus) kept off the daemon and the invoke-through/authn crates | `pnpm audit:daemon-deps` |
| Behavior / functional | Playwright browser/visual tests and live battle tests | `pnpm test:e2e`; `pnpm verify` |
| Mutation | Stryker/Vitest over credential redaction and URL trust boundaries; cargo-mutants over Rust redaction and task validation | `pnpm test:mutation` |

## Measured non-regression gates

`pnpm test:coverage` measures every workspace with a Vitest test script plus all
Rust workspace targets. The initial whole-repository floors are deliberately
the measured baseline, not an inflated claim:

- TypeScript: statements 80%, branches 80%, functions 80%, lines 80%.
- Rust: lines 69%, functions 67%.
- Mutation: the selected TypeScript and Rust security slices must have no
  surviving mutants.

These are repository-wide ratchets. Raise them as coverage lands; never lower
them to make a change pass. New or changed trust-boundary code should have
focused behavior and mutation coverage even when the global floor passes.

Measured on 2026-08-19: TypeScript statements 95.58%, branches 89.52%,
functions 95.82%, and lines 96.64%; Rust lines 69.83% and functions 67.96%.
UI behavior is also exercised by Playwright and visual snapshots, which these
unit-coverage reports do not instrument.

The same run killed 110/110 TypeScript mutants and 12/12 Rust mutants in the
selected credential-redaction and URL/task-validation boundaries.

Snapshot updates are always explicit. Use Vitest's `-u` or
`VISUAL_UPDATE=1 pnpm test:visual`, inspect the diff, and commit only intended
behavior changes.
