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

Re-measured on 2026-08-22: TypeScript statements 92.14% (16831/18266),
branches 85.21% (12374/14522), functions 93.15% (3605/3870), and lines 93.21%
(15687/16829) — still clear of the 80% floors, but three to four points below
the August 19 figures across every metric. Code landed in that window without
proportional tests. That is what a ratchet permits and what it is for: the
gate stays green while the trend is visibly downward, which is the argument
for reading the mutation score rather than this table. The Rust half was not
re-measured — `cargo-llvm-cov` was not installed on that machine, and the gate
fails loudly rather than reporting a number it did not compute.

That run killed 110/110 TypeScript mutants and 12/12 Rust mutants in the
selected credential-redaction and URL/task-validation boundaries.

The TypeScript figure then went stale, which is worth recording because of how
it went stale rather than by how much. `guest-auth.ts`, `notices.ts` and
`probe-failure.ts` joined the mutate list after that measurement, and the gate
was not re-run; when it next was, on 2026-08-22, it stood at **90.77%** — 31
surviving and 11 uncovered mutants. `guest-auth.ts` was the worst of them at
70.59%, and only because its test file could not run under
`vitest.mutation.config.ts`'s `node` environment at all. It is now back to
**100.00% (445 killed, 0 survived, 0 uncovered)**.

So: re-run `pnpm test:mutation:ts` whenever you add a file to
`stryker.config.json` and update the figure above. An entry whose gate has
never been run reads as covered while measuring nothing, which is the one
failure mode this gate exists to prevent.

Snapshot updates are always explicit. Use Vitest's `-u` or
`VISUAL_UPDATE=1 pnpm test:visual`, inspect the diff, and commit only intended
behavior changes.
