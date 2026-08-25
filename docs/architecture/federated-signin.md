# Federated sign-in — wire contract

Implements ADR 0033 (federated identity admission) and ADR 0034 (origin-brokered sign-in
for static sites); §7 additionally implements ADR 0052 (federated sign-in on the first-run
and hosted-login surfaces); §8–§11 implement ADR 0055 (provider registry, generic OAuth2,
bring-your-own issuers, organization sign-in), §12–§13 implement ADR 0056 (native SAML SP,
SCIM, home-realm discovery, back-channel logout) and §14 implements ADR 0057 (email
magic-link, native LDAP, verified-email linking). This document is the contract; where code
and this file disagree, one of them is a bug.

## Topology

```text
  ┌────────────────┐   OIDC + PKCE S256    ┌──────────────────────────┐
  │ trusted broker │◄──────────────────────│ OpenSesame PWA           │
  │ shoo.dev       │   CORS POST /token    │ https://<pages-origin>/  │
  │ (or mock IdP)  │──────────────────────►│ one stable origin        │
  └────────────────┘   ES256 id_token      └───────────┬──────────────┘
                                                       │ postMessage
                                      passthrough of   │ to approved
                                      the same token   │ origin only
                                                       ▼
                                           ┌──────────────────────────┐
                                           │ static relying party     │
                                           │ http://localhost:5173    │
                                           │ verifies vs broker JWKS  │
                                           └──────────────────────────┘
```

Only the upstream leg mints anything. The PWA relays; it holds no signing key, because a
static deployment cannot hold one that stays private.

## 1. Upstream contract

A trusted broker is admissible only if it provides all of:

| Requirement | Why |
| --- | --- |
| `GET /.well-known/openid-configuration` | Endpoint discovery, no hardcoding |
| `GET` JWKS at the advertised `jwks_uri` | Relying parties verify without an SDK |
| `GET /authorize` with `code_challenge`/`S256` | Public-client flow |
| `POST /token` **with CORS** | The exchange happens in the browser; without CORS the whole topology fails |
| Asymmetric `id_token` signature (ES256 or RS256) | HMAC would require sharing a secret with a static page |
| A stable per-origin subject claim | Identity that does not correlate across relying parties |

`client_id` is derived, never registered: `origin:{origin}` — e.g.
`origin:https://example.github.io`. There is no registration step and no dashboard.

Configured entries:

| Issuer | Role | `client_id` |
| --- | --- | --- |
| `https://shoo.dev` | Production | `origin:{deployment origin}` |
| `http://127.0.0.1:9090` | Tests and local dev | `origin:{deployment origin}` |

### id_token claims consumed

| Claim | Use |
| --- | --- |
| `iss` | Must equal a configured trusted issuer |
| `aud` | Must equal `origin:{broker origin}` |
| `exp`, `iat` | Freshness |
| `pairwise_sub` | The identity; per-origin and stable |
| `email`, `name`, `picture` | Optional, only when the human consented to PII |

## 2. Broker → relying party

### Request

The relying party opens the broker in a popup:

```text
https://<broker-origin>/OpenSesame/broker/authorize
  ?client_id=origin:http://localhost:5173
  &origin=http://localhost:5173
  &state=<opaque, >=16 bytes of entropy>
  &scope=openid                      # add profile/email to request PII passthrough
```

The broker refuses the request unless `client_id` is exactly `origin:` followed by `origin`,
and `origin` matches the opener's real origin as reported by the browser. A caller cannot
name an origin it is not.

### Response

Delivered by `postMessage` to the requesting origin — never `"*"`:

```jsonc
{
  "type": "opensesame:signin",
  "state": "<echoed verbatim>",
  "id_token": "<the upstream token, unmodified>",
  "issuer": "https://shoo.dev",
  "audience": "origin:https://example.github.io",
  "jwks_uri": "https://shoo.dev/.well-known/jwks.json",
  "expires_at": "2026-08-09T12:00:00.000Z"
}
```

`issuer`, `audience` and `jwks_uri` are conveniences for verification setup. They are not
trusted input: an RP that hardcodes the broker it chose is strictly safer, and the example
RP does exactly that.

### Errors

Same envelope with `error` instead of `id_token`:

| `error` | Meaning |
| --- | --- |
| `origin_mismatch` | `client_id`/`origin` disagree with the real opener origin |
| `consent_denied` | The human refused this origin |
| `consent_required` | Interaction needed and the popup was closed first |
| `upstream_unavailable` | The trusted broker could not be reached |
| `not_signed_in` | Nobody is signed in at the broker origin and sign-in was abandoned |
| `invalid_request` | Missing or malformed `state`, `client_id` or `origin` |

### Fragment fallback

Only when the popup is blocked. The broker redirects to a `redirect_uri` whose origin equals
`origin`, returning the same fields in the **fragment**:

```text
http://localhost:5173/auth/callback#type=opensesame:signin&state=…&id_token=…
```

Weaker than `postMessage`: the assertion lands in the URL, where history and any
`Referer`-leaking navigation can see it. The RP must strip the fragment immediately with
`history.replaceState`.

## 3. Verification, by the relying party

Non-negotiable, in this order:

1. `state` equals what the RP generated, and is then discarded (single use).
2. Signature verifies against the **upstream** JWKS — `shoo.dev`, not OpenSesame.
3. `iss` equals the expected upstream issuer.
4. `aud` equals `origin:{broker origin}` — **the broker's origin, not the RP's**. This is the
   step people get wrong in both directions: verifying against its own origin rejects every
   valid token, and skipping it accepts tokens minted for anyone.
5. `exp` is in the future.
6. `pairwise_sub` is present and a string.

Per-RP subject, derived locally so it rests only on what was just verified:

```ts
const subject = base64url(sha256(`${payload.pairwise_sub}:${location.origin}`));
```

## 4. What an RP may and may not conclude

**May:** that the upstream authenticated this human, and that they approved this origin at
the broker.

**May not:** that the token was minted *for* it. The audience is the broker. Anything holding
this token can act as this user at the broker origin, which is why the broker releases it
only to origins the human approved by name, and why lifetimes are short. An RP that needs a
token minted for itself needs an issuer with a private key, which needs a server — see
ADR 0034 §6.

## 5. Consent

Stored per broker origin, keyed by RP origin:

| Field | Meaning |
| --- | --- |
| `origin` | Exact RP origin, scheme included |
| `scopes` | What was approved; widening re-prompts |
| `approved_at` | When |
| `last_used_at` | Surfaced so a stale grant is visible |

Consent is remembered until revoked, revocable individually from the PWA, and never inferred
from a previous origin. `http://localhost:*` is not blanket-approved: each port is approved
once, by name.

## 6. Failure posture

- No configured trusted broker: the deployment admits no durable users and says so. It does
  not fall back to self-service.
- Upstream unreachable: `upstream_unavailable`, and an already-signed-in human keeps their
  session until the token expires.
- Unlisted issuer: refused even if the signature verifies, per ADR 0033 §2.

## 7. Control-plane relying-party leg (server-side)

Sections 1–6 describe the *browser* leg: a static deployment with no server, relaying a
token it did not mint. This section describes the other leg, decided in ADR 0052 — the
control-plane's hosted login page acting as a real OIDC relying party, server-side, on
`openid-client`. The two coexist and are not interchangeable. Here a code is exchanged by a
server, the assertion never reaches the browser, and the result is a resolved OpenSesame
principal rather than a passthrough token.

Everything in §1 (upstream contract, `client_id` derivation, consumed claims) still holds.
This section adds only what differs because a server is present.

### 7.1 Routes and why they sit where they do

