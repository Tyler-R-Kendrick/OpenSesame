# Testing evidence

See also `docs/validation/identity-testing-evidence.md`.

## Commands (2026-08-07)

```bash
pnpm -r --filter '@opensesame/*' test
pnpm --filter @opensesame/control-plane test
pnpm generate:openapi
pnpm generate:sbom
./scripts/battle-test.sh
```

## Outcomes

- Identity package Vitest suites: **PASS** (domain, claims, device-auth, oauth-provider, auth-upstream, SDKs, CLI, control-plane, worker, examples).
- Control-plane: **6** tests including HTTP mount regression for `/auth.md` vs OIDC `/auth`.
- Live smoke (`:8788` + mock IdP `:9090`):
  - provisional → temporary project → claim present → claim complete with **preserved** principal/project IDs
  - anonymous agent registration with instance + claim token
  - discovery: `subject_types_supported: pairwise`, device endpoint, PKCE S256, JWKS
  - `/auth.md` and Agent Card served
- OpenAPI 3.1 generated (`apps/control-plane/openapi.json`, 16 paths)
- SBOM written to `sbom/bom.json`
- Authority plane battle tests: **ALL PASSED**

## Residual (documented, not blocking mandatory local suite)

- Playwright passkey virtual-authenticator full browser matrix
- Testcontainers Postgres when Docker Engine unavailable on host
- Live Google/GitHub/Entra (templates only; mock IdP used)
- ATProto/Nostr: interfaces present, **disabled by default**
