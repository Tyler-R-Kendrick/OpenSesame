# Use OpenSesame Pages as your login

For a developer whose application is on another origin and wants a person to
sign in with the OpenSesame Pages vault. Read
[ADR 0161](../adr/0161-what-a-static-origin-can-be-as-an-openid-provider.md)
for why it has this shape.

## What you get, and what you do not

Pages is a **Self-Issued OpenID Provider, SIOPv2 (Implementer's Draft)**. It is
**not a conventional OpenID Connect provider**.

| You get | You do not get |
|---|---|
| A signed ID Token whose key never left the person's vault, proving *that key* answered *your* login | A `token_endpoint`, a `jwks_uri`, refresh tokens, `userinfo`, logout |
| A pairwise `sub` (the RFC 7638 thumbprint of the key): stable for you, unlinkable across relying parties | An email address, a name, or any claim you can treat as verified |
| Passkey-gated, human-clicked consent on every login | Compatibility with a stock OIDC client library |
| A static `siop-metadata.json` you can read off the deployment | `/.well-known/openid-configuration` (see ADR 0161 §3) |

Two things shape how you integrate:

- **The person registers your application**, in *their* vault (Identity ›
  Applications): its exact `redirect_uri` and the `openid` scope. Pages mints
  the application id (`local_<uuid>`), and it is the `client_id`. You cannot
  register yourself, and two people have two ids for you. Take the id per login
  (`startLogin({ clientId })`), or configure a fixed one when you build for one
  person (yourself, a household, a team that registers one shared vault).
- **The issuer is the deployment**: `<origin><base>identity/siop`, for example
  `https://tyler-r-kendrick.github.io/OpenSesame/identity/siop`. A fork, a
  custom domain or another base path is a different issuer with different keys.

## Register your application (the person does this)

1. Open the deployment, unlock the vault, **Identity › Applications**, create an
   application, and copy its id (`local_…`).
2. Under *Application registration* choose the organization, list your exact
   `redirect_uri`s (one per line; HTTPS, or `http://127.0.0.1:<port>/…` for
   development, no wildcards, no fragment) and allow the scope `openid`. Save.
3. Give the application id to your relying party.

## Read the deployment's metadata (optional, recommended)

```
GET https://<origin><base>siop-metadata.json
```

```ts
import { fetchSiopMetadata, pagesOriginOf, pagesSiopIssuer } from "@opensesame/siop-v2";

const issuer = pagesSiopIssuer(pagesOriginOf("https://tyler-r-kendrick.github.io/OpenSesame"));
const { authorizationEndpoint } = await fetchSiopMetadata({ fetch, expectedIssuer: issuer });
```

`expectedIssuer` is the pin: you decided which deployment you trust, the
document only confirms what it offers. A document naming another issuer, an
endpoint on another origin, or a SPA fallback served where the file should be
is refused. The document says `conventional_oidc: false` and lists no
`token_endpoint` or `jwks_uri` on purpose. The deployment builds it from
`PAGES_CANONICAL_ORIGIN` (see *Forks*). `pnpm dev:pwa` serves the same path.

## A server relying party (Node, Express)

Copy `examples/siop-rp/src/{app,callback-page,config}.ts`. The protocol is
`SiopRelyingParty`; `app.ts` is routes:

```ts
const rp = createSiopRelyingParty({
  issuer,                      // pagesSiopIssuer(...), pinned
  clientId,                    // a default; `startLogin({ clientId })` overrides per person
  redirectUri,                 // exact, registered
  store, ledger,               // share these across instances (below)
});

app.get("/auth/start", async (req, res) => {
  const { authorizationUrl } = await rp.startLogin({ clientId: req.query.client_id });
  res.redirect(302, authorizationUrl);
});

app.post("/callback", express.json({ limit: "20kb" }), async (req, res) => {
  const result = await rp.completeLogin({
    response: req.body.response,                   // the page's `location.hash`
    receivedRedirectUri: `${origin}${req.path}`,   // from YOUR route, not the page
  });
  // result.subject is the proven identity. Start your own session here.
});
```

The response returns in the URL **fragment**, which a server never sees, so
`GET /callback` serves a page (`callback-page.ts`) that reads `location.hash`,
removes it from the address bar and history at once, and POSTs it back. Serve it
under a CSP with no inline script (the example does), `Referrer-Policy:
no-referrer` and `Cache-Control: no-store`.

```bash
OPENSESAME_PAGES_BASE=https://tyler-r-kendrick.github.io/OpenSesame \
SIOP_RP_CLIENT_ID=local_… SIOP_RP_REDIRECT_URI=https://app.example/callback \
SIOP_RP_DISCOVER=1 \
  pnpm --filter @opensesame/example-siop-rp dev
```

## A single-page relying party (no back end)

`examples/siop-rp/src/spa` (`pnpm --filter @opensesame/example-siop-rp
dev:spa`, `build:spa`): the page reads the metadata, redirects, and verifies the
token in the browser. The login's state lives in `sessionStorage` because the
redirect is a full navigation. What this proves is that the key answered; with
no server there is nothing to trust it to, so its "session" is the page's memory.
An app with a back end wants the server flow above. For a session you can
*use* (check, revoke), embed the popup SDK instead (`@opensesame/static-auth`,
[Browser-local IAM](browser-local-iam.md)).

## What the kit checks, and what each refusal means

| Code | Meaning |
|---|---|
| `login_unknown` | No login of yours is waiting for this `state` (never issued, evicted, or closed after three failures) |
| `login_replayed` | This response was already accepted |
| `login_expired` | The login waited longer than its lifetime (10 minutes) |
| `redirect_mismatch` | The response arrived on a route other than the `redirect_uri` the login sent |
| `token_replayed` | This exact token was already accepted |
| `provider_error` | Pages returned an error (`error.providerError`, e.g. `access_denied` for Deny) |
| `nonce_mismatch`, `audience_mismatch`, `issuer_mismatch` | The token answers another login, another application, or another deployment |
| `token_expired`, `token_not_fresh` | Outside `exp`/`iat` (60 s skew, 10 min age by default) |
| `signature_invalid`, `subject_mismatch`, `invalid_sub_jwk` | Not signed by the key it names, or `sub` is not that key's thumbprint |

Show people a generic failure, log the code. A failed completion leaves the
login open for the real response (an attacker who guesses a `state` cannot burn
your user's login) until the third failure closes it.

## Replay defence across instances

`MemoryLoginStore` and `MemoryReplayLedger` are bounded and per process. Behind
more than one instance implement `SiopLoginStore` and `SiopReplayLedger` over a
shared store. `take` **must have exactly one winner** (`GETDEL`, `DELETE …
RETURNING`): that is the replay defence for the state. Keep token hashes until
`exp` plus the skew.

## Forks, custom domains, changing the issuer

The metadata names the origin the build was told: `PAGES_CANONICAL_ORIGIN`
(also read by `security-profile.json`) and `VITE_BASE`. The shipped project is
the default for the shipped base. Any other base with no
`PAGES_CANONICAL_ORIGIN` publishes **no** `siop-metadata.json` rather than a
wrong one. On Vercel, set the variable in the project; the file is served with
CORS from `vercel.json`.

Changing the origin or base changes `iss`, and every key with it. Treat it as a
migration: relying parties pin the issuer, so each must be told the new one,
and people register their applications again in the new vault (or restore a
backup, which keeps their keys and their `sub`s but not the old `iss`). The
passkey is scoped to the host (the WebAuthn RP ID), so a new domain also means
re-enrolling passkeys.

## Developing locally

```bash
pnpm dev:pwa                       # Pages on http://localhost:5180
# issuer: http://localhost:5180/OpenSesame/identity/siop  (metadata: …/siop-metadata.json)
```

Loopback `http` is accepted for issuers and redirect URIs, nothing else
non-HTTPS. Register `http://127.0.0.1:4110/callback` (the example's default).

## Verification

```bash
VITE_BASE=/OpenSesame/ pnpm --filter @opensesame/pages build
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium pnpm --filter @opensesame/pages verify:siop
```

`verify:siop` runs the example Node relying party as its own process and the
example single-page relying party on its own origin against the built app,
then provokes every refusal above through the real ceremony. It is a
SIOPv2-shaped test, not an OIDC conformance run: none of the OpenID conformance
suites has been run against Pages.

## When you need a conventional OP

Pages cannot be one. Use the [Identity API](identity-administration.md) (hosted;
its signing key is the trust root for its clients), link a SIOP subject to it
with the [hosted bridge](../adr/0117-hosted-siop-oidc-bridge.md), or, for apps
on the person's own machine, the native host's local OpenID provider
([ADR 0138](../adr/0138-self-issued-identity-one-native-host.md) §3, proposed).
