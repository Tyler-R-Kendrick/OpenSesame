# ADR 0161 — What a static origin can be as an OpenID Provider

- Status: Accepted
- Date: 2026-10-04
- Builds on: [ADR 0090](0090-static-frontend-complete-without-backend.md)
  (the static front end is complete without a backend),
  [ADR 0103](0103-browser-local-identity-passkeys.md)–[0112](0112-local-request-bound-application-consent.md)
  (browser-local IAM: people, applications, grants, consent),
  [ADR 0116](0116-browser-native-siop-v2.md) (browser-native SIOPv2, §5 the
  unimplemented conventional facade) and
  [ADR 0117](0117-hosted-siop-oidc-bridge.md) (the hosted bridge),
  [ADR 0118](0118-device-native-identity-host.md) (the device is the Identity
  host when none is configured),
  [ADR 0130](0130-operator-controlled-capability-composition.md) (ownership of
  every shipped file), [ADR 0138](0138-self-issued-identity-one-native-host.md)
  §3 (the narrow local OpenID provider),
  [ADR 0139](0139-one-definition-every-target.md) (one definition, every
  target), [ADR 0140](0140-pages-hosts-every-ceremony.md) D11 (`.well-known` on
  GitHub Pages)
- Companion: the ADR *The device identity plane is declared* says what a
  device's own identity plane is; this one says what the **static origin** of
  that plane offers a relying party on another origin, and what it cannot.

## Context

The owner's requirement: *the PWA/Pages site should be able to act as its own
identity provider without any external identity service.*

Pages is already an authorization endpoint, in two shapes. `/identity/authorize`
is the local-IAM popup (PKCE, an exact-origin `MessagePort` handshake, ADR
0107–0112). `/identity/siop` is a Self-Issued OP (ADR 0116): the vault signs an
ES256 ID Token and the browser is redirected to the application's callback with
it in the URL fragment. Both are consent screens a person drives; neither
needs a server.

What Pages cannot be is a **conventional OpenID Provider** for a relying party
on another origin: one an off-the-shelf OIDC library points at, which then
fetches discovery, redirects with `response_type=code`, POSTs to a token
endpoint from its back end, and verifies the result against a `jwks_uri`. Four
facts, each about the medium rather than about missing code, are why:

1. **There is nothing to POST to.** A relying party's token request is a
   server-to-server HTTPS request to the issuer's host. For a static host that
   host is GitHub Pages (or any CDN), which has no code to run for it. The
   service worker (`apps/pages/src/sw`) does not help: it is a proxy for pages
   *one browser* has open and answers same-origin GETs from its own cache. A
   request that comes from someone else's server never passes through any
   browser's worker.
2. **There is no key set to publish.** The signing key is per person and per
   application (ADR 0116 §3) and lives in that person's encrypted vault, in
   that person's browser. The origin is shared by everyone who uses the
   deployment (`shared_origin_demo`, [Pages origin](../operators/pages-origin.md)).
   A static `jwks_uri` cannot list keys the origin has never seen.
3. **The discovery path is not ours to serve.** OpenID Connect Discovery
   appends `/.well-known/openid-configuration` to the issuer; RFC 8414 inserts
   `/.well-known/<suffix>` between the host and the issuer's path. The issuer
   here is `<origin><base>identity/siop` (the consent route is the issuer, and
   `base` is `/OpenSesame/` on the shipped deployment). The RFC 8414 form is a
   host-root path a project page does not own (ADR 0140 D11). The OIDC form is
   under the base, so a project page could in principle serve it; the findings
   below say why this deployment does not.
4. **A fragment response is not a code flow.** SIOPv2's same-device response
   is an implicit-style `id_token` in the fragment (ADR 0116 context). That is
   what a static origin can produce, and it is a different protocol from the
   code flow conventional libraries implement, not a degraded version of it.

ADR 0116 §5 and ADR 0117 §5 record the *browser-signed conventional facade* as
unimplemented and disabled. This ADR says why that stays true for a static
origin, writes down exactly what is offered instead, and makes it testable by a
relying party on another origin.

## Findings

Measured on 2026-10-04. Nothing below is inferred from documentation alone,
except the one row marked *not tested*.

