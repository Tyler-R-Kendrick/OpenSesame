# Trust-broker implementation evidence

## Scope

This checkout is the `feat/claim-guest-account` branch at base `a1031d6`.
Active guest-flow commits were preserved. No protocol or Android module was
present in the inspected tree, so this change adds the reusable pure core and
explicit refusal/default-off configuration rather than fake protocol endpoints.

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

Passed: `pnpm install --offline`; trust-broker and recovery-graph typechecks;
trust-broker tests (3/3); recovery-graph tests (5/5); os-domain typecheck;
presentation-machine tests (2/2); control-plane config tests (8/8); and
Biome checks on changed TypeScript files. The contracts typecheck reaches an
existing `src/__tests__/pact-contract.test.ts` readonly-schema error, and the
full control-plane typecheck remains baseline-red across existing audit/JSON
typing surfaces. Full repository, protocol, Android, fuzz, mutation, and
audit gates are not claimed by this slice.

## Unsupported

No OIDC4VP/OIDC4VCI/FedCM/Digital Credentials API/Federation/SD-JWT VC/status
list implementation, native Android holder, browser ceremony, or external
issuer adapter is claimed here.
