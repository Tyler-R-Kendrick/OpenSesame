# @opensesame/sdk-browser

The browser SDK for relying parties of the Identity API: "Sign in with
OpenSesame" by authorization code with PKCE, the redirect callback, in-browser
ID-token validation, anonymous sessions, claim presentation, and a passwordless
(passkey) client for the authentication service. It is the only browser
ceremony implementation ([ADR 0059](../../docs/adr/0059-free-passwordless-authentication-service.md)).

## Where it fits

- **Used by:** [`apps/pages`](../../apps/pages), [`apps/pwa`](../../apps/pwa), [`apps/console`](../../apps/console), [`apps/ceremonies`](../../apps/ceremonies), [`apps/mobile-mfa`](../../apps/mobile-mfa), [`packages/app-core`](../app-core), [`packages/static-auth`](../static-auth), and the examples [`rp-alpha`](../../examples/rp-alpha), [`rp-beta`](../../examples/rp-beta), [`static-rp`](../../examples/static-rp).
- **Builds on:** [`@opensesame/os-domain`](../os-domain), `jose`.
- Tokens and the PKCE verifier default to `sessionStorage`, then memory — never `localStorage`, so they do not outlive the browser session as XSS-exfiltrable material. `returnTo` is restricted to same-origin relative paths.
- With no `clientId`, the client derives the origin profile (`origin:<canonical origin>`, callback `<origin>/opensesame/callback`) and validates the ID token in the browser ([ADR 0050](../../docs/adr/0050-origin-profile-static-site-issuer.md) F7).

## Surface

| Export | What it does |
|---|---|
| `createOpenSesame(config)` | `OpenSesameBrowserClient`: `signIn`, `handleRedirectCallback`, `getReturnTo`, `continueAnonymously`, `getSession`, `presentClaim`, `readClaim`, `completeClaim`, `linkIdentity`, `signOut` |
| `createAuthenticationClient({ apiBase, applicationId })` | Passkey `register(token)` and `signin({ mode })` against `/register/*` and `/signin/*` |
| `verifyBrowserIdToken`, `verifyBrowserIdTokenClaims`, `verifyRestoredBrowserIdToken`, `fetchOidcJson` | OIDC discovery and ID-token checks |
| `canonicalizeBrowserOrigin`, `originProfileClientId`, `defaultOriginCallback`, `assertSafeReturnTo` | Origin profile helpers; `OriginError`, `BrowserOriginError` |
| `createPkcePair`, `randomString`, `sha256Base64Url`, `base64UrlEncode` | PKCE primitives |
| `creationOptionsFromJson`, `requestOptionsFromJson`, `registrationResponseJson`, `authenticationResponseJson`, … | WebAuthn JSON codecs |
| `decodeJwtEnvelope`, `ClaimRequestError` | JWT header/payload decode (no verification); claim errors |

From [`examples/rp-alpha`](../../examples/rp-alpha/src/RpApp.tsx):

```ts
import { createOpenSesame } from "@opensesame/sdk-browser";

const sesame = createOpenSesame({
  issuer: "http://127.0.0.1:8788",
  clientId: "rp-alpha",
  redirectUri: "http://127.0.0.1:5174/",
});

// On the redirect_uri page, after the Identity API sends the code back:
const session = await sesame.handleRedirectCallback(window.location.href);
```

## Develop

```bash
pnpm --filter @opensesame/sdk-browser test
pnpm --filter @opensesame/sdk-browser test:watch
pnpm --filter @opensesame/sdk-browser typecheck
```

JWT fixtures for the ID-token tests are in `src/test/jwt-fixtures.ts`.

## Related

- [ADR 0050](../../docs/adr/0050-origin-profile-static-site-issuer.md) — origin profile and the zero-config RP mode
- [ADR 0059](../../docs/adr/0059-free-passwordless-authentication-service.md) — the passwordless authentication service
- [ADR 0034](../../docs/adr/0034-origin-brokered-static-site-signin.md) — origin-brokered static-site sign-in
