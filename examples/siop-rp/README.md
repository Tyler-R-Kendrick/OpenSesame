# @opensesame/example-siop-rp

Two small, copy-ready relying parties for OpenSesame Pages as a **Self-Issued
OpenID Provider**, SIOPv2 (Implementer's Draft), **not a conventional OpenID
Connect provider** ([ADR 0161](../../docs/adr/0161-what-a-static-origin-can-be-as-an-openid-provider.md)):

| | Where | Needs |
|---|---|---|
| An **Express** server | `src/app.ts` (routes), `src/callback-page.ts`, `src/rate-limit.ts`, `src/config.ts`, entry `src/server.ts` | Node 22 |
| A **single-page app** | `src/spa` (`login.ts` is the logic, `sealed-login.ts` the sealed tab storage, `main.ts` the wiring) | any static host |

Both use [`@opensesame/siop-v2`](../../packages/siop-v2): `SiopRelyingParty`
for the login (state, nonce, binding, audience, redirect_uri, replay), `fetchSiopMetadata`
for the deployment's `siop-metadata.json`, and `verifySelfIssuedIdToken` for the
token. The full walkthrough is
[Use OpenSesame Pages as your login](../../docs/operators/use-pages-as-your-login.md).

## What you get

| You get | You do not get |
|---|---|
| Proof that the key behind `sub_jwk` answered *your* login (`nonce`, `aud`, `redirect_uri`) | A verified email, a name, or any self-asserted claim |
| A pairwise subject: the JWK thumbprint, stable for you, unlinkable across RPs | A `token_endpoint`, `jwks_uri`, refresh token or logout |
| Passkey-gated, human-clicked consent | Compatibility with a stock OIDC library |

The person registers your application in their own vault (Identity ›
Applications: the exact redirect URI and the `openid` scope). Pages mints the
application id, `local_<uuid>`, and it is your `client_id`.

## Express

```bash
OPENSESAME_PAGES_BASE=https://tyler-r-kendrick.github.io/OpenSesame \
SIOP_RP_CLIENT_ID=local_<uuid> \
SIOP_RP_REDIRECT_URI=http://127.0.0.1:4110/callback \
SIOP_RP_ALLOW_LOOPBACK_HTTP=1 \
SIOP_RP_DISCOVER=1 \
  pnpm --filter @opensesame/example-siop-rp dev
# open http://127.0.0.1:4110
```

`SIOP_RP_ALLOW_LOOPBACK_HTTP=1` is for local development only: without it the
server refuses a plaintext redirect URI and starts nothing. Deploy over https
and leave it off.

| Variable | Default | |
|---|---|---|
| `OPENSESAME_PAGES_BASE` | `https://tyler-r-kendrick.github.io/OpenSesame` | The deployment: origin plus base path, no trailing slash. For local Pages use `http://localhost:5180/OpenSesame`. |
| `SIOP_RP_CLIENT_ID` | `local_00000000-0000-4000-8000-000000000001` | The default application id; a person's own id can be passed per login as `/auth/start?client_id=`. |
| `SIOP_RP_REDIRECT_URI` | `http://<listen>/callback` | Exact, as registered. |
| `SIOP_RP_CALLBACK_PATHS` | the redirect URI's path | Extra comma-separated paths, each a further registered callback (`origin` + path). Start a login for one with `/auth/start?callback=/path`; a response arriving at a callback its login was not started for is `redirect_mismatch`, and a path not listed is refused at start. |
| `SIOP_RP_DISCOVER` | off | `1`: fetch `siop-metadata.json` first, pinned to the issuer above, and refuse to start if it does not check out. |
| `SIOP_RP_METADATA_URL` | beside the issuer | Where to fetch it from. Must be at the issuer's origin unless `SIOP_RP_METADATA_MIRROR=1`. |
| `SIOP_RP_METADATA_MIRROR` | off | `1`: `SIOP_RP_METADATA_URL` is a mirror at another origin than the issuer. |
| `SIOP_RP_ALLOW_LOOPBACK_HTTP` | off | `1`: accept `http` on loopback (local development only). |
| `SIOP_RP_STARTS_PER_MINUTE` | `30` | Logins one client may start per minute; over it `/auth/start` answers `429`. |
| `SIOP_RP_MAX_PENDING_LOGINS` | `10000` | Logins that may wait at once; when full, `/auth/start` answers `503` and never evicts one in progress. |
| `SIOP_RP_LISTEN` | `127.0.0.1:4110` | `host:port`. |

Routes: `GET /auth/start` (new state, nonce and binding; the binding goes to
this browser as a `__Host-` `HttpOnly` `SameSite=Lax` cookie; redirect to
Pages), `GET <callback>` (a page that reads the URL fragment, scrubs it, and
posts it back), `POST <callback>` (verify against the cookie and the address the
request arrived at, query included; **start your own session here**). A
response without this browser's cookie is `login_unknown`: it cannot complete,
use up or close a login. The pages run under a CSP with no inline script, and a
`form-action` that names this server and the Pages origin (the sign-in form's
`302` to Pages is checked against it).

`app.ts` shares nothing between instances: the example uses the kit's bounded
in-memory store and replay ledger. Behind more than one instance, pass your own
`SiopLoginStore` and `SiopReplayLedger` with an atomic `take`.

## Single-page app

```bash
OPENSESAME_PAGES_BASE=https://tyler-r-kendrick.github.io/OpenSesame \
SIOP_RP_CLIENT_ID=local_<uuid> \
  pnpm --filter @opensesame/example-siop-rp dev:spa    # http://127.0.0.1:4111
pnpm --filter @opensesame/example-siop-rp build:spa     # dist/spa
```

The page is its own callback, so register its address (`http://127.0.0.1:4111/`)
as the redirect URI, and build with `SIOP_RP_ALLOW_LOOPBACK_HTTP=1` for a
loopback Pages (a production build leaves it off). It reads the metadata,
redirects, and verifies the token in the browser. The login's state, nonce and
binding wait out the redirect in the tab's `sessionStorage`, sealed with
`@opensesame/browser-at-rest` (ADR 0149), so nothing about it rests in the
clear and a response opened in another tab finds no login. With no key to seal
under, sign-in refuses before it redirects. With no server there is nothing to
trust a session to. For a session you can use, embed `@opensesame/static-auth`'s
popup SDK.

## Tests

```bash
pnpm --filter @opensesame/example-siop-rp test        # the app over real HTTP; the SPA flow
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
  pnpm --filter @opensesame/pages verify:siop         # both, cross-origin, against the built Pages app
```

`verify:siop` starts this server as its own process and signs in against the
built Pages app with a virtual authenticator, through this server's own sign-in
form, then provokes every refusal (wrong nonce, audience, redirect_uri; replayed
response and token; a response delivered to another browser, or to one with no
cookie; tampered signature; expired token; unregistered redirect; a locked
vault; no consent without a click). It is a SIOPv2-shaped test, not an OIDC
conformance run.

## Related

- [`packages/siop-v2`](../../packages/siop-v2): protocol core, relying-party kit, `SUPPORT_MATRIX`
- [ADR 0116](../../docs/adr/0116-browser-native-siop-v2.md): browser-native SIOPv2 · [ADR 0117](../../docs/adr/0117-hosted-siop-oidc-bridge.md): the hosted bridge (a different, hosted trust model)
