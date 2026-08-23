# Test coverage

OpenSesame uses complementary test types rather than treating line coverage as
a proxy for security. The commands below are local, deterministic gates unless
they explicitly require a live service.

| Test type | Evidence | Command |
| --- | --- | --- |
| Atomic unit | Vitest suites in 38 TypeScript workspaces; Rust unit tests across the workspace | `pnpm test`; `cargo +1.88.0 test --workspace --all-targets` |
| Snapshot / characterization | Vitest `__snapshots__` (Verify equivalent) in Pages connectors/guest surfaces, agent-protocols, audit redaction; `insta` JSON snapshots in the daemon; Playwright pixel baselines | `pnpm --filter @opensesame/pages test`; `pnpm --filter @opensesame/agent-protocols test`; `pnpm test:visual` |
| Contract | OpenAPI/WIT schemas and PACT transport/adversarial suites documented in `pact.md` | `pnpm test:integration`; `pnpm test:task-access` |
| Chaos | Concurrent append, replay, fail-closed, stale-state, partial-failure, and outbox retry scenarios in the PACT suites | `pnpm test`; `pnpm test:integration` |
| Fuzz / property | Rust libFuzzer targets (including the connector-discovery parsers: `mcp_config`, `ini_parse`, `whois_response`, `promote_request`), Jazzer.js targets, proptest, and bounded proof gates | `pnpm audit:fuzz`; `pnpm test:fuzz`; `pnpm audit:kani`; `pnpm audit:shuttle` |
| Dependency budget | Daemon/discovery dependency closure pinned against the ADR 0048 §5 allowlist; credential-exchange surface (sqlx, oauth2, jsonwebtoken, chacha20poly1305, task bus) kept off the daemon and the invoke-through/authn crates | `pnpm audit:daemon-deps` |
| Behavior / functional | `*.behavior.test.ts` Given/When/Then journeys (control-plane ceremonies, Pages guest login); Playwright and live battle tests | `pnpm test`; `pnpm test:e2e`; `pnpm verify` |
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

## What belongs in the mutation slice

The `mutate` list in `stryker.config.json` is deliberately small: files where a
surviving mutant means a security decision stopped being made and nothing
noticed. `services/identity-link.ts` joined it on 2026-08-22 (82/82) — it is the
single place both federated surfaces decide whether an upstream identity may
attach to a principal.

`interactions/federated.ts` is deliberately **not** in the slice, and the
reasoning is worth recording rather than rediscovering:

- Roughly half its surviving mutants are verbatim error-copy strings and
  `{ cause }` literals. Driving those to zero means asserting user-facing
  wording character by character, which couples the suite to copy and turns
  every message tweak into a failing gate — cost without a security gain.
- Its behaviour is already held by suites that outlast wording changes: a chaos
  suite that injects one broker fault per case, a PACT suite pinning the order
  of the fail-closed checks, a fuzz target over the cookie parser, and ~99%
  line coverage.

Reconsider that if the file ever sheds its message strings, or if a bug lands
in it that the existing suites did not catch.

**Before adding any file to the slice**, check whether a source-oracle test
(`assertSourceOrder`) reads it. Stryker instruments what it mutates, so the
literal source no longer matches and the dry run fails with an opaque
"failed tests in the initial test run" naming no test. See the guard in
`apps/control-plane/src/__tests__/federated-leg.pact.test.ts`.

Snapshot updates are always explicit. Use Vitest's `-u` or
`VISUAL_UPDATE=1 pnpm test:visual`, inspect the diff, and commit only intended
behavior changes.
