# @opensesame/sdk-server

The resource-server SDK for APIs that accept tokens issued by the Identity
API: JWT access-token verification against the issuer's JWKS, OpenID Connect
ID-token verification, RFC 7662 introspection of opaque tokens, and a Hono
middleware that puts the verified identity on the request context. Every
check fails closed.

## Where it fits

- **Used by:** no workspace package or example depends on it yet; it is the public SDK a third-party resource server installs.
- **Builds on:** [`@opensesame/os-domain`](../os-domain), `jose`. `hono` is an optional peer dependency, needed only for `openSesameAuth`.
- Only asymmetric algorithms are accepted (`DEFAULT_ALLOWED_ALGORITHMS`; ID tokens are RS256/ES256 only). The algorithm is the verifier's choice, never the token's.
- The JWKS URI comes from the issuer's discovery document unless configured. It must be https (http only on loopback), and a discovered URI may name a private or loopback host only when the issuer is itself private.
- Introspection requires an `audience`: an authorization server reports any live token as `active`, so a token minted for another resource is refused.

## Surface

| Export | What it does |
|---|---|
| `createOpenSesameVerifier({ issuer, audience, requiredScopes, algorithms, … })` | Returns `{ verifyAccessToken(token) }` → `VerifiedIdentity` (`sub`, `iss`, `aud`, `scope`, `assurance`, `payload`) |
| `verifyIdToken({ issuer, audience, nonce, … })` | Verifies an OIDC ID token → `VerifiedIdToken` |
| `introspectOpaqueAccessToken({ introspectionEndpoint, audience, clientId, clientSecret, … })` | RFC 7662 introspection → `IntrospectedAccessToken` |
| `openSesameAuth({ verifier, getToken, onError })` | Hono middleware; Bearer by default, RFC 6750 `WWW-Authenticate` on 401. Also exported from `@opensesame/sdk-server/hono` |
| `AuthError`, `AuthorizationError` | 401 (identity not established) and 403 (identity known, access denied), each with a `code` |

From `src/verifier.test.ts`:

```ts
import { Hono } from "hono";
import {
  type OpenSesameAuthVariables,
  createOpenSesameVerifier,
  openSesameAuth,
} from "@opensesame/sdk-server";

const verifier = createOpenSesameVerifier({
  issuer: "https://id.example.test",
  audience: "https://api.example.test",
});
const app = new Hono<{ Variables: OpenSesameAuthVariables }>();
app.use("/me", openSesameAuth({ verifier }));
app.get("/me", (c) => c.json({ sub: c.get("identity").sub }));
```

## Develop

```bash
pnpm --filter @opensesame/sdk-server test
pnpm --filter @opensesame/sdk-server test:watch
pnpm --filter @opensesame/sdk-server typecheck
```

Tests mint keys with `jose` and pass a local `jwks`, so they need no network.

## Related

- [ADR 0050](../../docs/adr/0050-origin-profile-static-site-issuer.md) — F7: typed, fail-closed `verifyIdToken` and RFC 7662 introspection
- [`packages/sdk-browser`](../sdk-browser) — the relying-party side of the same sign-in
