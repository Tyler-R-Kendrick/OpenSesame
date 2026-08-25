# ADR 0055: Provider registry, bring-your-own issuers, and organization sign-in

## Status
Accepted

## Context
ADR 0052 gave the hosted login page a server-side relying-party leg. It could reach exactly
one kind of upstream: an issuer listed in the `OPENSESAME_TRUSTED_UPSTREAMS` CSV, reached as
a secret-less origin-profile client, or — for one issuer only, named by the
`OPENSESAME_UPSTREAM_*` triple — as a confidential client. In practice that meant `shoo.dev`
in production and the local mock IdP in development, and nothing else. "Sign in with Google"
worked only because `shoo.dev` fronts Google.

Three separate things were missing.

**A catalog.** Every deployment offers whatever brokers its operator configured, and there
was no way to configure a second one, no way to say what a button should be called, and no
way to express a provider that speaks plain OAuth2 rather than OIDC.

**A way in for a visitor whose IdP nobody configured.** A first-time visitor with their own
Keycloak or Authentik had no path at all.

**Durable tenant configuration.** `organizations` carried `ssoIssuer`/`samlIssuer` only in
process memory, so tenant SSO evaporated on restart even with `DATABASE_URL` set. And the
tenant join route (`POST /v1/organizations/tenants/:slug/join`) verified an id_token's
signature and issuer and then stopped: it never asked whether the issuer was trusted, never
checked `aud` or the token's age, and never bound the asserted subject to the calling
principal. An attacker holding any id_token that issuer ever minted — for any audience, of
any age, naming anybody — could buy membership with it.

## Decision

### 1. A provider registry configured by flat environment variables
`OPENSESAME_PROVIDERS` lists the provider ids on offer; each id `x` is configured through
`OPENSESAME_PROVIDER_X_*` variables. `google`, `microsoft`, `github` and `apple` carry
built-in defaults (issuer, kind, endpoints, scopes), so a real deployment usually supplies a
client id and a secret and nothing else. Any other id is fully generic.

A flat scheme rather than one JSON blob in one variable, for a reason that is not
cosmetic: this repository's configuration contract is the `.env.schema` env-spec, where every
variable carries `@type`, `@required`, `@sensitive` and `@public` annotations, and tooling
reads those annotations per variable. A JSON blob is one variable, so it is one annotation:
either the whole provider catalog is `@sensitive` — including the labels and issuers that
belong in a public deployment manifest — or none of it is, including the client secrets. The
flat scheme lets `OPENSESAME_PROVIDER_GOOGLE_CLIENT_ID` be `@public` and
`OPENSESAME_PROVIDER_GOOGLE_CLIENT_SECRET` be `@sensitive`, which is what they are. It also
makes a secret injectable on its own by whatever holds secrets in a given deployment, without
that system having to know how to splice a value into a JSON document.

A provider entry that configuration cannot satisfy refuses the boot
(`ProviderConfigError`), rather than surfacing later as a sign-in that fails for one user at
a time.

### 2. `resolveTrustedIssuer` is the single trust fence
"May we federate to this issuer?" now has three legitimate answers, resolved in a fixed order
of authority by `interactions/trust.ts`:

1. the static registry — configured providers, plus allowlisted issuers with no registry
   entry;
2. a durable bring-your-own record, and only while its `state` is `active`;
3. an organization's configured `ssoIssuer` or `samlIssuer`.

Anything else resolves to `undefined`, which every caller maps to `untrusted_issuer`. Issuers
are compared trailing-slash-normalized, because `https://idp.example` and
`https://idp.example/` are the same issuer and a fence that disagrees is a fence with a hole
in it. The order matters: an operator-configured provider must never be shadowed by a BYO
record or an org row naming the same issuer, because the operator's entry is the one carrying
the client credentials.

**The static set must include synthesized descriptors for allowlisted issuers that have no
registry entry.** This is the compatibility hinge of the whole change. A deployment running
today has `OPENSESAME_TRUSTED_UPSTREAMS=https://shoo.dev` and no `OPENSESAME_PROVIDERS` at
all; if trust resolution consulted only registry entries, that deployment's every sign-in
would answer `untrusted_issuer` the moment this ships. So `staticProviders` walks the
allowlist first and synthesizes a descriptor for any issuer the registry does not describe: a
public origin-profile client (`clientAuth: "none"`), or the confidential legacy credential
when `OPENSESAME_UPSTREAM_*` names exactly that issuer. The synthesized id and label match
`describeUpstream` and the Pages `TRUSTED_UPSTREAMS` table, so shoo.dev keeps saying "Google"
on all three surfaces.

