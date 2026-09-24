# @opensesame/mock-upstream-idp

Deterministic local OIDC provider for OpenSesame upstream auth tests. Jose-signed ID tokens; auto-approves a seeded test user.

## Run

```bash
# from repo root
pnpm --filter @opensesame/mock-upstream-idp build
pnpm --filter @opensesame/mock-upstream-idp start

# or with tsx (dev)
pnpm --filter @opensesame/mock-upstream-idp dev
```

Default listen address: `http://127.0.0.1:9090`

### Endpoints

| Path | Description |
| --- | --- |
| `GET /.well-known/openid-configuration` | Discovery |
| `GET /authorize` | Auto-approve → redirect with `code` |
| `POST /token` | Authorization code / refresh |
| `GET /jwks` | Public signing keys |
| `GET /userinfo` | Test user claims |
| `GET /health` | Liveness |

### Seed confidential client (Better Auth / server RPs)

- `client_id`: `opensesame-upstream`
- `client_secret`: `opensesame-upstream-secret`
- Default redirect: `http://127.0.0.1:3000/api/auth/callback/mock`

### Origin-profile clients (federated-signin §1)

When `client_id` is `origin:{canonical origin}`, the mock admits the client
without a secret. `POST /token` requires an `Origin` header that byte-equals
that origin (CORS), PKCE S256 is mandatory, and the ID token `sub` /
`pairwise_sub` is a stable per-origin subject (not the seeded canonical
user id). Redirect URIs must be on that origin.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `OPENSESAME_MOCK_IDP_PORT` | `9090` | Listen port |
| `OPENSESAME_MOCK_IDP_HOST` | `127.0.0.1` | Bind address |
| `OPENSESAME_MOCK_IDP_ISSUER` | `http://127.0.0.1:$PORT` | Issuer URL in discovery/tokens |
| `OPENSESAME_UPSTREAM_CLIENT_ID` | `opensesame-upstream` | Seed RP client id |
| `OPENSESAME_UPSTREAM_CLIENT_SECRET` | `opensesame-upstream-secret` | Seed RP client secret |
| `OPENSESAME_UPSTREAM_REDIRECT_URIS` | `http://127.0.0.1:3000/api/auth/callback/mock` | Comma-separated allowlist |
| `OPENSESAME_MOCK_IDP_USER_SUB` | `mock-user-1` | Auto-approved subject |
| `OPENSESAME_MOCK_IDP_USER_EMAIL` | `mock@example.com` | Test user email |
| `OPENSESAME_MOCK_IDP_USER_NAME` | `Mock User` | Test user name |

## Tests

```bash
pnpm --filter @opensesame/mock-upstream-idp test
```