| Route | Purpose |
| --- | --- |
| `POST /interaction/:uid/federated/start` | Begin an authorization-code + PKCE S256 flow against a trusted issuer; respond with a redirect to the upstream `authorization_endpoint` |
| `GET /interaction/:uid/federated/callback` | **Resume**: take `code`/`state`, exchange, resolve a principal, complete the oidc-provider interaction |
| `POST /interaction/:uid/federated/callback` | `response_mode=form_post` re-materialization for a leg that used the per-interaction redirect URI: copies the allowlisted parameters into a 303 to the GET above and completes nothing |
| `GET` and `POST /v1/federated/callback` | **Receive**: the stable, deployment-wide redirect URI every *registered* upstream returns to. Completes nothing; 303s to the interaction callback above — see §8.6 |
| `POST /interaction/:uid/federated/byo` | Register (or recover) a visitor-supplied issuer, then begin the same flow `start` begins — see §7.8 |

**Receiving the upstream's redirect and resuming the interaction are two different steps, and
only the second one is constrained by the cookie.** oidc-provider's interaction cookie is
`SameSite=Lax` and path-scoped to `/interaction/:uid`, so the request that *resumes* an
interaction must be a top-level GET under that path — that constraint is real and unchanged.
Receiving an authorization response needs no cookie at all: it is `code` and `state` in a
query string (or a form body), and the `state` binding is what decides whether anything
completes.