| Question | Finding |
|---|---|
| What does the deploy workflow publish? | `deploy-pages.yml` builds `apps/pages` and uploads `apps/pages/dist` with `actions/upload-pages-artifact` pinned at `fc324d35…` (v5.0.0), then `actions/deploy-pages`. The path is `/OpenSesame/`; `404.html` is a copy of `index.html`. |
| What does that upload step do with dot-entries? | Its `action.yml` at the pinned SHA archives with `tar … --exclude=.git --exclude=.github --exclude='.[^/]*' .` unless `include-hidden-files: true`, an input this workflow does not set. Run locally (GNU tar 1.35) over a directory holding `.well-known/x.json`, `identity/siop/.well-known/openid-configuration`, `.nojekyll`, `siop/metadata.json` and `index.html`: the three dot-entries are **dropped at every depth** and the two ordinary files kept. With `include-hidden-files: true` all five are kept. |
| What does the live site answer? | `curl` against `tyler-r-kendrick.github.io`: `/OpenSesame/os-runtime-config.json` and `/OpenSesame/security-profile.json` are `200 application/json; charset=utf-8` with `access-control-allow-origin: *` and `cache-control: max-age=600`. `/.well-known/openid-configuration` (host root), `/OpenSesame/.well-known/openid-configuration` and `/OpenSesame/identity/siop/.well-known/openid-configuration` are all `404`. |
| Is the issuer URL itself a `200`? | No: `/OpenSesame/identity/siop` is **`404`** (`text/html`, the SPA fallback `404.html`), as every deep link on GitHub Pages is. A browser renders the app; a server that GETs the issuer URL sees a 404. A relying party must not treat "the issuer answers 200" as a health check. |
| Does a static answer carry CORS? | Yes: `access-control-allow-origin: *` on every answer above, 404s included. A browser relying party can read a static document cross-origin. |
| Would Pages serve a `.well-known` directory if one were uploaded? | **Not tested.** Nothing was deployed from here. It is moot for the host root (a project page does not own it) and the default upload step would drop the directory first. |
| Vercel? | The same build served at the host root (`vercel.json`). Its SPA rewrite already excludes `/.well-known/`, so a Vercel deployment *can* serve host-root and path-appended `.well-known` files (ADR 0140 D11 uses this for authenticator associations). |

## Decision

### 1. What Pages offers a relying party, in this shape and no other

| Offer | For | Shape |
|---|---|---|
| **(a) SIOPv2 for RP back ends** | A server that wants to know *which key* answered | Redirect the browser to `<origin><base>identity/siop` with `response_type=id_token`, `client_id`, `redirect_uri`, `scope=openid`, `nonce`, `state`, `response_mode=fragment`. The browser returns to `redirect_uri` with `#id_token=…&state=…`. The ID Token is ES256, `iss` the issuer above, `i_am_siop: true`, `sub` the RFC 7638 thumbprint of `sub_jwk`, `aud` the `client_id`, `nonce` echoed. Verified with `verifySelfIssuedIdToken` (`@opensesame/siop-v2`) from the `sub_jwk` it carries, never a `jwks_uri`. |
| **(b) The local-IAM popup SDK** | A single-page app that wants a session it can *use* (check, revoke) | `@opensesame/static-auth` `signInLocalBrowser`: a popup to `/identity/authorize`, PKCE, an exact-origin `MessagePort` the issuing tab keeps open. No bearer reaches the RP's server; the grant lives in the issuer tab (ADR 0107). |
| **(c) A metadata document** | Anyone who wants to read the above off the deployment instead of out of a README | `<origin><base>siop-metadata.json`, below. |

What (a) proves, exactly: someone who held the vault holding the key behind
`sub` passed a passkey check and clicked Allow, for *this* `client_id` and
*this* `redirect_uri`, in answer to *this* `nonce`. It does not prove an email
address, a name, or anything else: ADR 0116 §4 mints no profile claims. `sub`
is **pairwise** per person and application, so two relying parties cannot
correlate a person, and one person with two registered applications is two
subjects at the same relying party (the cross-origin journey asserts it).

**The person registers the application, not the relying party.** `client_id`
is `local_<uuid>`, minted by the person's own vault when they create an
application in Identity › Applications, together with the exact
`redirect_uri`s and `openid` (ADR 0106). There is no endpoint a relying party
can register itself at (`registration`, `registration_uri` and `request_uri`
are refused, `SUPPORT_MATRIX`). Consequences, stated plainly:

