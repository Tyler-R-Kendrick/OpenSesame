# Static-site AgentAuth

A static origin can advertise OpenSesame as its authorization server without an
application backend and without a client secret (ADR 0090, ADR 0092).

1. Publish `/auth.md` and `/.well-known/oauth-protected-resource` as static files.
   Point `authorization_servers` at the hosted Identity API.
2. Agents register at `POST {issuer}/agent/identity`.
3. Humans claim at `{issuer}/claim` after signing in to OpenSesame.
4. Agents exchange `os-sia+jwt` assertions at `{issuer}/oauth2/token`.
5. Protected APIs that participate return
   `WWW-Authenticate: Bearer resource_metadata="…"`.

See `apps/example-static-agent`. Human OIDC for static sites remains
`apps/example-static-rp` (PKCE, exact-origin CORS, origin-profile clients).