Splitting the two is what makes a registered redirect URI possible. Google, Microsoft Entra
and Apple match a registered URI byte for byte (RFC 6749 §3.1.2; OAuth 2.1 drops the "or a
prefix" reading entirely) and a URI is registered **once** — by an operator in a console, or
by RFC 7591 on a visitor's first BYO sign-in. A path naming the interaction it was registered
from is therefore a redirect URI good for exactly one sign-in, or, where a console demands the
URI before any sign-in exists, none at all. So:

| Trust resolution | Redirect URI |
| --- | --- |
| Static registry provider (§8.1), including the legacy `OPENSESAME_UPSTREAM_*` and allowlist-synthesized descriptors | `{publicUrl}/v1/federated/callback` |
| BYO record with `registrationSource: "dcr"` | `{publicUrl}/v1/federated/callback` |
| BYO record with `registrationSource: "manual"` | `{publicUrl}/interaction/{uid}/federated/callback` |
| Organization issuer (`ssoIssuer` / brokered `samlIssuer`) | `{publicUrl}/interaction/{uid}/federated/callback` |

The two that keep the per-interaction path do so because something outside this server already
depends on it: a visitor who brought their own client registered a redirect URI at their own
IdP, and a tenant configured its issuer against a deployment already running this leg. §8.6
covers the consequence for a tenant whose IdP demands exact-match registration.

### 7.2 Pending-state cookie

Between `start` and `callback` the flow's pending state is held in a cookie, never in
server memory and never in the URL:

| Attribute | Value |
| --- | --- |
| Name | `os.fed.<uid>` — one per interaction |
| Contents | `issuer`, `state`, `nonce`, PKCE `code_verifier` |
| `HttpOnly` | Yes — script must not read the verifier |
| `SameSite` | `Lax` — the callback is a top-level cross-site GET redirect, which `Lax` permits and `Strict` would drop |
| `Path` | `/interaction/<uid>` — one interaction's pending state is never sent with another's request |
| Max-Age | `600` seconds |
| `Secure` | Set when the configured public URL is `https`; omitted for plain-http local dev, where it would make the cookie unusable |

The cookie is cleared once the callback consumes it, successfully or not. Its `state` must
equal the `state` returned by the upstream: the binding is what makes tampering
self-defeating, since replacing either half alone breaks the pair. `nonce` must equal the
`nonce` claim of the returned `id_token`. A missing, expired, or mismatched cookie is a
refusal, never a fresh flow — restarting silently would discard exactly the binding that
protects the exchange.

### 7.3 Token request

`POST {token_endpoint}` carries `grant_type=authorization_code`, the `code`, the
`redirect_uri` used in `start`, the `code_verifier`, and `client_id`.

The request **must** carry an explicit `Origin` header equal to the deployment origin
whenever `client_id` is `origin:<origin>`. The broker enforces origin equality on `POST
/token` and answers `403 unauthorized_client` / `origin_cors_denied` when the header is
absent or disagrees (see `apps/mock-upstream-idp/src/server.ts`). A browser sets that header
for itself; a server-side HTTP client does not, so the RP sets it deliberately. `Origin` and
the origin embedded in `client_id` are the same string, and the exchange fails closed rather
than retrying without it.

### 7.4 Confidential-client fallback

When `OPENSESAME_UPSTREAM_ISSUER`, `OPENSESAME_UPSTREAM_CLIENT_ID`, and
`OPENSESAME_UPSTREAM_CLIENT_SECRET` are **all three** set, the leg authenticates to that one
issuer as a confidential client (`client_secret_post`) instead of deriving
`origin:<origin>`. This exists for a broker that cannot serve the secret-less origin-profile
contract.

The two modes are exclusive per issuer, chosen by configuration and never negotiated at
runtime. The issuer is matched **exactly**, so a secret is never offered to an issuer it was
not configured for; a client id with no secret stays the origin-profile case, and a secret
with no issuer has nobody it may legitimately be sent to, so both are ignored.

A confidential exchange does **not** send the `Origin` header of §7.3: that header is what
binds an origin-profile client, and a confidential client is bound by its secret instead —
claiming a browser origin it does not have would be a false assertion.

`assertSecureConfig` refuses to boot when the credentialed issuer is absent from
`OPENSESAME_TRUSTED_UPSTREAMS`. A credential configured for an untrusted issuer is dead
weight at best and an exfiltration target at worst. There is no separate HTTPS assertion for
the credentialed issuer: listing it is mandatory, and in production every allowlist entry is
already required to be HTTPS, so the combination cannot slip through either way.

### 7.5 Assertion validation

> **Trust now resolves through §8.** Where this section says "present in
> `OPENSESAME_TRUSTED_UPSTREAMS`", the question is answered by `resolveTrustedIssuer`
> (ADR 0055), which admits an issuer from the static registry, a durable bring-your-own
> record, or an organization's configured issuer. The allowlist remains the static half of
> that answer and every registry issuer is merged into it, so a deployment configured only
> with the CSV behaves exactly as this section describes. See §8.2.

Before any principal is touched, in this order:

1. `state` from the callback equals `state` from the `os.fed.<uid>` cookie.
2. The `id_token` signature verifies against the issuer's published JWKS, discovered from
   `/.well-known/openid-configuration` — never from a hardcoded key.
3. `iss` equals the pending issuer, **and** that issuer resolves through the trust fence
   (§8.2). A signature only proves who signed; the fence decides who is trusted
   (ADR 0033 §2). In production every allowlist entry and every registry issuer must be
   https, enforced at boot by `assertSecureConfig`, and the allowlist must be non-empty.
4. `aud` matches the client id actually used for the exchange.
5. `nonce` equals the pending `nonce`.
6. `exp` is in the future.
7. The subject claim is present and a string.

Any failure ends the interaction with an error. There is no partial admission.

### 7.6 Principal resolution

Keyed on the external-identity tuple `(kind, issuer, tenant?, subject)`. Since ADR 0057 a
*verified* email is a secondary join consulted only after that tuple misses — see §14.3 for
the exact policy and for the callsite obligation it creates. An **unverified** email still
links nothing (ADR 0033, `docs/identity-linking.md`).

| Case | Outcome |
| --- | --- |
| Tuple already bound to a principal | Reuse that principal unchanged. No new principal, no re-linking, `principalId` stable. |
| No tuple, no principal | Mint a principal `state: "provisional"` / `assurance: "provisional"`, bind the tuple, then promote **in place** to `state: "active"` / `assurance: "verified"` with `principalId` unchanged. |
| Bound principal is `suspended` or `closed` | Refuse. A valid assertion does not reinstate a principal an operator disabled; reinstatement is an operator action. |
| Tuple bound to a *different* principal than the interaction's current one | `409` conflict. Do not echo the bound `principalId` — that would let a caller enumerate which principal owns an upstream identity. Merging requires dual authentication. |
| Concurrent callbacks racing to bind the same tuple | The losing write is a conflict and is surfaced as one. Never retried into a second principal for the same tuple. |

The mint-then-promote pair is one logical admission, not two steps a caller can drive: a
provisional principal still cannot promote itself (ADR 0033 §3). Promotion here rests on the
assertion validated in §7.5 and nothing else. `principalId` surviving promotion is what keeps
anything done provisionally from being orphaned by signing in.

### 7.7 What this leg does not do

It does not decrypt or unseal any client-side vault. Federated sign-in establishes identity;
the vault is device encryption with a separate key hierarchy, and no broker assertion is an
input to it. On the Pages first-run surface the federated path therefore creates the same
ephemeral guest vault as "Continue as guest", and sealing remains a later, separate step
(ADR 0052 §1).

### 7.8 Bring-your-own issuer (`POST /interaction/:uid/federated/byo`)

A visitor with no account may name their own OIDC issuer on the hosted login page —
their Keycloak, their Authentik, their employer's IdP — and sign in with it (ADR 0055).
The form carries `issuer` and, optionally, `client_id` and `client_secret` they
registered at that IdP, plus the interaction's single-use `_csrf` token. It is a plain
form POST because the hosted pages run under `default-src 'none'` with no `script-src`.

| Step | Behaviour |
| --- | --- |
| URL fence | Both the issuer and the `registration_endpoint` its discovery document names pass `assertSafeMetadataUrl`: loopback, private, link-local, cloud-metadata and their decimal/IPv6-mapped spellings are refused, and `https` is mandatory. A deployment running with dev defaults additionally accepts a loopback IP **literal** (127/8, `::1`) so the local reference IdP works; names such as `localhost` and `*.localhost` are refused in every mode. |
| Abuse fence | A module-local per-fingerprint budget — 5 registrations per 10 minutes — spent by every submission that passes URL validation, ahead of the provisional-mint budget. Exhaustion re-renders the form; nothing is fetched. |
| Discovery | `{issuer}/.well-known/openid-configuration`, redirects refused, 5s timeout, and the document's own `issuer` must match what was typed. |
| Credentials | A supplied `client_id` is stored as given (`client_secret_post` when a secret came with it, otherwise a public client). With no `client_id`, RFC 7591 dynamic client registration is attempted when — and only when — discovery advertises a `registration_endpoint`, preferring `client_secret_post` and falling back to `none`, registering the deployment-wide `{publicUrl}/v1/federated/callback` as the `redirect_uri` (§8.6). With neither, the submission is refused and the visitor is asked for a client id. |
| Persistence | One `byo_upstreams` row per trailing-slash-normalized issuer, `state: "active"`. The client secret is stored verbatim: it must be presented to the token endpoint as issued, so it cannot be hashed. It is never logged, never audited and never returned by any API. |
| Re-entry | A second submission naming the same issuer reuses the existing row unchanged — no re-registration, and a submitted credential never overwrites the stored one. The answer is identical whether or not the row already existed: which issuers a deployment has seen is not something an unauthenticated page reveals. |
| Refusals | Re-render the login page with **422** and a **fresh** CSRF token — the submitted one was consumed by the verify — with the rejected issuer echoed back into the field. |
| Success | Sets the §7.2 pending cookie (`byoId` recorded on it) and 303s to the upstream. From there the flow is §7.3–§7.6 unchanged; the issuer is admitted by the bring-your-own branch of trust resolution, and completing the leg stamps the record's `lastUsedAt`. |

The client mode is the record's own — the visitor's `client_id` at their IdP, never this
deployment's origin profile, and never the pinned `Origin` header that mode carries (§7.4).
An operator can disable a record afterwards (`byo_upstreams.state`), and a disabled record
resolves for nobody and cannot be re-created around.

## 8. Provider registry and trust resolution (ADR 0055)

§7 described one leg reaching one kind of upstream. This section describes how a deployment
now says *which* upstreams exist and how the server decides whether it may federate to any
given issuer. It supersedes the earlier prose that treats `OPENSESAME_TRUSTED_UPSTREAMS` as
the whole of trust; that CSV is now the static half of a three-part answer.

### 8.1 Configuration

`OPENSESAME_PROVIDERS` is a comma-separated list of provider ids. Each id `x` is configured
by `OPENSESAME_PROVIDER_X_*` variables (id uppercased):

| Variable | Meaning |
| --- | --- |
| `_ISSUER` | Issuer URL. Required for an id with no built-in default. |
| `_LABEL` | Button text — "Sign in with {label}". Defaults to the built-in label, else the id. |
| `_KIND` | `oidc` (default) or `oauth2`. |
| `_CLIENT_ID` / `_CLIENT_SECRET` | Client credentials at that provider. `_CLIENT_SECRET` is `@sensitive` and requires `_CLIENT_ID`. |
| `_SCOPES` | Space-separated scopes. Defaults to `openid email profile` for oidc. |
| `_AUTHORIZE_URL` / `_TOKEN_URL` / `_USERINFO_URL` / `_SUBJECT_FIELD` | oauth2 only; all four required. |
| `_TENANT` | Microsoft only: the tenant id or verified domain the issuer is built from. |
| `_TEAM_ID` / `_KEY_ID` / `_PRIVATE_KEY` / `_PRIVATE_KEY_FILE` | Apple only: the ES256 signing material (see §8.3). |

`google`, `microsoft`, `github` and `apple` carry built-in defaults, so a real deployment
usually sets only a client id and secret. Configuration is validated at boot and a bad entry
refuses the boot rather than failing one sign-in at a time:

| Rule | Behaviour |
| --- | --- |
| Provider id | Lowercase letters, digits and underscores only — the id becomes an environment variable name. |
| Issuer | An http(s) URL carrying no userinfo. In production, https. |
| Two ids, one issuer | Refused. An issuer must map to exactly one provider or trust resolution is ambiguous. |
| `_CLIENT_SECRET` with no `_CLIENT_ID` | Refused — a secret with nobody to authenticate as. |
| oauth2 | `_AUTHORIZE_URL`, `_TOKEN_URL`, `_USERINFO_URL`, `_SUBJECT_FIELD`, `_CLIENT_ID` and `_CLIENT_SECRET` all required. |
| Microsoft `common` / `organizations` / `consumers` (or any `{…}` template in the tenant segment) | Refused, with a message naming the requirement. Those endpoints publish the literal template `https://login.microsoftonline.com/{tenantid}/v2.0` as their `issuer`, which exact-match issuer validation can never satisfy. |
| Apple | `_TEAM_ID`, `_KEY_ID` and a private key (inline or via `_PRIVATE_KEY_FILE`) are required alongside `_CLIENT_ID`, and the descriptor must use `response_mode=form_post`. |
| Any secret-bearing provider | Its issuer must be in `OPENSESAME_TRUSTED_UPSTREAMS`. Not production-gated. Registry issuers are merged into that list automatically, so this fires only for a config assembled some other way. |

The legacy `OPENSESAME_UPSTREAM_ISSUER` / `_CLIENT_ID` / `_CLIENT_SECRET` triple is still
honoured: when all three are set they are absorbed into the registry as one credentialed
provider, unless an explicit entry already claims that id or issuer.

### 8.2 `resolveTrustedIssuer` — the fence

Every leg asks one question before it touches a network, and gets one of four answers:

| Order | Source | Condition |
| --- | --- | --- |
| 1 | `static` | The issuer matches a registry provider, **or** an issuer in `OPENSESAME_TRUSTED_UPSTREAMS` with no registry entry, for which a descriptor is synthesized. |
| 2 | `byo` | A `byo_upstreams` row for that issuer whose `state` is `active` (§10). |
| 3 | `org` | An organization whose `ssoIssuer` or `samlIssuer` is that issuer, and whose state is neither `deleted` nor `suspended` (§11). |
| — | `undefined` | Everything else. Callers map it to `untrusted_issuer`: 403 at `start`, 403 at the callback. |

Issuers are compared trailing-slash-normalized. The order is authority order: an
operator-configured provider is never shadowed by a BYO record or an org row naming the same
issuer, because the operator's entry is the one holding the client credentials.

**Synthesis for allowlist-only issuers is mandatory, not a convenience.** A deployment
configured with `OPENSESAME_TRUSTED_UPSTREAMS=https://shoo.dev` and no `OPENSESAME_PROVIDERS`
must keep working unchanged. `staticProviders` therefore walks the allowlist first and, for
any issuer the registry does not describe, synthesizes a descriptor: the legacy confidential
credential when `OPENSESAME_UPSTREAM_*` names exactly that issuer, otherwise a public
origin-profile client (`clientAuth: "none"`). Synthesized ids and labels match §7's
`describeUpstream` and the Pages `TRUSTED_UPSTREAMS` table — `https://shoo.dev` is
`shoo`/"Google", a loopback issuer is `mock`/"a local test account", anything else is named
by its host.

Resolution reads storage on every call and is deliberately not cached: a disabled BYO record
or a removed organization issuer has to stop signing people in immediately.

### 8.3 Client modes

The trust resolution decides how the leg authenticates. The modes are exclusive, chosen by
configuration, never negotiated at runtime.

| Resolution | `client_id` | Authentication | `Origin` header on token request |
| --- | --- | --- | --- |
| `static`, `clientAuth: "none"`, no configured client id | `origin:<publicUrl origin>` | none (public) | **Yes** — §7.3 |
| `static`, `clientAuth: "none"`, configured client id | the configured id | none (public, registered) | No |
| `static`, `clientAuth: "client_secret_post"` | the configured id | `client_secret_post` | No |
| `static`, `clientAuth: "apple_es256"` | the Services ID | `client_secret_post` carrying a freshly minted ES256 JWT | No |
| `byo` | the record's `clientId` | `client_secret_post` when the record holds a secret, else none | No |
| `org` | `origin:<publicUrl origin>` | none (public) | **Yes** |

The pinned `Origin` header belongs to exactly one mode — the secret-less client whose id
encodes our own origin. A confidential client that also claimed a browser origin is a mode
violation; the reference IdP answers `origin_cors_denied` to it and a real provider has no
reason to be kinder.

The Apple assertion is minted per (team, key, client) with a 600-second lifetime, re-minted
60 seconds before expiry, and cached in-process. Its claims are `iss` = team id, `sub` = the
Services ID (our client id at Apple), `aud` = `https://appleid.apple.com`, `kid` = the key id
in the JOSE header. The PEM never leaves the minting module.

### 8.4 Discovery cache

Keyed `${issuer}|${clientId}`, not by issuer. One issuer can be reached as more than one
client — a registry provider for the deployment and a BYO record for a visitor — and an
`openid-client` Configuration binds the client id and its authentication method, so an
issuer-only key would hand the second caller the first caller's credentials. A rejected
discovery deletes its own entry so a failure does not poison later attempts.

### 8.5 The public catalog, and provider hints

`GET /v1/federated/providers` (unauthenticated) answers
`{ providers: [{ id, label, kind, browserCapable }] }` and deliberately carries **no**
issuers, endpoints, client ids, secrets or tenant ids. Pages' first-run screen and the
console's sign-in page render it before anyone has an identity; the leg itself runs
server-side, where the registry already knows the rest.

`browserCapable` is true only for a secret-less OIDC provider whose issuer is `https://shoo.dev`
or loopback — the origin-profile brokers, which serve CORS on their token endpoint. Google,
Microsoft, GitHub and Apple serve none there, so a static page physically cannot complete the
exchange and must broker through the control plane (see §7 and C13 in §11.4).

`POST /interaction/:uid/federated/start` accepts either `provider` (a registry id, which
wins) or the legacy `issuer` field. Both are re-resolved server-side against the registry and
re-fenced inside the leg by §8.2 — the rendered buttons are a convenience, never the fence. A
`provider` that resolves to nothing is a 403, not a fall-through to the `issuer` field.

A client may hint a provider through `kc_idp_hint` or `login_hint_provider`. Precedence is
frozen at **id > issuer > host > label**, so the day a genuine `google` registry id sits
beside shoo.dev's "Google" label, the id wins. A matched hint is rendered first and primary
and is **never** auto-submitted: an upstream error 303s back to the login page, so a page
that redirected itself would loop forever. An unknown hint is ignored and never echoed.

### 8.6 The stable federated callback

`GET` and `POST /v1/federated/callback` is the one redirect URI a registered upstream ever
sees. §7.1 says which trust resolutions use it and why; this section is what it does.

**It completes nothing.** It reads no cookie, verifies no token, and touches no store. It
copies the authorization response onto the interaction's own callback and stops:

| Property | Value |
| --- | --- |
| Parameters copied | `code`, `state`, `error`, `error_description`, `iss` — an allowlist, not a filter. Everything else an upstream sends (Apple's `user`, an `id_token`, whatever a future revision adds) is dropped rather than reflected into a URL this server redirects a browser to. `iss` rides along because RFC 9207 requires a client to check it where the authorization server advertises support, and openid-client does. |
| Length cap | 2048 bytes per parameter. An authorization code is a few hundred; a redirect URL assembled from unbounded input is a denial of service in a header. |
| Response | `303` to `/interaction/{uid}/federated/callback` with those parameters. |
| GET | The ordinary redirect landing. |
| POST | The `response_mode=form_post` landing — Apple's cross-site POST from `appleid.apple.com` (§8.3). It carries none of this deployment's `SameSite=Lax` cookies and needs none, because this route reads none. There is no CSRF token because there is no authority here to abuse: the redirect target is this server's own interaction callback, and `state` byte-equality against the pending cookie still decides whether anything completes. |

**Routing is carried by `state`, not by server-side state.** One URL serves every interaction,
so something has to say which one a response belongs to — and a cookie cannot: a second
sign-in in a second tab would overwrite the first tab's, and Apple's cross-site POST would
carry no cookie at all. The leg therefore mints `state` as `` `${uid}.${random}` `` for exactly
the resolutions that use this callback. The random half is unchanged
(`client.randomState()`) and remains the unguessable part; the uid prefix is not a secret,
being the same value every per-interaction redirect URI puts in its path.

This is **stateless re-materialization, not a completion code.** Nothing is stored, so there
is nothing here to expire, to replicate between nodes, or to leak. The SAML ACS does need a
server-side single-use code (§12.2) for a reason that does not apply here: a signed assertion
is multiple kilobytes of XML and cannot be put back into a query string, while an
authorization response is five short parameters and can.

Fail-closed behaviour, in order:

1. A `state` that is absent, that has no separator, that has an empty prefix, or whose prefix
   is not the base64url uid shape oidc-provider mints → `400` with one sentence, the same for
   every case. The route is unauthenticated and anybody may reach it with anything.
2. A well-formed prefix naming an interaction the sender does not hold the pending cookie for
   → the hand-back happens, and the exchange then fails at the interaction callback, where the
   **whole** `state` — prefix and random half — is still compared byte for byte against that
   cookie. The prefix routes; it never authorizes.
3. The token request quotes `{publicUrl}/v1/federated/callback` with this response's
   parameters on it, because RFC 6749 §4.1.3 requires the token request to present the
   `redirect_uri` the authorization request used — which is the registered one, not the path
   the browser was handed back to. Both legs derive that choice from the trust resolution, on
   start and on completion, so the two can never quote different values, and a forged pending
   cookie cannot choose the URI.

**Known limitation.** The organization OIDC leg still uses the per-interaction redirect URI
(§7.1). A tenant whose IdP accepts a wildcard or a path prefix is unaffected; a tenant whose
IdP demands exact-match registration has the same problem this section solves for registry and
DCR upstreams, and no configuration on this side resolves it today. It is a deliberate
limitation, not an oversight: tenants configured their issuers against a deployment already
running the per-interaction shape, and moving them is a migration rather than an edit.

## 9. The generic OAuth2 leg (ADR 0055)

For a provider that issues no `id_token` — GitHub is the shipped one. It shares the routes,
the pending cookie and the callback of §7; what differs is that there is no assertion to
verify, so an authenticated read of the userinfo document *is* the assurance. `kind: "oauth2"`
rides in the pending cookie and the callback dispatches on it; an `"oauth2"` pending is never
finished by the OIDC leg, and an absent `kind` means `"oidc"` (the shape of every cookie
written before this release).

Start: `response_type=code`, the descriptor's `client_id` and `scopes`, the **stable**
redirect URI `{publicUrl}/v1/federated/callback`, an interaction-scoped `state`
(`` `${uid}.${random}` ``, §8.6), and PKCE `code_challenge`/`S256`. This leg only ever runs
for a static registry provider — BYO is OIDC-only — so it always uses the stable callback. No
`nonce`: there is no id_token to bind one to, and the pending cookie's `nonce` is the empty
string here.

Callback validation, in this order:

1. `state` from the callback equals the pending `state`, compared byte-for-byte in constant
   time. The pending cookie is unsigned by design (§7.2), so this comparison is the binding
   between the browser that started the leg and the redirect that finishes it.
2. `code` is present and non-empty.
3. The token exchange POSTs to the descriptor's pinned `_TOKEN_URL` with
   `grant_type=authorization_code`, the code, the PKCE verifier, `client_id`,
   `client_secret`, and the same **stable** `redirect_uri` **rebuilt from `publicUrl`** rather
   than read off the received URL — behind a proxy the two differ, and RFC 6749 §4.1.3
   requires the value to byte-match the one the authorization request carried.
   `Accept: application/json` is sent; a
   form-encoded response is still parsed, because a provider that ignores the header would
   otherwise look like a successful exchange with no token in hand.
4. **The body is inspected before the status.** An `error` key is a refusal even on HTTP 200 —
   GitHub reports `incorrect_client_credentials` that way, and a client that branched on the
   status alone would read it as a successful sign-in.
5. A non-2xx status is `exchange_failed`; a missing or empty `access_token` is
   `exchange_failed`.
6. The userinfo document is read from the pinned `_USERINFO_URL` with the bearer and a
   constant `User-Agent` (GitHub refuses an API request that does not name its caller).
7. The subject is `profile[_SUBJECT_FIELD]`, accepted only as a non-empty string or a finite
   number (stringified). A structured value is `missing_subject`, never coerced —
   `String({…})` is `[object Object]`, the same subject for every account on that provider.
   **The configured field must be stable**: GitHub's `id` is immutable, its `login` is
   renameable and re-registrable by somebody else, and a renameable subject is an
   account-takeover path.
8. `email` and `name` are read from the descriptor's `profileMap` (defaults `email`/`name`)
   and are display/linking hints only. `emailVerified` is set only when the descriptor names
   an `emailVerifiedField` and the value is a boolean; the shipped GitHub descriptor names
   none, so a GitHub email never satisfies §14.3's verified-email join. `/user/emails` is
   never called — a private profile email is simply absent.

Every endpoint on this leg comes from static operator configuration, so nothing user-supplied
decides where the server connects. Bring-your-own upstreams are OIDC-only and never reach it.

## 10. Bring-your-own lifecycle (ADR 0055)

Registration — the URL fence, the abuse budget, discovery, RFC 7591, persistence, re-entry
and the refusal shape — is specified in §7.8 and is not repeated here. What follows is the
rest of the lifecycle.

| Stage | Behaviour |
| --- | --- |
| Trust | A `byo_upstreams` row is the second source consulted by §8.2, and only while `state = "active"`. It cannot shadow a registry provider for the same issuer. |
| Leg | The ordinary §7 OIDC leg, with the record's own client mode (§8.3): the visitor's client id at their IdP, their secret if they supplied one or RFC 7591 minted one, never this deployment's origin profile and never the pinned `Origin` header. |
| Redirect URI | `registrationSource: "dcr"` uses the stable `{publicUrl}/v1/federated/callback` (§8.6) — RFC 7591 registers a `redirect_uri` once and the issuing IdP then matches it exactly, so a per-interaction URI would admit that visitor today and be refused by their own IdP tomorrow. `registrationSource: "manual"` keeps the per-interaction `{publicUrl}/interaction/{uid}/federated/callback`: that visitor registered a redirect URI at their IdP themselves — a wildcard, or whatever it accepts — and this server does not change it under them. Both legs derive the choice from the durable record on start **and** on completion, so the authorization request and the token request can never quote different values. |
| Pending cookie | Carries `byoId`; completing the leg stamps the record's `lastUsedAt`. |
| Admission | Unchanged — §7.6 find-or-mint, landing `assurance: "verified"` in the ADR 0033 §1 sense (an upstream vouched for this subject; nobody vetted the human). |
| Operator lifecycle | `GET /v1/federated/admin/byo-upstreams`, `POST /v1/federated/admin/byo-upstreams/:id/disable`, `.../enable`, all gated on the server-only operator token. An unknown id answers 404 — no existence oracle. The list carries id, issuer, label, client id, client auth, registration source, state and timestamps, and deliberately **never** the client secret. |
| Disabled record | Resolves for nobody, and a re-registration attempt naming that issuer gets the same refusal a stranger's unknown issuer gets rather than re-creating around it. |

## 11. Organization sign-in (ADR 0055)

### 11.1 Durable tenant configuration

> An organization's OIDC issuer keeps the **per-interaction** redirect URI
> `{publicUrl}/interaction/{uid}/federated/callback` (§7.1), unlike registry and DCR upstreams.
> A tenant IdP that accepts a wildcard or a path prefix is unaffected; a tenant IdP demanding
> exact-match registration is the known limitation recorded at the end of §8.6, and no setting
> on this side works around it.

`organizations` carries `sso_issuer`, `saml_issuer`, `saml_metadata_url`,
`saml_metadata_xml` and `provisioning_enabled` as columns (queried *by issuer* on the login
path), behind one store interface with a memory and a Postgres implementation. Tenant
federation config now survives a restart wherever `DATABASE_URL` is set. Issuers submitted at
create or PATCH pass the private-host guard outside dev; `samlMetadataUrl` and
`samlMetadataXml` are mutually exclusive.

`GET /v1/organizations/tenants/:slug` (public) answers the tenant's `authMethods`:

| Method | Emitted when | Runs as |
| --- | --- | --- |
| `sso` | `ssoIssuer` set | Brokered OIDC redirect (§7) |
| `saml`, `native: true` | `samlMetadataUrl` or `samlMetadataXml` set | Native SAML SP (§12) — no browser-side issuer is offered |
| `saml` with an `issuer` | `samlIssuer` set and no SAML metadata | The ADR 0016 brokered path: an OIDC issuer in front of a SAML IdP |
| `ldap` | an LDAP config exists for the org | First-party username/password form (§14.4) |

### 11.2 Hosted login page, two steps

Under `default-src 'none'` with no `script-src` there is no fetch to make, so organization
sign-in is a plain POST/redirect/GET pair:

1. `POST /interaction/:uid/federated/org` with `slug` and `_csrf` → 303 to
   `GET /interaction/:uid?org=<slug>`.
2. That re-render carries the tenant's method buttons. A **brokered** method (`sso`, or the
   ADR 0016 `samlIssuer` path) posts that method's `issuer` to
   `/interaction/:uid/federated/start`. A **native SAML** method posts the organization `slug`
   to `/interaction/:uid/federated/saml` instead — its entityID is a name, not an OIDC issuer,
   and `/federated/start` would rightly refuse it as untrusted. An **LDAP** tenant renders a
   username/password form posting `slug`, `username`, `password` and `_csrf` to
   `/interaction/:uid/federated/ldap` (§14.2); it appears only once a slug has resolved to a
   tenant that has a directory, because there is nothing to check a username against otherwise.

An unknown slug, a deleted or suspended tenant and a tenant with no configured method all
re-render one sentence with a **fresh** CSRF token — the submitted one was consumed by the
verify, and a re-render echoing it would 403 the next attempt.

### 11.3 Completion JIT-joins

When the pending cookie carries `orgId`, the callback joins the authenticated principal to
that organization after §7.6 principal resolution, auditing `organization.member_joined` with
the method in metadata. The tenant's own IdP vouched for the subject, so membership follows
the sign-in rather than waiting for a separate call. The role is `member` unless a SCIM Groups
push already mapped this subject to one (§13.1) — the directory said so before the sign-in
happened, and that is the tenant's own answer about its own people. The LDAP leg does the same
with the role its `memberOf` groups earned (§14.2).

When the tenant has `provisioningEnabled`, the join first requires an **active** SCIM row for
that subject (§13.1); otherwise it refuses with `not_provisioned` and the sign-in does not
become a membership. The same `jitJoinOrganization` helper serves the login page, the join
route, the SAML legs and the LDAP leg, so where you signed in never decides whether you are a
member.

### 11.4 `POST /v1/organizations/tenants/:slug/join` — validation order

The id_token POST is retained (a forced code flow here would break the working browser leg in
Pages). Validation, in order:

1. The slug resolves to an organization that is neither deleted nor suspended.
2. The requested `method` has an OIDC issuer to verify against — `sso` uses `ssoIssuer`,
   `saml` uses `samlIssuer` **only when the tenant is not native-SAML**, and `ldap` has none.
   Otherwise `409 auth_method_unavailable`: a native-SAML assertion is signed XML at the ACS,
   not a bearer id_token.
3. `alg` is `RS256` or `ES256`, checked from the header before any network call.
4. Discovery and JWKS fetch go through the SSRF guard (private hosts blocked outside dev,
   redirects refused, 5s timeout), and the discovery document's own `issuer` must agree.
5. The signature verifies, `iss` matches, and — new — **`aud` is one of
   `originAudiences(config)`**: the configured CORS origins plus `publicUrl`, each spelled
   `origin:<origin>`. Derived rather than hard-coded, because Pages runs the browser leg with
   `client_id = origin:<its own origin>` and hard-coding `origin:<publicUrl>` would refuse
   every join from the dev Pages server on `:5180`.
6. **`iat` is at most 600 seconds old** (`maxTokenAgeSec`), with 5 seconds of clock tolerance.
7. Subject precedence is `pairwise_sub ?? sub`, and a token with neither is refused.
8. **The subject is bound to the caller** through `attachVerifiedExternalIdentity` before
   anything is granted. A subject owned by a different principal answers 409 with a message
   that does not name that principal.
9. Only then, `jitJoinOrganization` (including the provisioning gate of §11.3).

**`nonce` is deliberately not required here.** The browser leg sends none — the code + PKCE
exchange is what binds that request to that browser — and requiring a claim the working client
never mints would refuse every real join. Steps 5, 6 and 8 close the replay window instead:
the token must have been minted for one of our own surfaces, it must be minutes old, and it
must name a subject that is unowned or already this caller's.

### 11.5 Brokered session adoption — `POST /v1/principals/federated-session`

For a static page that ran the origin-profile code flow against this server so the hosted page
could broker a provider the browser cannot reach.

Request `{ accessToken }` — the oidc-provider access token from that code exchange. The route
resolves it through oidc-provider's own store, refuses an expired or account-less token,
requires the named principal to exist and be `active`, and answers
`{ principalId, accessToken, expiresAt }` where `accessToken` is a first-party `pst_`
provisional bearer bound to the **same** principal. No principal is minted and no identity row
is written. Every failure — malformed body, unknown token, expired token, client-credentials
token, missing or inactive principal — answers one uniform `401 { "error": "invalid_token" }`.
The route takes no auth middleware: the presented token is the credential.

**Do not POST that id_token to `/v1/principals/link-identities`.** It carries a *pairwise*
subject minted for the page's origin (ADR 0050); linking it would attach that identity to
whatever provisional session the page happens to hold — the wrong principal, permanently.
Cookie resume cannot substitute either: `os_provisional` is `SameSite=Lax` and is not sent on
a cross-origin XHR from the page's origin.

## 12. Native SAML service provider (ADR 0056)

Supersedes ADR 0016 for the SP half. The brokered path (`samlIssuer` with no metadata, an
OIDC issuer in front of a SAML IdP) is unchanged and still supported; a tenant is native-SAML
exactly when `samlMetadataUrl` or `samlMetadataXml` is configured.

### 12.1 Endpoints

| Route | Purpose |
| --- | --- |
| `GET /v1/saml/metadata` | SP EntityDescriptor. entityID = `{publicUrl}/v1/saml/metadata`, ACS = `{publicUrl}/v1/saml/acs` (HTTP-POST binding), `WantAssertionsSigned`, `AuthnRequestsSigned="false"`, NameID format `persistent`, stable document id. `application/samlmetadata+xml`. |
| `POST /interaction/:uid/federated/saml` | Start SP-initiated sign-in for `slug`; CSRF-protected. |
| `POST /v1/saml/acs` | Assertion consumer service, both flows. Unauthenticated and un-CSRF-able by protocol. |
| `GET /interaction/:uid/federated/saml/complete?otc=…` | Resume the interaction after an SP-initiated assertion verified. |

### 12.2 Why the state is server-side

The ACS receives a cross-site POST from the IdP and therefore carries **no** `SameSite=Lax`
cookie — not the pending cookie, not oidc-provider's interaction cookie. Apple's `form_post`
has the same physics, but its remedy does not transfer: the five parameters of an
authorization response fit in a redirect query (§8.6 re-materializes them and stores nothing),
and a multi-kilobyte base64 assertion does not. That difference — not a difference of trust —
is the whole reason this flow needs a server-side single-use code and §8.6 does not.

So `beginSamlAuth` generates the AuthnRequest id itself and writes
`{requestId, interactionUid, organizationId, createdAt}` to a durable, single-use pending
store before the browser leaves. After verification the ACS mints a single-use completion code
(120-second TTL, process-local) and 303s to the complete route — a top-level GET, which does
carry the Lax cookies. That route requires the code's recorded `interactionUid` to equal the
uid in its own path; a code spent against a different interaction would sign this browser in
on somebody else's ceremony.

### 12.3 Response validation order

1. Decode `SAMLResponse`; refuse an empty one or one over 512 KiB before parsing.
2. Read routing facts from the **unverified** envelope: `Response/@InResponseTo` and
   `Response/Issuer`. These choose *which tenant's certificate answers* and nothing else, which
   is why reading them unverified is safe.
3. `InResponseTo` present → take the pending record (single-use) and adopt its organization
   and interaction. Absent → resolve the organization by the envelope issuer. No organization,
   or one that is not native-SAML → refuse.
4. Resolve that tenant's IdP metadata (inline XML parsed directly; a URL fetched through the
   SSRF guard with redirects refused and cached for 10 minutes). A configured `samlIssuer`
   entityID is authoritative over the document that claims a different one.