- This is a *your own login for your own applications* profile, or a login a
  relying party's users set up one by one. It is not *Sign in with OpenSesame*
  for strangers: a relying party cannot ship one fixed `client_id` that every
  visitor's vault already knows.
- A relying party for several people takes each person's application id per
  login (`startLogin({ clientId })`), and binds the audience to the id *that
  login sent*, not to a global.
- A first-contact registration prompt (an unknown `client_id` and exact
  `redirect_uri` shown to the person to accept) would lift this. It reaches into
  ADR 0106's admission rules and is **not decided here**.

### 2. The relying-party kit

`@opensesame/siop-v2` carries the relying-party half as well as the verifier,
because `verifySelfIssuedIdToken` cannot know which login a token answers:

- `SiopRelyingParty` (`createSiopRelyingParty`): `startLogin()` mints a fresh
  `state` and `nonce`, remembers them with the `client_id` and exact
  `redirect_uri`; `completeLogin()` takes the state **first** (single use),
  then compares the `redirect_uri` the *route* received the response on, then
  refuses a token already seen, then verifies issuer, audience, nonce,
  freshness and signature. A login that fails three times is closed.
- `MemoryLoginStore`, `MemoryReplayLedger` (bounded), `StorageLoginStore`
  (`sessionStorage`, for a single page): the interfaces `SiopLoginStore` and
  `SiopReplayLedger` are where several server instances share state. A store
  must give `take` a single winner; that property *is* the replay defence for
  the state, and the ledger still refuses a token twice if a store fails it.
- Discovery consumer: `fetchSiopMetadata` / `parseSiopMetadata`, with an
  injected `fetch`, no redirects, an 8 KiB bound, and the **issuer pinned by
  the relying party**. A document that names another issuer, an authorization
  endpoint on another origin, or promises something the kit cannot consume is
  refused whole. A SPA fallback served in place of a missing file is refused
  as not JSON.
- Two copy-ready examples, `examples/siop-rp`: an Express server (`src/app.ts`,
  routes only) and a single-page app (`src/spa`). Guide:
  [Use OpenSesame Pages as your login](../operators/use-pages-as-your-login.md).

Refusals are stable machine-readable codes: `SiopRpError.code` for the login
(`login_unknown`, `login_replayed`, `login_expired`, `redirect_mismatch`,
`token_replayed`, `provider_error`, `missing_state`, `invalid_configuration`)
and `SiopV2Error.code` for the token (`nonce_mismatch`, `audience_mismatch`,
`issuer_mismatch`, `token_expired`, `token_not_fresh`, `signature_invalid`,
…). Neither carries token contents.

### 3. What the discovery document honestly says

A build publishes `siop-metadata.json` at the base path. Its shape is
**SIOP-shaped metadata, not OpenID Connect Discovery**:

```json
{
  "issuer": "https://tyler-r-kendrick.github.io/OpenSesame/identity/siop",
  "authorization_endpoint": "https://tyler-r-kendrick.github.io/OpenSesame/identity/siop",
  "response_types_supported": ["id_token"],
  "scopes_supported": ["openid"],
  "subject_types_supported": ["pairwise"],
  "id_token_signing_alg_values_supported": ["ES256"],
  "subject_syntax_types_supported": ["urn:ietf:params:oauth:jwk-thumbprint"],
  "response_modes_supported": ["fragment"],
  "opensesame": { "conventional_oidc": false, "client_registration": "…", … }
}
```

- It has **no `jwks_uri` and no `token_endpoint`**, and says
  `opensesame.conventional_oidc: false`. A generic OIDC client that needs
  either must not be pointed at it; `jwks_uri` is REQUIRED by OIDC Discovery,
  so this document is deliberately not one.
- The capability fields are `STATIC_SIOP_METADATA` minus `issuer` and
  `authorization_endpoint`, spread (`discovery.ts`). One definition (ADR 0139):
  the draft static document and the published one cannot drift, and a unit test
  enumerates every key.
- It lives at `<base>siop-metadata.json`, **not** under `.well-known`. The
  findings are why: the pinned upload step drops every dot-entry, and a
  document at `…/identity/siop/.well-known/openid-configuration` would claim to
  be what it is not. `verify:siop` asserts the built `dist/` contains no
  `.well-known`.
