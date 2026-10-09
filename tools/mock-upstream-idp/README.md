# @opensesame/mock-upstream-idp

Deterministic local OIDC provider for OpenSesame upstream auth tests. Jose-signed ID tokens; auto-approves a seeded test user. The same server also answers as a SAML IdP, a GitHub-shaped OAuth2 server (no id_token) and an RFC 7591 registration endpoint. The package exports `./testkit` (`startReferenceIdp`, the server as an embeddable test counterparty) and `./ldap-server` (an in-process LDAP server for tests).

## Run

```bash
# from repo root
pnpm --filter @opensesame/mock-upstream-idp build
pnpm --filter @opensesame/mock-upstream-idp start

# or with tsx (dev)
pnpm --filter @opensesame/mock-upstream-idp dev
```

Default listen address: `http://127.0.0.1:9090`. A non-loopback `OPENSESAME_MOCK_IDP_HOST` is refused at startup unless `OPENSESAME_ALLOW_NONLOCAL=1` (or `OPENSESAME_DAEMON_ALLOW_NONLOCAL=1`) is set.

### Endpoints

| Path | Description |
| --- | --- |
| `GET /.well-known/openid-configuration` | Discovery |
| `GET /authorize` | Auto-approve → redirect with `code` (a self-posting form with `response_mode=form_post`). PKCE S256 is required for every client. `prompt=none` without an IdP session cookie answers `login_required` |
| `POST /token` | Authorization code (PKCE verified) and refresh |
| `GET /jwks` | Public signing keys |
| `GET /userinfo` | Test user claims for any bearer token |
| `POST /revoke` | Token revocation; always 200 |
| `POST /register` | RFC 7591 dynamic client registration (404 when `OPENSESAME_MOCK_IDP_REGISTRATION` is off) |
| `GET /saml/metadata`, `GET`/`POST /saml/sso` | SAML IdP metadata and single sign-on |
| `GET /login/oauth/authorize`, `POST /login/oauth/access_token`, `GET /api/user`, `GET /api/user/emails`, `GET /.well-known/oauth-authorization-server` | The GitHub-shaped OAuth2 leg |
| `GET /health` | Liveness |

### Seed confidential client (Better Auth / server RPs)

- `client_id`: `opensesame-upstream`
- `client_secret`: `opensesame-upstream-secret`
- Default redirect: `http://127.0.0.1:3000/api/auth/callback/mock`
- Authenticates at `/token` with `client_secret_post` or `client_secret_basic`.

### Origin-profile clients (federated-signin §1)

When `client_id` is `origin:{canonical origin}`, the mock admits the client
without a secret. `POST /token` requires an `Origin` header that byte-equals
that origin (CORS), PKCE S256 is mandatory, and the ID token `sub` /
`pairwise_sub` is a stable per-origin subject (not the seeded canonical
user id). Redirect URIs must be on that origin. The refresh grant is refused
for these clients.

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
| `OPENSESAME_MOCK_IDP_USER_EMAIL_VERIFIED` | `true` | `email_verified` claim (`1` or `true` is true) |
| `OPENSESAME_MOCK_IDP_FORM_POST` | off | `/authorize` always answers with a self-posting form (`1` or `true`) |
| `OPENSESAME_MOCK_IDP_REGISTRATION` | on | Advertise and serve `/register` (`1` or `true`) |
| `OPENSESAME_MOCK_IDP_CLIENT_MODE` | `both` | `origin_profile` or `confidential` admits only that client mode |
| `OPENSESAME_MOCK_IDP_SAML_ACS_URL` | unset | Fallback ACS URL when an AuthnRequest names none |
| `OPENSESAME_MOCK_IDP_OAUTH2_CLIENT_ID` | `mock-oauth2-app` | GitHub-shaped OAuth2 client id |
| `OPENSESAME_MOCK_IDP_OAUTH2_CLIENT_SECRET` | random per process | GitHub-shaped OAuth2 client secret |
| `OPENSESAME_MOCK_IDP_OAUTH2_REDIRECT_URIS` | empty (any loopback redirect) | Comma-separated exact-match allowlist |
| `OPENSESAME_MOCK_IDP_OAUTH2_USER_ID` | `4242001` | Numeric account `id` |
| `OPENSESAME_MOCK_IDP_OAUTH2_LOGIN` | `mock-octocat` | Account `login` |
| `OPENSESAME_MOCK_IDP_OAUTH2_EMAIL_PRIVATE` | `false` | `true` makes `/api/user` return `email: null`; `/api/user/emails` still answers |
| `OPENSESAME_ALLOW_NONLOCAL` | unset | `1` allows a non-loopback listen host |

## Tests

```bash
pnpm --filter @opensesame/mock-upstream-idp test
```