5. Verify with `@node-saml/node-saml`: assertion signature (`wantAssertionsSigned`),
   `Audience` equal to our SP entityID, and the condition window with 30 seconds of skew and a
   5-minute maximum assertion age. The library accepts a signature only as a **direct child**
   of the element it is about, refuses more than one such signature, and refuses more than two
   `Transform` elements — which is what defeats signature wrapping, since every field acted on
   below is read from that verified assertion and never from the unsigned wrapper.
6. The **assertion's** `Issuer` must equal the tenant's IdP entityID.
7. The assertion XML must be recoverable, and its `Assertion/@ID` non-empty.
8. Request binding, on the **signed** copy: `SubjectConfirmationData/@InResponseTo` must equal
   the routing `InResponseTo`. For an IdP-initiated response, a present
   `SubjectConfirmationData/@InResponseTo` is a refusal — that is somebody else's SP-initiated
   assertion re-posted with the wrapper attribute stripped.
9. Replay: the assertion id must not have been seen, recorded until its own `NotOnOrAfter` (or
   now + 5 minutes when it declares none).
10. `NameID` must be non-empty.

Every refusal — unknown request, bad signature, wrong audience, replay, unconfigured tenant —
answers the ACS's one sentence with one status. Those are four different facts about internal
state and answering them differently would map which organizations exist, which requests are
outstanding, and which assertions are spent. Detail goes to the log with a correlation id.