- It is **generated at build time** by a Vite plugin
  (`apps/pages/scripts/siop-metadata-plugin.mjs`), from the kit, for the
  deployment's origin and base. Origin comes from `PAGES_CANONICAL_ORIGIN`
  (the variable `security-profile.json` already reads). A build under the
  shipped base `/OpenSesame/` with no variable names the shipped project; a
  build under any other base with no variable publishes **nothing** and warns,
  rather than a document naming an issuer it is not. The dev server serves the
  same path from the origin it is reached on.
- Ownership (ADR 0130): `PUBLIC_FILE_OWNERSHIP["siop-metadata.json"]` is
  `identity.siop`, a generated file (`GENERATED_PUBLIC_FILES`); a hardened build
  that excludes the capability prunes it.
- The issuer's own URL stays a `404` on GitHub Pages (finding above); the
  document does not paper over it.

### 4. Explicit non-goals

None of these is "not yet". Each is a property of a static origin, or a trust
decision this ADR refuses.

| Non-goal | Why |
|---|---|
| A conventional `token_endpoint` | Nothing answers a server-to-server request on a static host; the service worker is per browser and sees no such request. |
| A per-person `jwks_uri` on the shared origin | The keys exist only in each vault. A key set the origin did publish would have to be the origin's own key, which makes it a hosted OP (ADR 0117), not a self-issued one. |
| A service-worker token endpoint | Same reason as the first: a worker answers only requests made by pages that browser controls, and an RP server's request is not one. |
| `/.well-known/openid-configuration`, host root or path-appended | Not served by a project page; dropped by the deploy step; and the document would be false. |
| The authorization-code flow, refresh tokens, `userinfo`, logout/session endpoints | Need a back channel. Access that must be *used* is the popup SDK (b). |
| Profile claims (`email`, `name`) | ADR 0116 §4: self-asserted, not minted; email auto-link is forbidden (ADR 0117). |
| Dynamic client registration | The person registers the application (ADR 0106). |
| Claiming OIDC or SIOPv2 conformance | SIOPv2 is an Implementer's Draft; no conformance suite was run against Pages. Say "SIOPv2 (Implementer's Draft)", never "OIDC provider". |

### 5. The closest alternatives, when a conventional OP is needed

- **Native host as the local OP (ADR 0138 §3).** The Rust host serves a narrow
  OpenID provider on a loopback issuer: code + PKCE S256, ES256, discovery and
  JWKS, pairwise `sub` derived from the person's thumbprint, consent on Pages.
  It has a server, so every fact in the context holds in its favour. It is for
  local apps, CLIs and agents on that machine, not for sites on the internet.
  ADR 0138 is *Proposed*; the provider is phase 4 of
  `docs/implementation/native-host`. This ADR does not implement it.
- **The hosted bridge (ADR 0117) and Identity API.** A conventional hosted OP
  that links a verified SIOP subject to a principal. Its signing key is the
  trust root for its clients; that is custody of *trust*, not of the person's
  key, and it is the right answer when a third party needs standard OIDC.
- **The popup SDK (b)** when the relying party is a single-page app that needs
  a session, not just a subject.

### 6. Caveats a relying party must carry

**The issuer is the origin plus the base path.** `https://a.github.io/OpenSesame/identity/siop`
and `https://b.github.io/OpenSesame/identity/siop` are different issuers. A
fork, a custom domain, a moved repository or a changed `VITE_BASE` is a
different issuer. The vault, and so every key, is per-origin browser storage,
so a different origin starts with different keys and different `sub`s; even a
vault restored from backup keeps its keys but changes `iss`, and a relying
party pinned to the old issuer refuses it. Changing the issuer is a migration
the relying party opts into; there is no redirect from an old issuer to a new
one. A fork sets `PAGES_CANONICAL_ORIGIN` (and its base) in its own deploy.

**The WebAuthn RP ID is the host.** The passkey that gates consent is scoped
to the origin's effective domain, `tyler-r-kendrick.github.io`, which every
Pages project of that account shares; a custom domain or fork has a different
RP ID and cannot use passkeys registered at another. A passkey sync provider
does not carry a credential across RP IDs. On the shared origin, paths do not
isolate storage or script (ADR 0090 and the Pages origin guide): a dedicated
origin is the way to give the vault its own boundary.

### 7. Design note, unproven and not shipped: a relay on the Vercel deployment

The survey flagged "a stateless relay under `apps/pages/api`" as the one route
by which Pages could present a *conventional* OP shape. Not built; recorded so
its constraints are not rediscovered.

