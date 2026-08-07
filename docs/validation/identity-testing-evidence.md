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

## Residual risks / deferred

- Full Playwright passkey matrix + axe on all console pages
- Testcontainers Postgres when Docker Engine unavailable
- Cloud IdPs (Google/GitHub/Entra): config templates only
- ATProto/Nostr: interfaces only, gated off
- Compose Keycloak optional for enterprise OIDC brokering (not required for mandatory suite)