### 12.4 Admission

Identity: `kind: "saml"`, `issuer` = the IdP entityID **resolved from the tenant's
configuration** (never from the assertion — the row names what this deployment trusts),
`subject` = the NameID value, `metadata.nameIdFormat` = the NameID Format as provenance.

`email` and `name` attributes (standard OID, WS-Fed claim URI, or friendly names) are read for
**display only** and never reach `emailNormalized`: a SAML attribute carries no verification
signal an SP can trust, and an `emailAddress`-format NameID is a subject string that merely
looks like an address. The SAML leg therefore never participates in §14.3's verified-email
join.

Then the shared path: find-or-mint per §7.6, personal-project provisioning on first
authenticated session, `jitJoinOrganization`, and a provisional cookie **only** for a newly
minted principal. IdP-initiated additionally audits `principal.saml_idp_initiated` and 303s to
the validated RelayState path.

### 12.5 IdP-initiated `RelayState`

Honoured only when it is shaped like a location — a rooted path or an absolute `http(s)` URL —
**and** resolves to this deployment's own origin. A protocol-relative `//host/x` passes the
first test and fails the second, which is exactly why both are asked. Anything else lands on
`/`.

## 13. SCIM, home-realm discovery, and back-channel logout (ADR 0056)

### 13.1 SCIM 2.0

