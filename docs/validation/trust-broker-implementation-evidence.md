# Trust-broker implementation evidence

## Scope

This checkout is the `feat/claim-guest-account` branch at base `a1031d6`.
Active guest-flow commits were preserved. No protocol or Android module was
present in the inspected tree, so this change adds the reusable pure core and
explicit refusal/default-off configuration rather than fake protocol endpoints.
Incremental commits delivered here are `4f0ab00`, `2b09d56`, `6761102`,
`488e5c2`, `57e660c`, `97c1977`, `cacfb58`, and `e92777b`.

## Delivered

- `packages/os-domain/src/trust.ts`: composable assurance, evidence, trust
  session, activation, and credential metadata records.
- `packages/os-domain/src/presentation.ts`: separate presentation state,
  consent, intent, opaque ref, and redacted receipt records.
- `packages/trust-broker`: deterministic policy evaluation and legacy
  projection, with refusal tests.
- `packages/contracts/src/trust.ts`: bounded Zod wire schemas.
- Eight protocol feature flags in `.env.schema` and control-plane config,
  defaulting off.
- ADR 0051 and this evidence record.

## Security properties tested

MFA does not imply phishing resistance; stale evidence is rejected; workload
evidence cannot satisfy a human requirement. Raw token and credential fields
are absent from the new records. Agent-facing records are opaque and digest
bound.

The existing static Pages federation path still has a residual risk: it stores
and relays an upstream `id_token` through browser storage/messages. Existing
control-plane cookie paths are HttpOnly and production self-asserted linking is
refused, but the static path needs a server callback or one-time opaque
continuation before it can satisfy the full bearer-handling requirements.

## Validation

Passed: `pnpm install --offline`; TypeScript coverage with 92.23% statements,
85.52% branches, 93.07% functions, and 93.29% lines; 1,263-test Stryker dry
run; Rust mutation (67/68 caught, 1 unviable); fuzz discovery (7/7) and all
13 fuzz targets; red-team structural Pact (15/15); security tests (3/3);
OAuth provider (130/130); upstream auth (71/71); audit (30/30);
trust-broker (6/6); recovery graph (5/5); client-core (23/23); and the
existing broad suites exercised by the coverage gate, including control-plane
(260 tests), Pages (1,681 tests), and os-domain (145 tests).

The TypeScript mutation gate is intentionally not marked green: 390/452
mutants were killed, 44 survived, 18 had no coverage, and 2 timed out, for an
86.34% score against the repository's 100% threshold. The surviving mutants
are concentrated in pre-existing Pages guest/notices and provisional-policy
files; the new assurance evaluator has contract, chaos, monotonicity, and
snapshot coverage but is not yet in the Stryker mutation list.

`pnpm test:integration` reaches the visual-contract webserver after OAuth and
upstream-auth build repairs, then fails because the existing Pages build has a
large TypeScript error set. Full `pnpm typecheck` similarly reaches existing
visual-contract and agent-protocols typing failures. The red-team live model
evaluation is not reproducible here because its Claude Code OAuth credential
is expired; the structural suite is green without cloud credentials.

The taxonomy is present in the repository: 4 snapshot files, 2
characterization files, 57 contract/Pact files, 41 chaos files, 11 fuzz
target/test files, 6 behavior/functional files, 369 TypeScript unit-test
files, and 156 Rust test files. Snapshot/characterization uses Vitest and
Playwright rather than a new dependency.

## Unsupported

No OIDC4VP/OIDC4VCI/FedCM/Digital Credentials API/Federation/SD-JWT VC/status
list implementation, native Android holder, browser ceremony, or external
issuer adapter is claimed here.
