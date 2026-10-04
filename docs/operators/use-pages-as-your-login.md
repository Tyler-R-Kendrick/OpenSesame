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
  person (yourself, a household, a team that registers one shared vault). A
  person may register more than one callback for you; pick the one a login
  returns to with `startLogin({ redirectUri })`, which must be one of the
  `allowedRedirectUris` you configured.
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
endpoint on another origin (or one carrying a query), or a SPA fallback served
where the file should be is refused, and so is a body over 8 KiB, whether the
server says so in `Content-Length` or you count it while it streams. By default
the document is read from the issuer's own origin; an explicit `metadataUrl`
elsewhere is refused unless you say it is a mirror (`allowMirror: true`), and
plaintext `http` is refused unless it is loopback **and** you opted in
(`allowLoopbackHttp: true`). The document says `conventional_oidc: false` and
lists no `token_endpoint` or `jwks_uri` on purpose. The deployment builds it
from `PAGES_CANONICAL_ORIGIN` (see *Forks*). `pnpm dev:pwa` serves the same
path.

## A server relying party (Node, Express)

Copy `examples/siop-rp/src/{app,callback-page,rate-limit,config}.ts`. The
protocol is `SiopRelyingParty`; `app.ts` is routes:

```ts
const rp = createSiopRelyingParty({
  issuer,                      // pagesSiopIssuer(...), pinned
  clientId,                    // a default; `startLogin({ clientId })` overrides per person
  redirectUri,                 // exact, registered (a query is part of it)
  allowedRedirectUris,         // every callback a login may be started for
  store, ledger,               // share these across instances (below)
});

app.get("/auth/start", async (req, res) => {
  const started = await rp.startLogin({ clientId: req.query.client_id });
  // The binding is this browser's half of the login. Only this browser gets it.
  res.setHeader("set-cookie",
    `__Host-siop_binding=${started.binding}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`);
  res.redirect(302, started.authorizationUrl);
});

app.post("/callback", express.json({ limit: "20kb" }), async (req, res) => {
  const result = await rp.completeLogin({
    response: req.body.response,                       // the page's `location.hash`
    binding: bindingCookie(req),                       // from the browser's cookie
    receivedRedirectUri: `${origin}${req.originalUrl}`, // from YOUR route, query and all
  });
  // result.subject is the proven identity. Start your own session here.
});
```

**The binding is not optional.** Without it a response proves only that
*somebody* answered *some* login. An attacker who starts a login, completes it
in their own browser, and gets your user's browser to deliver that response
(a link, a form post) would sign your user in as the attacker (login CSRF /
session fixation). The kit refuses a response whose binding is missing or is not
the one `startLogin` returned for that state, and answers `login_unknown`.

The binding belongs in something only the starting browser holds. The example
uses a `__Host-` `HttpOnly` `SameSite=Lax` cookie: `__Host-` pins it to this
host over https at path `/`, `HttpOnly` keeps your own page's script from
reading it, and `Lax` is enough because the response returns by a top-level
navigation to a page that then makes a same-site `POST`. (Chromium also accepts
the `Secure` cookie on `http://127.0.0.1`, which is what lets the example run
locally.) Do not put it in the URL, in the `state`, or in a cookie script can
read, and do not reuse one binding across logins.

`receivedRedirectUri` is **required**. Build it from the request your server
received (path *and query*), never from a value the page posts about itself; the
kit compares it with the `redirect_uri` the login sent as origin + path + query.

If you take more than one callback, list them all in `allowedRedirectUris` and
start each login for the one it should return to; the example's
`/auth/start?callback=/callback/mobile` does this against
`SIOP_RP_CALLBACK_PATHS`. A response that lands on a callback its login was not
started for is `redirect_mismatch`.

The response returns in the URL **fragment**, which a server never sees, so
`GET /callback` serves a page (`callback-page.ts`) that reads `location.hash`,
removes it from the address bar and history at once, and POSTs it back. Serve it
under a CSP with no inline script (the example does), `Referrer-Policy:
no-referrer` and `Cache-Control: no-store`. **Mind `form-action`:** a browser
checks a form's redirect target against it too, so a sign-in `<form
action="/auth/start">` whose server answers `302` to Pages needs `form-action
'self' <the Pages origin>`. `'none'`, or `'self'` alone, silently stops the
sign-in; `verify:siop` signs in through the example's own form to keep that
true.

**Do not let an anonymous visitor fill your login store.** `startLogin` keeps a
login for ten minutes. The kit's stores drop what has expired and then **refuse**
when full (`SiopRpError` `capacity_exceeded`): they never evict a login that
someone is in the middle of. The example answers `503` with `retry-after`, and
limits each client to `SIOP_RP_STARTS_PER_MINUTE` (default 30) with `429`. Size
the store with `SIOP_RP_MAX_PENDING_LOGINS` (default 10000), and behind a proxy
key the limit on the address the proxy vouches for.

```bash
OPENSESAME_PAGES_BASE=https://tyler-r-kendrick.github.io/OpenSesame \
SIOP_RP_CLIENT_ID=local_… SIOP_RP_REDIRECT_URI=https://app.example/callback \
SIOP_RP_DISCOVER=1 \
  pnpm --filter @opensesame/example-siop-rp dev
```

For local development add `SIOP_RP_ALLOW_LOOPBACK_HTTP=1` and register
`http://127.0.0.1:4110/callback`; without it the server refuses to start with a
plaintext address. `SIOP_RP_METADATA_MIRROR=1` says that `SIOP_RP_METADATA_URL`
is a mirror at another origin than the issuer.