The converse also holds: `loadConfig` merges every registry issuer into
`trustedUpstreamIssuers`. A configured provider is a trusted provider by construction —
otherwise an operator could list `google` in `OPENSESAME_PROVIDERS`, watch every sign-in be
refused, and read nothing about why. `assertSecureConfig` then re-checks each descriptor, so a
config assembled some other way (a `Partial` merge in a test, a future caller) cannot smuggle
a half-configured or credential-bearing untrusted provider past the boot.

### 3. `kind: "oauth2"`, and subject stability as a rule
GitHub issues no id_token. There is no assertion to verify and nothing for `openid-client` to
do: the protocol is a code, a server-side exchange, and one authenticated read of a userinfo
document — and that read *is* the assurance. It lives in `interactions/oauth2.ts`, beside the
OIDC leg rather than inside it, because the OIDC leg's entire security argument is the
JWKS-verified id_token and a module that could take either path would eventually take the
weaker one by accident. PKCE S256, byte-equal `state`, a server-side exchange with the secret
in the POST body, and descriptor-pinned endpoints all still hold.

The subject is `String(profile[subjectField])`, and which field that is, is a security
decision the descriptor states explicitly. For GitHub it is `id` — numeric and immutable —
never `login`, which its owner can rename and which someone else can then register. Binding
to a renameable subject hands the account to whoever claims the released name next. Structured
values are refused rather than coerced: `String({…})` is `[object Object]`, the same subject
for every account on that provider.

Two GitHub wire quirks are handled here and nowhere else: the token endpoint answers
form-encoded unless the request asks for JSON (we ask, and still read the form encoding), and
protocol errors arrive as HTTP **200** with an `error` key in the body, so the body is
inspected before the status. The leg never calls `/user/emails`; a private profile email is
simply absent.

### 4. Apple: POST → 303 → GET, and an ES256 client secret
Apple returns the authorization response as a `response_mode=form_post` — a cross-site POST
from `appleid.apple.com`. Both the `os.fed.<uid>` pending cookie and oidc-provider's
interaction cookie are `SameSite=Lax`, which means **neither is on that request**. A handler
that completed the sign-in in the POST would pass a same-origin test and fail against real
Apple every single time.

So `POST /interaction/:uid/federated/callback` does no completion work whatsoever. It copies
four allowlisted parameters — `code`, `state`, `error`, `error_description`, each
length-capped — into a 303 to the existing GET callback. The browser then makes a top-level
same-site GET, which does carry both cookies, and the unchanged callback runs. It needs no
CSRF token because it exercises no authority: the redirect target is this server's own
callback, and `state` byte-equality against the pending cookie is still the only thing that
decides whether anything completes.

Apple also has no static client secret. What an operator registers is a P-256 signing key, a
key id and a team id; the `client_secret` presented at the token endpoint is an ES256 JWT
minted on the spot (`iss` = team, `sub` = the Services ID, `aud` = `https://appleid.apple.com`,
`kid` = the key id). Apple permits six-month lifetimes; we mint ten-minute ones, cached per
(team, key, client) so the interactive path does not sign per request. A long-lived assertion
would buy nothing — it travels to one endpoint over TLS and is trivially re-mintable — and
would cost a bounded blast radius.

### 5. Microsoft is tenant-pinned, and `common` is refused at boot
`OPENSESAME_PROVIDER_MICROSOFT_TENANT` is required and may not be `common`,
`organizations` or `consumers`. This is not conservatism: the multi-tenant discovery document
publishes the literal template `https://login.microsoftonline.com/{tenantid}/v2.0` as its
`issuer`, and exact-match issuer validation can never satisfy a template. The refusal happens
at config load with a message naming the requirement, and the check reads the tenant segment
after percent-decoding, so a hand-written `_ISSUER` carrying `{tenantid}` is caught too. The
tempting "fix" — relaxing issuer validation — would remove the check that makes an issuer
mean anything.

