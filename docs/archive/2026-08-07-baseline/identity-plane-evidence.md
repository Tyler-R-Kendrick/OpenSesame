# Identity plane testing evidence

**Date:** 2026-08-07  
**Host:** WSL2 aarch64, Node 26 / pnpm 9, Rust 1.88

## Commands

```bash
pnpm -r --filter '@opensesame/*' test
pnpm --filter @opensesame/control-plane test
pnpm generate:openapi
pnpm generate:sbom
./scripts/battle-test.sh
```

## Automated results

All listed `@opensesame/*` Vitest suites **PASS**, including:

| Area | Notes |
|------|-------|
| os-domain | 25 — claim/device/provisional machines, token digests |
| claims / device-auth / policy | race, expiry, slow_down, quotas |
| oauth-provider | pairwise, PKCE, origin gate, SSRF fetcher |
| auth-upstream | no email auto-link |
| control-plane | provisional→claim ID continuity; `/auth.md` HTTP mount |
| SDKs / CLI / agent-protocols | contracts + redaction |
| testing | sentinel leak guards |
| identity-atproto / identity-nostr | disabled-by-default adapters |

Authority: `./scripts/battle-test.sh` → **ALL BATTLE TESTS PASSED**.

## Live smoke (control-plane :8788 + mock IdP :9090)

- Provisional principal + temporary project + claim present/complete with **preserved** `principalId` / `projectId`
- Agent anonymous register → instance + claim token
- Discovery: pairwise subjects, device auth endpoint, PKCE S256, JWKS
- `/auth.md` served after fixing OIDC mount stealing `/auth*` prefix
- OpenAPI 3.1 (`apps/control-plane/openapi.json`, 16 paths); SBOM `sbom/bom.json`

## AgentAuth / auth.md (2026-09-02)

Focused suites run after ADR 0092:

```bash
pnpm --filter @opensesame/os-domain test -- src/__tests__/agent-registration.test.ts
pnpm --filter @opensesame/policy test -- src/__tests__/agent-auth-scopes.test.ts
pnpm --filter @opensesame/contracts test -- src/__tests__/agent-auth.test.ts
pnpm --filter @opensesame/agent-protocols test
pnpm --filter @opensesame/database test -- tests/agent-auth-repo.test.ts tests/pact.test.ts
pnpm --filter @opensesame/control-plane exec vitest run src/__tests__/agent-auth.test.ts src/__tests__/api.test.ts src/__tests__/openapi.test.ts src/__tests__/origin-profile-issuer.test.ts
pnpm --filter @opensesame/example-static-agent test
pnpm --filter @opensesame/capability-registry test
pnpm --filter @opensesame/control-plane generate:openapi
```

All of the above **PASS**. Depth suites added beside the happy-path units:

| Type | Evidence |
| --- | --- |
| Atomic unit | `agent-registration.test.ts`, `agent-auth-scopes.test.ts`, `contracts` agent-auth, `agent-auth-tokens`, `agent-auth-repo.test.ts`, `agent-auth.test.ts` |
| Snapshot / characterization | Vitest snapshots of `/auth.md`, PRM, AS metadata, claim/login HTML (`agent-auth.characterization.test.ts`); agent-protocols `render.test.ts` |
| Contract / PACT | `*.pact.test.ts` in os-domain, policy, agent-protocols, control-plane (fail-closed source order + wire schema) |
| Chaos | Concurrent claim completion (at most one winner); forged/none-alg JWT exchange; memory UoW collision on commit |
| Fuzz | Jazzer targets `agent_auth_tokens.ts` / `agent_auth_contracts.ts`; seeded Hono body + `return_to` fuzz |
| Behavior | Given/When/Then journeys in `agent-auth.behavior.test.ts` |
| Mutation | Stryker slice: `apps/control-plane/src/ui/agent-auth-pages.ts` at 100% (31/31). Token/machine/scope files stay out until equivalent mutants are gone. |

`pnpm verify` was not run in this pass (full-repo gate). ID-JAG and SET delivery remain disabled and unadvertised.

## Residual risks / deferred

- Full Playwright passkey matrix + axe on all console pages
- Testcontainers Postgres when Docker Engine unavailable
- Cloud IdPs (Google/GitHub/Entra): config templates only
- ATProto/Nostr: interfaces only, gated off
- Compose Keycloak optional for enterprise OIDC brokering (not required for mandatory suite)
