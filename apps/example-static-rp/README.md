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
| `/` | ESM `createOpenSesame({ issuer })` — zero-config origin mode |
| `/opensesame/callback` | Completes PKCE and returns to `returnTo` |

Default redirect URI: `{origin}/opensesame/callback`.

## Run both origins

```bash
pnpm --filter @opensesame/control-plane start   # :8788, origin clients on
pnpm --filter @opensesame/example-static-rp dev:4101   # http://127.0.0.1:4101
pnpm --filter @opensesame/example-static-rp dev:4102   # http://127.0.0.1:4102
```

A hosted IIFE bundle is not part of this package; sdk-browser is consumed as
an ESM module (slice 4 deferred the IIFE).