### 6. Bring-your-own issuers
A visitor posts an issuer URL and optionally a client id and secret to
`POST /interaction/:uid/federated/byo`; the server discovers, optionally registers via
RFC 7591, persists a `byo_upstreams` row, and hands the browser to the ordinary OIDC leg,
admitted by the fence's `byo` branch. Four properties are load-bearing:

- **SSRF.** The issuer is attacker-controlled input that this server then dereferences. Both
  the issuer and the `registration_endpoint` its document names pass `assertSafeMetadataUrl`
  (reused from `@opensesame/oauth-provider`, not reinvented), redirects are refused rather
  than followed — a 302 to `169.254.169.254` would otherwise walk straight past a guard that
  only saw the first URL — and the guard rides along as a custom fetch inside the dynamic
  registration helper, which re-runs discovery itself. Under dev defaults a loopback IP
  *literal* is allowed so the local reference IdP works; names, including `localhost` and
  `*.localhost`, are refused in every mode, because a name can be made to resolve anywhere.
- **The client secret is stored verbatim.** It is presented to the token endpoint as issued,
  so a digest could never be substituted for it — hashing is not a stronger choice here, it is
  an impossible one. The row lives at the same trust boundary as an env-held provider secret;
  it is never logged, never audited, and never returned by any API, including the operator
  admin list.
- **Anti-enumeration.** Registration is idempotent by normalized issuer, and the answer is
  byte-identical whether or not the record already existed. A submitted credential never
  overwrites a stored one, so a stranger who guesses somebody else's issuer cannot swap the
  client out from under it, and a record an operator disabled answers the same refusal a
  stranger's unknown issuer gets rather than being re-created around.
- **A dynamically registered client needs a stable callback.** Every other leg returns to
  `{publicUrl}/interaction/{uid}/federated/callback`, which names an interaction that exists
  for one sign-in. RFC 7591 registers a `redirect_uri` **once**, and the IdP that issued the
  client then matches it exactly, so a per-interaction URI would admit that visitor today and
  be refused by their own IdP tomorrow — durable storage would give re-entry the record and
  nothing to redirect to. So a DCR-registered record registers, redirects to, and exchanges at
  one deployment-wide URL, `{publicUrl}/v1/federated/byo/callback`, which completes nothing and
  303s the browser into the interaction (the same hand-back shape Apple and the SAML ACS use,
  and for the same cookie reason). Which interaction comes from a uid prefix on `state`; the
  whole `state` is still byte-compared against the pending cookie, so the prefix routes without
  weakening the binding. A record whose credentials the *visitor* brought keeps the
  per-interaction callback: they registered a redirect URI at their own IdP, and this server
  does not get to change it under them.
- **A budget in front of the network.** Five registrations per fingerprint per ten minutes,
  module-local, spent by every submission that passes URL validation — including one that
  would have hit an existing row, because answering "already registered" cheaply is what would
  make enumeration free. It sits ahead of the provisional-mint budget, and is not on
  `AppContext`: a per-request context would hand every request a fresh budget, and a
  store-backed one would make an abuse fence depend on the database being up.

### 7. Organizations become durable, and the join is fenced on three axes
`sso_issuer`, `saml_issuer` (and the SAML metadata columns of ADR 0056) are columns on
`organizations`, not a jsonb blob, because they are queried *by issuer* on the login path.
Storage follows the ProjectStore precedent — one interface, a memory implementation and a
Postgres one — so a deployment with `DATABASE_URL` keeps its tenant configuration across a
restart, which it did not before.

The join route keeps its id_token POST (forcing a code flow there would break the working
browser leg in Pages) and gains the three checks it was missing:

- **Audience.** `verifyOrgIdToken` takes `expectedAudiences`, and the join passes the set
  derived from `corsOrigins ∪ publicUrl`, each mapped to `origin:<origin>`. Derived, not
  hard-coded: Pages runs the browser leg with `client_id = origin:<its own origin>`, so the
  audience is the *client's* origin — `http://localhost:5180` in dev — and hard-coding
  `origin:<publicUrl>` would refuse every join from the dev Pages server.
- **Age.** `maxTokenAgeSec: 600`, the same window the interactive round-trip gets.
- **Subject binding.** The asserted subject is bound to the calling principal through
  `attachVerifiedExternalIdentity` before anything is granted. A subject already owned by a
  different principal is a 409 whose message deliberately does not name that principal.