Base URL per tenant: `{publicUrl}/v1/organizations/{organizationId}/scim/v2`.

| Route | Behaviour |
| --- | --- |
| `POST /scim/v2/Users` | Create. `userName` required and unique per org (409 `uniqueness`); `active` defaults true; unknown attributes are kept in `raw` minus `password`/`schemas`/`meta`/`id`. |
| `GET /scim/v2/Users` | List, or `filter=userName eq "…"`. Any other filter is 400 `invalidFilter`. |
| `GET /scim/v2/Users/:id` | Read. |
| `PATCH /scim/v2/Users/:id` | Fold PatchOps; `active` accepts both a boolean and the string `"False"` (Okta sends the first, Entra the second). |
| `DELETE /scim/v2/Users/:id` | Deactivation, per SCIM's intent. |
| `PATCH /scim/v2/Groups/:groupId` | Minimal role mapping: a group whose trailing word is `owner(s)`/`admin(s)`/`member(s)` maps membership to that org role. Everything else is accepted and ignored. |

Owner-gated token management sits beside it: `POST /scim/tokens` (mint),
`GET /scim/tokens` (list metadata), `DELETE /scim/tokens/:tokenId` (revoke).

Rules that are contract rather than implementation detail:

- **Token custody.** `sct_`-prefixed, shown exactly once in the mint response, stored only as
  a SHA-256 digest, and compared by hashing the presented bearer. No token material reaches a
  log or an audit row. A missing bearer, a wrong bearer, an unknown organization and a
  suspended one all answer the same 401 — anything else is an org-existence oracle.
