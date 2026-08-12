# Federated sign-in — wire contract

Implements ADR 0033 (federated identity admission) and ADR 0034 (origin-brokered sign-in
for static sites). This document is the contract; where code and this file disagree, one of
them is a bug.

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