**`nonce` stays unrequired on this path**, deliberately. The browser leg sends none: the code
+ PKCE exchange is what binds that request to that browser, and requiring a claim the working
client never mints would refuse every real join. What replaces it is the combination above —
the token must have been minted for one of our own surfaces, it must be minutes old, and it
must name a subject that is either unowned or already this caller's. Together those close the
window a nonce would have closed, without breaking the leg.

The join and the hosted login page's org completion share one `jitJoinOrganization` helper.
Completing an organization sign-in *is* a join: the tenant's own IdP just vouched for the
subject, so membership follows the sign-in rather than waiting for a separate call, at role
`member`, audited as `organization.member_joined`.

### 8. Brokered session adoption, and why `link-identities` is the wrong door
A static page cannot complete a Google or GitHub exchange itself — those token endpoints
serve no CORS — so it runs the origin-profile code flow against *this* server and lets the
hosted login page run the upstream leg. That works, and leaves one trap.

The id_token it gets back carries a **pairwise** subject minted for the page's own origin
(ADR 0050). POSTing it to `POST /v1/principals/link-identities` would attach that pairwise
identity to whatever provisional session the page happens to be holding — permanently, to the
wrong principal. Cookie resume cannot rescue it either: `os_provisional` is `SameSite=Lax` and
is not sent on a cross-origin XHR from the page's origin.

`POST /v1/principals/federated-session` (C13) is the correct door. The page brings the
**access token** from its code exchange; the route resolves it through oidc-provider's own
store (`provider.AccessToken.find`, which refuses an expired token), reads the `accountId`
that token was issued for, and mints a first-party provisional bearer bound to *that*
principal. No new principal, no new identity row, no claim about who anybody is that
oidc-provider did not already make when it issued the token. The token is the credential, so
the route carries no auth middleware and answers one uniform `invalid_token` for unknown,
expired, wrong-kind and account-less tokens alike.

## Consequences
- Trust resolution now touches storage. Answering "is this issuer trusted?" was a CSV lookup
  and is now potentially two store reads, on the sign-in path. It is cached nowhere on
  purpose: a disabled BYO record or a removed org issuer has to stop working immediately.
- The discovery cache key is `${issuer}|${clientId}`, not the issuer. One issuer can now be
  reached as more than one client — a registry provider for the deployment and a BYO record
  for a visitor — and an `openid-client` Configuration binds the client and its authentication
  method, so keying on the issuer alone would hand the second caller the first caller's
  credentials.
- The deployment stores client secrets it did not configure. BYO records hold a visitor's
  secret, or one RFC 7591 minted; the admin surface can disable a record but the credential
  stays at rest until deleted. This is the price of BYO re-entry working at all, and the
  operator-token-gated `/v1/federated/admin/byo-upstreams` list deliberately omits it.
- Apple, Google, Microsoft and GitHub cannot be verified end to end without live credentials
  (Apple additionally needs a paid developer account). The legs are complete and are exercised
  against the reference IdP's real implementation of each wire behaviour; the live handshake
  is operator-gated and has a runbook (`docs/operators/live-provider-verification.md`).
- Hint ambiguity is now real. `matchProviderHint` freezes precedence at
  id > issuer > host > label, so the day a genuine `google` registry id sits next to
  shoo.dev's "Google" label, the id wins. A matched hint is rendered first and primary and
  never auto-submitted: an upstream error 303s back to the login page, so a page that
  redirected itself would loop forever.
- More of the login page is now an unauthenticated form that does work. Each one carries its
  own fence — a single-use CSRF token reissued on every re-render, a module-local budget, and
  uniform refusal copy — and none of them may report *why* they refused, because on an
  unauthenticated page the difference between "no such thing" and "not yours" is an
  enumeration oracle.

## Related
- ADR 0005 — ConnectionRef / no raw-secret affordance
- ADR 0008 — mature libraries over NIH protocol code
- ADR 0033 — federated identity admission (the allowlist this generalizes)
- ADR 0034, ADR 0050 — origin-profile clients and the static-site issuer
- ADR 0052 — the server-side relying-party leg this extends
- ADR 0056 — native SAML, SCIM, home-realm discovery, back-channel logout
- ADR 0057 — verified-email linking, the Better Auth mount, native LDAP
- `docs/architecture/federated-signin.md` §8–§11 — the wire contract
- `docs/operators/live-provider-verification.md` — live provider runbook