- **No principal is minted at provision time.** A row is the tenant's standing answer to "may
  this subject join when it signs in?". The subject a row matches is `externalId ?? userName`.
- **Deactivation revokes membership and every session it authorized**, for every principal
  that has signed in to this tenant as that subject — resolved only through the
  organization's own issuers, so a SCIM row never reaches an identity minted at an unrelated
  upstream that happens to use the same subject string.
- Errors use the `urn:ietf:params:scim:api:messages:2.0:Error` envelope and
  `application/scim+json`.

### 13.2 Email domains and home-realm discovery

| Route | Behaviour |
| --- | --- |
| `POST /v1/organizations/:id/domains` | Owner-gated claim. The domain is lowercased, IDNA-normalized and must be multi-label; a re-claim re-rolls the token. A domain held by another organization answers 409 without naming the holder — domains are globally unique, first claim wins. |
| `POST /v1/organizations/:id/domains/:domain/verify` | Resolves TXT through `node:dns/promises` only and looks for `opensesame-domain-verify=<token>`, joining multi-chunk records first and comparing in constant time over digests. Every failure — no record, somebody else's token, NXDOMAIN, SERVFAIL — answers the same 422 sentence. |
| `DELETE /v1/organizations/:id/domains/:domain` | Release. |
| `POST /interaction/:uid/federated/realm` | The login page's "Continue with your work email" field, CSRF-protected. |

DNS and only DNS: fetching `https://<domain>/.well-known/…` would hand an org owner a
server-side request to an arbitrary host, which is the SSRF gadget the rest of this document
spends `assertSafeMetadataUrl` avoiding.

The realm route splits the submitted address on its **last** `@`, keeps the domain, looks up a
**verified** claim, and 303s to `GET /interaction/:uid?org=<slug>`. Unknown domain,
claimed-but-unverified domain, and "not an address at all" all re-render the same sentence with
a fresh CSRF token and **without** repopulating the field.

**The address is a router and nothing else.** The local part is never bound to a name, and the
address reaches no log, no audit row and no store. This is the deliberate opposite of §14.1,
where the address IS the identifier; both rules hold at once because they are different routes
with different code.

### 13.3 Upstream token lifecycle and back-channel logout

The legs request no offline scope. A `refresh_token` an upstream issues anyway is **never
persisted**; where discovery advertises a `revocation_endpoint` it is also handed back,
best-effort, fire-and-forget, behind a 3-second timeout on a dedicated Configuration. A
revocation that fails is logged and changes nothing: dropping the token is the guarantee.

`POST /v1/federated/backchannel-logout`, form-encoded `logout_token`, validated in this order:

1. Global rate budget (120/minute) charged unconditionally — it is the one limit an attacker
   cannot dodge by varying the token.
2. `logout_token` present and at most 8192 bytes.
3. The header `alg` is `RS256`/`ES256` and the **unverified** `iss` is readable. It is used for
   exactly two things: picking the per-issuer budget (30/minute) and asking the fence.
4. **The issuer resolves through §8.2.** An issuer nobody configured gets no discovery request,
   so this endpoint cannot be pointed at a third party.
5. The signature verifies against that issuer's JWKS, discovered through the SSRF guard,
   redirects refused, cached per JWKS URI so an unauthenticated POST is not a reflection
   amplifier.
6. `iss` matches, `iat` is at most 120 seconds old (5s tolerance).
7. **`nonce` MUST be absent.** OIDC BCL §2.6.2 forbids it, and the reason is the fence itself:
   accepting one would let a captured `id_token` be presented as an instruction to sign that
   person out.
8. `events` contains `http://schemas.openid.net/event/backchannel-logout`.
9. `sub` or `sid` is present. A `sid`-only token is accepted and has no effect — this service
   keeps no upstream session ids.

Effect: every live provisional session of every principal linked to `(issuer, sub)` under any
identity kind is revoked, and when the issuer resolved to an organization, memberships it
granted end too.

**A token that verifies always answers `200` with an empty body** — matched or not, revoked
something or nothing. Anything else is an oracle for "does this person have an account here".
What actually happened is in the audit trail (`principal.upstream_logout`), not in the
response. A token that fails any check above answers `400 invalid_request`, which says nothing
about any subject; an exhausted budget answers `429`.

