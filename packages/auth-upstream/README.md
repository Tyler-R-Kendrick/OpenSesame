# @opensesame/auth-upstream

Upstream human authentication adapter for OpenSesame. Uses [`better-auth`](https://www.better-auth.com/) only for email magic-link sign-in and its session mechanics ([ADR 0057](../../docs/adr/0057-email-linking-better-auth-and-ldap.md)); **canonical principal IDs** live in OpenSesame's mapping store — never Better Auth user IDs as downstream `sub`.

## Capabilities

- Better Auth factory (`createUpstreamAuth`): email magic-link is the one sign-in method (`signInMethods: ["magic-link"]`); email-and-password is off, Better Auth's social catalog is empty, and **Better Auth email account-linking is disabled**
- Durable Better Auth storage through a caller-owned Drizzle connection (`UpstreamAuthDatabase`); account and session secrets are sealed through a caller-supplied `AccountSecretCodec`, and construction fails without one. With no database Better Auth keeps its in-memory adapter
- `PrincipalMappingStore` — Better Auth user id → OpenSesame principal
- Anonymous / provisional sessions (`createProvisionalPrincipal`); the upgrade path (`upgradeProvisionalToUpstream`) preserves `principalId`
- Passkey seam (`createPasskeySeam`) with injectable `verifyAssertion` for tests, and WebAuthn registration and authentication helpers over `@simplewebauthn/server` (`./browser` exports only the verification half, with no Better Auth or Node adapters)
- Authentication service (`createAuthenticationService`): per-application passkey registration and authentication (origin-checked, `sign-in` and `step-up` configurations), aliases, credentials and tokens, over caller-supplied stores; application secrets from `mintAuthenticationApplicationSecret`
- Generic OIDC upstream provider registry (`UpstreamOidcProviderRegistry`; `mockUpstreamProvider()` seeds the local mock IdP). It only holds provider descriptors: Better Auth's own social catalog stays empty
- **No email auto-link** (`noEmailAutoLinkPolicy`)

## Configuration

The package reads no environment variables: the caller passes `baseURL`, `basePath`,
`secret`, `trustedOrigins`, the magic-link delivery callback and the optional
database. The Identity API (`packages/control-plane`, `src/services/better-auth-bridge.ts`)
mounts it at `/v1/auth`, derives the Better Auth secret from `OPENSESAME_CLAIM_PEPPER`
by HKDF, and allows the single path `/sign-in/magic-link`.

`mockUpstreamProvider()` hard-codes the local mock IdP: issuer
`http://127.0.0.1:9090`, client id `opensesame-upstream`, client secret
`opensesame-upstream-secret`. The Identity API's own `OPENSESAME_UPSTREAM_ISSUER`,
`OPENSESAME_UPSTREAM_CLIENT_ID` and `OPENSESAME_UPSTREAM_CLIENT_SECRET` have no
defaults and are read in `packages/control-plane/src/config.ts`, not here.

## Usage

```ts
import {
  createUpstreamAuth,
  MemoryPrincipalMappingStore,
  UpstreamOidcProviderRegistry,
  mockUpstreamProvider,
} from "@opensesame/auth-upstream";

const mappingStore = new MemoryPrincipalMappingStore();
const registry = new UpstreamOidcProviderRegistry();
registry.register(mockUpstreamProvider());

const { auth, emailLinkPolicy } = createUpstreamAuth({
  baseURL: "http://127.0.0.1:8788",
  basePath: "/v1/auth",
  secret: "<a secret of your own>",
  trustedOrigins: ["http://localhost:5180"],
  mappingStore,
  providerRegistry: registry,
  magicLink: {
    sendMagicLink: async ({ email, token }) => {
      /* deliver a link built from `token` */
    },
  },
});
```

## Tests

```bash
pnpm --filter @opensesame/auth-upstream test
```
