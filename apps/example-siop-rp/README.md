# @opensesame/example-siop-rp

Small **secure** relying party that consumes OpenSesame Pages as a **Self-Issued
OpenID Provider** (SIOPv2). It demonstrates the draft-07 same-device profile:

- `response_type=id_token`
- `response_mode=fragment`
- `scope=openid`
- Subject = RFC 7638 JWK thumbprint (`sub` + `sub_jwk`)
- Dynamic issuer on the Pages origin with `i_am_siop`

## Specification status (honest)

SIOPv2 is **[Implementer's Draft 1](https://openid.net/specs/openid-connect-self-issued-v2-1_0-ID1.html)**
(`openid-connect-self-issued-v2-1_0-07`, 2022-01-28) — **not** a Final
Specification. This example pins that profile via `@opensesame/siop-v2`
`SUPPORT_MATRIX`.

## Trust model

| What you get | What you do **not** get |
| --- | --- |
| Cryptographic proof that the token was signed by the private key matching `sub_jwk` | Verified email, legal name, or any other self-asserted claim |
| Binding to your RP's `client_id` (`aud`) and login `nonce` | Hosted OIDC-style assurance or account linking by email |
| Stable pseudonymous subject (JWK thumbprint) for this RP | Cross-RP identity without additional verifiable credentials |

Optional claims in the ID Token (if the user consented on Pages) are **self-asserted**
only. Do **not** treat `email` as verified. Use OpenID4VP or hosted OIDC when you
need attestations.

Verification uses **`verifySelfIssuedIdToken`** from `@opensesame/siop-v2` (JOSE header
fence, full JWS verify from `sub_jwk`, RFC 7638 thumbprint check, `iss` / `aud` /
`nonce` / `iat` / `exp`, dynamic `i_am_siop`). This example never teaches or performs
decode-without-verify.

Dynamic issuers must be **HTTPS** in production. `@opensesame/siop-v2` also admits
loopback HTTP (`localhost`, `127.0.0.1`, `[::1]`) so local Pages dogfood can mint and
verify matching `iss` values. Non-loopback `http://` issuers are refused. Set
`OPENSESAME_PAGES_BASE` to the exact origin whose `/identity/siop` issuer matches the
token (including path prefix such as `/OpenSesame`).

Hosted principal linking is a separate Identity-plane bridge
([ADR 0117](../../docs/adr/0117-hosted-siop-oidc-bridge.md)); this fixture does not
use it.

## Prerequisites on Pages

1. Run Pages (`pnpm --filter @opensesame/pages dev:web` on `http://localhost:5180`, or
   deploy to HTTPS GitHub Pages for verify parity).
2. Register a **browser-local application** with:
   - **Application id** = `SIOP_RP_CLIENT_ID` (default `local_00000000-0000-4000-8000-000000000001`; must match Pages `local_<uuid>` form)
   - **Redirect URI** = exact `SIOP_RP_REDIRECT_URI` (default
     `http://127.0.0.1:4110/callback`)
   - Scope includes `openid`
3. Complete SIOP consent with a passkey-backed local identity (see ADR 0116).

Authorization requests target **`{pagesBase}/identity/siop`**.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `OPENSESAME_PAGES_BASE` | `http://localhost:5180/OpenSesame` | Pages origin + path prefix (no trailing slash) |
| `SIOP_RP_CLIENT_ID` | `local_00000000-0000-4000-8000-000000000001` | Registered local application id |
| `SIOP_RP_REDIRECT_URI` | `http://127.0.0.1:4110/callback` | Exact redirect URI |
| `SIOP_RP_LISTEN` | `127.0.0.1:4110` | This example RP listen address |

## Run

```bash
pnpm --filter @opensesame/example-siop-rp dev
# Open http://127.0.0.1:4110 — follow "Sign in with OpenSesame Pages"
```

Flow:

1. `GET /auth/start` — cryptographically random `nonce` and `state`; state is
   single-use in an in-memory store.
2. Redirect to Pages `/identity/siop` with SIOP query parameters.
3. `GET /callback` — browser reads the **fragment** (transport only).
4. `POST /api/complete` — server verifies the JWS via `@opensesame/siop-v2` and
   consumes the `state` (replay refused).

## Tests

```bash
pnpm --filter @opensesame/example-siop-rp test
```

Unit tests cover the verify path (happy path, single-use `state`, nonce mismatch).

## Related

- [`packages/siop-v2`](../../packages/siop-v2) — protocol core and `SUPPORT_MATRIX`
- [ADR 0116](../../docs/adr/0116-browser-native-siop-v2.md) — browser-native SIOP on Pages