## 14. Email magic-link, LDAP, and the verified-email join (ADR 0057)

### 14.1 Email magic-link

Better Auth is mounted for exactly one method. The mount is an **allowlist of one path**:
`POST /v1/auth/sign-in/magic-link`. Every other path under `/v1/auth/*` answers `404` — social
sign-in is unreachable (Better Auth drops secret-less providers, which is every origin-profile
broker, so the registry owns social), and Better Auth's own `/magic-link/verify` and
`/get-session` are not served because they answer with its user record.

| Route | Behaviour |
| --- | --- |
| `POST /interaction/:uid/federated/email` | Hosted login page, CSRF-protected. Requests a link and re-renders "check your email" — the same answer for a known and an unknown address. Budget: 5 links per address per 10 minutes, keyed by a digest, because the fence protects the person being mailed rather than the person mailing. |
| `GET /interaction/:uid/federated/email/verify?token=…` | Where a link started from the hosted page lands. A top-level same-site GET, so it carries the interaction cookie. |
| `POST /v1/auth/sign-in/magic-link` | The first-party client entry (Pages, console). |
| `GET /v1/auth/magic-link/complete?token=…` | Where a link started by a first-party client lands; answers `{ principalId, accessToken }`, a first-party `pst_` bearer adopted exactly as in §11.5. |

The token is single-use, stored hashed, consumed atomically inside verification, and
verification happens **server-side** so the Better Auth user record never crosses the API
boundary. Its id is written to `better_auth_subjects` and nowhere else; it must never appear
as a principal id, in a response body, in an audit row or in a token.

Principal resolution, in order: the `better_auth_subjects` mapping; then the identity tuple
`("email", <this deployment's issuer>, <normalized address>)` — which is how the same human is
recognised when Better Auth's store is rebuilt underneath a durable principal; then mint and
`attachVerifiedExternalIdentity`, applying §14.3. The email identity's issuer is this
deployment: the proof is ours, no upstream vouched for it. Addresses are normalized by trimming
and lowercasing and nothing else — local-part rules (dots, `+tags`) differ per provider and
guessing wrong would either merge two people or split one.

Unlike the redirect legs, this route sets a provisional cookie for a **returning** principal
too: the browser holding it just proved control of the address, where in a redirect leg a
returning browser proved nothing (§7.6).

Known limitation: Better Auth runs on its in-memory store, so a magic link does not survive a
control-plane restart and does not span replicas. The failure mode is "request another link";
principals, identities and the mapping are all durable.

### 14.2 LDAP bind and directory sync

| Route | Behaviour |
| --- | --- |
| `POST /interaction/:uid/federated/ldap` | Fields `slug`, `username`, `password`, `_csrf`. A first-party credential POST, so — unlike every redirect leg on this prefix — it is CSRF-protected **and** rate-limited (10 attempts per client fingerprint per 10 minutes, 200 globally). |
| `GET`/`PUT`/`DELETE /v1/organizations/:id/ldap` | Owner-gated configuration. The service-bind secret is write-only; no read path returns it. |
| `POST /v1/organizations/:id/ldap/sync` | Owner-gated manual directory sync. |

Configuration is refused unless: the URL is `ldap://` or `ldaps://`; it is `ldaps://` outside
dev defaults (plain LDAP puts the password on the wire in the clear); the host passes the
private-host guard outside dev (an owner is trusted with their tenant, not with this server's
network position — `ldap://169.254.169.254` would otherwise be an SSRF gadget); and the mode is
complete (`bind_template` containing `{username}`, or `searchBaseDn` + a `searchFilter`
containing `{username}` + service bind credentials).

Bind, in order:

1. The username is trimmed, length-capped and refused if it carries control bytes; an **empty
   password is refused before the wire**, because LDAP reads an empty credential as an
   *unauthenticated* bind and answers success.
2. `bind_template`: the username is RFC 4514-escaped into the template and bound directly, then
   the entry is read with a base-scope search. `search_bind`: the service account binds,
   searches with the username RFC 4515-escaped into the filter under a size limit of **2** —
   an ambiguous match is observed and refused, never resolved to whichever entry came first —
   and the found entry's own DN is then bound with the user's password, because the service
   account's success proves nothing about the human.
3. A search that finds nobody still performs a bind that is expected to fail, so an unknown
   username costs the same operations in the same order as a known one.
4. The subject is the configured stable attribute (`entryUUID`, `objectGUID`, …), binary values
   base64url-encoded. **Never the DN** — a DN moves when somebody changes department, and a
   subject that moves is a new account for the same human or an old account inherited by
   whoever next occupies that DN. An entry with no value for that attribute is not admitted.
5. Wrong password, unknown user, ambiguous match, unreachable directory and a tenant with no
   directory configured all answer one sentence with `401`; a broken configuration answers
   `503` and is logged for the operator. The password is never stored, logged, audited or
   placed in an error.

Admission: `kind: "ldap"`, `issuer` = scheme + host + port of the directory URL (path and
query dropped, so two configurations of the same directory cannot mint two issuers for the
same people), then find-or-mint, personal project, and `jitJoinOrganization` at the role the
`memberOf` groups earned (matched by full DN or first-RDN value, case-insensitively; the
strongest match wins).

Directory sync reconciles users and group→role memberships as the pull twin of SCIM push. It
mints no principals — an entry that nobody has ever bound as has no principal to join. A member
this directory vouched for who is absent from the scan loses membership and every session it
authorized, through the same helper SCIM deprovisioning calls; a member who joined through some
other issuer is untouched.

**Empty-scan guard:** a scan yielding zero usable entries deprovisions nothing and logs a
warning. A moved base DN, a filter that stopped matching and a service account that lost read
access are indistinguishable from a company where everybody resigned at once, so the safe
reading wins.

### 14.3 The verified-email join

Applied inside `attachVerifiedExternalIdentity` — the single admission chokepoint for every
leg — after the tuple lookup and before the mint:

1. Tuple `(kind, issuer, tenant, subject)` hit owned by the caller → idempotent. Hit owned by
   anybody else → `identity_collision`. **Unchanged.**
2. On a miss, **and only if this sign-in asserts `emailVerified === true` with a non-empty
   `emailNormalized`**, look for an existing principal owning a *verified* identity with that
   address.
3. A match owned by a different principal → the new identity row is created against **that**
   principal, which is promoted if provisional; audit `principal.identity_email_linked` naming
   the pre-existing identity's kind and issuer, alongside the usual
   `principal.identity_linked` naming the new one, under one correlation id.
4. A match owned by the caller is no match. No match, or an unverified/absent email → today's
   behaviour: the row is created against the caller's principal. An unverified collision still
   emits the *denied* `principal.identity_link_email_collision` event and then links by tuple.

Determinism: `email_normalized` is indexed and deliberately **not** unique, so when several
verified rows share an address the oldest owning principal wins, tie-broken by principal id
then identity id — identically in the memory and Postgres implementations.

**Callsite obligation.** Because step 3 can return an identity owned by a *different*
principal than the caller passed in, every admission callsite binds the session to
`result.identity.principalId` and issues the browser a provisional bearer only when that
equals the principal it just minted. Handing over the minted principal's bearer would leave
the browser holding a session for an account the sign-in did not complete as.

Which legs can reach it: `oidc` (when the id_token carries `email_verified: true`), `oauth2`
(only when the descriptor names an `emailVerifiedField` — the shipped GitHub descriptor does
not), `email` (always — the address is what was proved), and `ldap` **only when the
organization has DNS-verified that address's domain** (§13.2), because a directory is
configured by an org owner and an owner who could assert `victim@example.com` as verified
would be able to walk onto that person's principal. `saml` never reaches it (§12.4).

This attaches an identity at admission. It never fuses two already-durable principals:
`principal.merge` stays behind the policy fence, and explicit cross-principal linking through
`POST /v1/principals/link-identities` still answers 409.
