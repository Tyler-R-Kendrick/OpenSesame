# @opensesame/example-static-rp

Genuine **static** relying party for the OpenSesame origin-profile issuer (ADR
0050). No RP application backend, no token-exchange routes. The browser SDK
talks directly to the Identity API token endpoint (exact-origin CORS + PKCE +
`client_id=origin:…`).

Two dev servers on different ports exercise **pairwise isolation** across
origins (same files, distinct `origin:…` client ids and pairwise subjects).

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENSESAME_ISSUER` | `http://127.0.0.1:8788` | OpenSesame issuer / Identity API |

The origin-profile issuer must be enabled on the control plane:
`OPENSESAME_ORIGIN_CLIENTS_ENABLED=true`.

## Pages

| Path | Pattern |
|------|---------|
| `/` | Canonical `createHostedClient` with explicit hosted Identity profile |
| `/opensesame/callback` | Consumes the PKCE transaction, verifies issuer/nonce/RP audience and displays the subject |

Default redirect URI: `{origin}/opensesame/callback`.

## Run both origins

```bash
pnpm --filter @opensesame/control-plane start   # :8788, origin clients on
pnpm --filter @opensesame/example-static-rp dev:4101   # http://127.0.0.1:4101
pnpm --filter @opensesame/example-static-rp dev:4102   # http://127.0.0.1:4102
```

The example consumes `@opensesame/static-auth` as ESM. Its immutable, SRI-pinned
IIFE is also available from Pages; see `docs/operators/pages-origin.md`.
No token is stored by this example or inserted into HTML. Reloading the page
does not fabricate an authenticated session. The issuer must return an exact
`iss` authorization response and expose its configured JWKS endpoint with
exact-origin CORS.