## A single-page relying party (no back end)

`examples/siop-rp/src/spa` (`pnpm --filter @opensesame/example-siop-rp
dev:spa`, `build:spa`): the page reads the metadata, redirects, and verifies the
token in the browser. The redirect is a full navigation, so the login's state,
nonce and binding live in the tab's `sessionStorage`, **sealed** with
`@opensesame/browser-at-rest` ([ADR 0149](../adr/0149-nothing-stored-in-the-clear.md)):
a copy of the storage holds an at-rest seal, not the values. The tab's own
storage is this flow's binding: a response opened in another tab, or in a
browser that did not start the login, finds no login and is refused
(`login_unknown`). There is one login per tab; pressing Sign in again replaces
the one the tab was waiting on. Where the origin can keep no key (storage
blocked, a private mode without IndexedDB) the page does not sign in at all:
it refuses before the redirect rather than write the login in the clear or lose
it to the navigation. What this proves is that the key answered; with no server
there is nothing to trust it to, so its "session" is the page's memory. An app
with a back end wants the server flow above. For a session you can *use* (check,
revoke), embed the popup SDK instead (`@opensesame/static-auth`,
[Browser-local IAM](browser-local-iam.md)).

## What the kit checks, and what each refusal means

| Code | Meaning |
|---|---|
| `login_unknown` | No login of this browser is waiting for this `state`: never issued, closed after three failures, taken already, or the binding is missing or is not the one the login was started with |
| `login_replayed` | This response was already accepted |
| `login_expired` | The login waited longer than its lifetime (10 minutes) |
| `redirect_mismatch` | The response arrived at an address (origin, path or query) other than the `redirect_uri` the login sent |
| `token_replayed` | This exact token was already accepted |
| `capacity_exceeded` | `startLogin` only: the store is full of live logins and refuses another (answer `503`) |
| `provider_error` | Pages returned an error (`error.providerError`, e.g. `access_denied` for Deny), reported by the browser that started the login |
| `nonce_mismatch`, `audience_mismatch`, `issuer_mismatch` | The token answers another login, another application, or another deployment |
| `token_expired`, `token_not_fresh` | Outside `exp`/`iat` (60 s skew, 10 min age by default) |
| `signature_invalid`, `subject_mismatch`, `invalid_sub_jwk` | Not signed by the key it names, or `sub` is not that key's thumbprint |

Show people a generic failure, log the code. A failed completion leaves the
login open for the real response until the third failure closes it. A response
with the wrong or missing **binding** leaves the login exactly as it was and
counts for nothing: someone who learns a `state` (it is in the URL Pages is sent
to) but does not hold the browser's binding can neither complete the login,
nor use up its attempts, nor cancel it with a forged `#error=access_denied&state=…`.
An error closes a login only when it arrives from the browser that started it.

## Replay defence across instances

`MemoryLoginStore` (refuses when full), `StorageLoginStore` (bounded and pruned)
and `MemoryReplayLedger` (evicts its oldest once nothing has expired) are bounded
and per process. Behind
more than one instance implement `SiopLoginStore` and `SiopReplayLedger` over a
shared store. `take` **must have exactly one winner** (`GETDEL`, `DELETE …
RETURNING`): that is the replay defence for the state. Keep token hashes until
`exp` plus the skew.

## Forks, custom domains, changing the issuer

The metadata names the origin the build was told: `PAGES_CANONICAL_ORIGIN`
(also read by `security-profile.json`) and `VITE_BASE`. The shipped project's
own build, at the shipped base, names the shipped origin. **A fork does not:**
a GitHub Actions build for another owner (`GITHUB_REPOSITORY_OWNER`) with no
`PAGES_CANONICAL_ORIGIN` of its own, one that sets it to the upstream project's
origin, and any other base with no `PAGES_CANONICAL_ORIGIN` publish **no**
`siop-metadata.json` and warn why, rather than a document naming an issuer they
are not. Set `PAGES_CANONICAL_ORIGIN` (an origin: scheme and host, no path) in
your deploy. A build by hand has no owner to read, so a fork that builds and
publishes by hand must set the variable itself. On Vercel, set the variable in
the project; the file is served with CORS from `vercel.json`.

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

Loopback `http` is accepted for issuers and redirect URIs **only when you opt
in** (`allowLoopbackHttp: true`, or `SIOP_RP_ALLOW_LOOPBACK_HTTP=1` for the
example), nothing else non-HTTPS. Register `http://127.0.0.1:4110/callback` (the
example's default). A production build leaves the opt-in off.

## Verification

```bash
VITE_BASE=/OpenSesame/ pnpm --filter @opensesame/pages build
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium pnpm --filter @opensesame/pages verify:siop
```

`verify:siop` runs the example Node relying party as its own process and the
example single-page relying party on its own origin against the built app. The
Node relying party is signed in to through its own `<form>` in the browser, and
the run then provokes the refusals above through the real ceremony, including a
response delivered to a browser that did not start the login. It is a
SIOPv2-shaped test, not an OIDC conformance run: none of the OpenID conformance
suites has been run against Pages.

## When you need a conventional OP

Pages cannot be one. Use the [Identity API](identity-administration.md) (hosted;
its signing key is the trust root for its clients), link a SIOP subject to it
with the [hosted bridge](../adr/0117-hosted-siop-oidc-bridge.md), or, for apps
on the person's own machine, the native host's local OpenID provider
([ADR 0138](../adr/0138-self-issued-identity-one-native-host.md) §3, proposed).
