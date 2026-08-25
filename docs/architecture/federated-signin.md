# Federated sign-in — wire contract

Implements ADR 0033 (federated identity admission) and ADR 0034 (origin-brokered sign-in
for static sites); §7 additionally implements ADR 0052 (federated sign-in on the first-run
and hosted-login surfaces). This document is the contract; where code and this file
disagree, one of them is a bug.

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
| `GET /interaction/:uid/federated/callback` | Receive `code`/`state`, exchange, resolve a principal, complete the oidc-provider interaction |
| `POST /interaction/:uid/federated/byo` | Register (or recover) a visitor-supplied issuer, then begin the same flow `start` begins — see §7.8 |

The redirect URI is `{publicUrl}/interaction/{uid}/federated/callback` — one per
interaction, not one per deployment. It **must** live under `/interaction/:uid`: the
oidc-provider interaction cookie is path-scoped to that prefix, so a callback landing
anywhere else arrives without the interaction it exists to complete, and has no session to
resume. Registering a fixed deployment-wide callback path is not an acceptable substitute.

Because the redirect URI varies per interaction, the upstream must accept it. For an
origin-profile client that is automatic — admission is by origin, and every such URI shares
the deployment origin. A confidential client (§7.4) requires the pattern to be registered
upstream.

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

Before any principal is touched, in this order:

1. `state` from the callback equals `state` from the `os.fed.<uid>` cookie.
2. The `id_token` signature verifies against the issuer's published JWKS, discovered from
   `/.well-known/openid-configuration` — never from a hardcoded key.
3. `iss` equals the pending issuer, **and** that issuer is present in
   `OPENSESAME_TRUSTED_UPSTREAMS`. A signature only proves who signed; the allowlist decides
   who is trusted (ADR 0033 §2). In production the allowlist must be non-empty and every
   entry https, enforced at boot by `assertSecureConfig`.
4. `aud` matches the client id actually used for the exchange.
5. `nonce` equals the pending `nonce`.
6. `exp` is in the future.
7. The subject claim is present and a string.

Any failure ends the interaction with an error. There is no partial admission.

### 7.6 Principal resolution

Keyed on the external-identity tuple `(kind, issuer, tenant?, subject)` — never on email,
which is never used to link (ADR 0033, `docs/identity-linking.md`).

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
| Credentials | A supplied `client_id` is stored as given (`client_secret_post` when a secret came with it, otherwise a public client). With no `client_id`, RFC 7591 dynamic client registration is attempted when — and only when — discovery advertises a `registration_endpoint`, preferring `client_secret_post` and falling back to `none`, registering exactly this interaction's callback as the `redirect_uri`. With neither, the submission is refused and the visitor is asked for a client id. |
| Persistence | One `byo_upstreams` row per trailing-slash-normalized issuer, `state: "active"`. The client secret is stored verbatim: it must be presented to the token endpoint as issued, so it cannot be hashed. It is never logged, never audited and never returned by any API. |
| Re-entry | A second submission naming the same issuer reuses the existing row unchanged — no re-registration, and a submitted credential never overwrites the stored one. The answer is identical whether or not the row already existed: which issuers a deployment has seen is not something an unauthenticated page reveals. |
| Refusals | Re-render the login page with **422** and a **fresh** CSRF token — the submitted one was consumed by the verify — with the rejected issuer echoed back into the field. |
| Success | Sets the §7.2 pending cookie (`byoId` recorded on it) and 303s to the upstream. From there the flow is §7.3–§7.6 unchanged; the issuer is admitted by the bring-your-own branch of trust resolution, and completing the leg stamps the record's `lastUsedAt`. |

The client mode is the record's own — the visitor's `client_id` at their IdP, never this
deployment's origin profile, and never the pinned `Origin` header that mode carries (§7.4).
An operator can disable a record afterwards (`byo_upstreams.state`), and a disabled record
resolves for nobody and cannot be re-created around.