- **Stateless is not enough.** RFC 6749 §4.1.2 requires an authorization code
  to be single use and the server to deny a second use. A function with no
  store cannot; it needs a durable store (Vercel KV or Blob) for a replay
  ledger at minimum. ADR 0116 §5 already rejected a process-local socket map
  for the same reason.
- **Two shapes, with different trust.**
  *V1, relay signs.* Browser consents; the relay verifies the SIOP token and
  signs an ordinary OIDC ID Token with its own key (a secret in the Vercel
  project). That is ADR 0117's hosted bridge in a function: a hosted OP whose
  signing key is the trust root. It works, it needs a replay store, and it is
  not "the static origin acting as its own provider".
  *V2, browser signs, relay parks.* The browser signs, the relay stores the
  token against the code and publishes the person's public key in a `jwks_uri`
  so a conventional library can verify it. The relay then decides which key a
  `kid` names, so a conventional library trusts the relay for the binding of
  key to `sub`; an RP that also checks `sub == thumbprint(jwk)` would not need
  to, but a stock library does not. The browser need only be online at consent.
- **Host root.** On Vercel the issuer can sit at the host root and serve
  `/.well-known/openid-configuration` and a real `/token`. None of that exists
  on GitHub Pages.
- **Open questions**: where the replay ledger lives and its retention, how the
  `jwks_uri` is bounded as people accumulate, PKCE S256 binding at park time,
  `iss` stability across deployments, logout, abuse limits on an
  unauthenticated `/token`, and a conformance run, none of which has been done.

## Testing, and what is not claimed

- `packages/siop-v2`: unit tests for the metadata builder, the consumer (every
  refusal), the relying-party kit (wrong nonce, audience, issuer, redirect_uri;
  expired, from-the-future and tampered tokens; replay of a response, of a token
  across logins, and through a store that is not single use; a lost race;
  attempt limits; per-person audience; configuration; bounded memory).
- `examples/siop-rp`: the Express app over real HTTP, and the single-page flow
  with injected storage, clock and `fetch`.
- `pnpm --filter @opensesame/pages verify:siop`: the example Node RP as its own
  process and the example SPA on its own origin sign in against the built
  Pages app with a virtual authenticator. It reads the built
  `siop-metadata.json` through the kit's consumer (and checks it byte for byte
  against the kit's own output), and provokes each refusal through the real
  ceremony: wrong nonce, audience and redirect_uri, a replayed response and a
  replayed token, a tampered signature, an expired token (the browser's clock
  two hours back), an unregistered redirect_uri refused by Pages with nothing
  sent to the RP, no Allow without a passkey and no token without a click, Deny
  reaching the RP as `access_denied`, a locked vault issuing nothing. It also
  failed, as it should, when the redirect_uri check was disabled.
- Agents: `identity.local.siop.authorize` is excluded from every agent surface
  (`packages/capability-registry`), and `approveSiopAuthorization` refuses a
  non-passkey session (`siop-authority.test.ts`).
- **Not claimed:** OIDC Core, Discovery or any OpenID conformance profile;
  that a given third-party OIDC library works against Pages (it will not);
  that GitHub Pages would serve an uploaded `.well-known`; anything about the
  Vercel relay.

## Consequences

- A relying party on another origin has a documented, tested way to accept a
  Pages login, a kit to copy, and a document it can read off the deployment.
  What it gets is a proven key and a pairwise subject, nothing more.
- The requirement as worded, *Pages as a conventional identity provider for
  anyone's relying party with no service of any kind*, is **not met and cannot
  be on a static origin**. What is met is: Pages is its own self-issued
  identity provider for relying parties that speak SIOPv2 or embed the popup
  SDK, with no external identity service. Copy that says more is a regression.
- Operators who need conventional OIDC choose the native host (local), the
  Identity API (hosted), or accept a hosted relay's trust model (§7).
- `siop-metadata.json` joins the shipped files, owned by `identity.siop`.
  Forks and other bases set `PAGES_CANONICAL_ORIGIN` or ship none.
- Settings › Capabilities, the tutorial and the registry say *SIOPv2
  (Implementer's Draft)* and *not a conventional OpenID Connect provider* where
  a capability is described; screens carry no explainer (ADR 0158, design
  rules); the explanation lives here and in the guide.
