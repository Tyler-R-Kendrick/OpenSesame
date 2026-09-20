# connect-backend

Connect callback relay and management proxy for Vercel Connect. The
callback path holds no provider tokens or sessions. Management routes hold
the deployment `VERCEL_TOKEN` server-side — see ADR 0127.

## What it does

When a Connect authorization is started with a `callbackUrl` pointing here,
the provider returns the browser to `/api/connect/callback`. The relay
forwards the browser to the app's `return_to` with every query param passed
through untouched. The app polls the connection and settles on `active`; a
`?connection=` landing also closes the popup early.

GitHub App Manifest registration uses the same relay shape:

- `GET /api/github-app/callback?return_to=…` — GitHub posts `code` + `state`
  here; the relay bounces the browser to `return_to` (same allowlist).
- `POST /api/github-app/convert` — proxies the one-time code to
  `api.github.com` so the SPA never needs CORS against GitHub. Pages uses
  this for localhost, GitHub Pages, and Vercel — one callback URL formula,
  no Host.

`return_to` allowlist: loopback http(s), the relay's own origin, and
`OPENSESAME_CONNECT_APP_ORIGINS` (comma-separated https origins). Anything
else gets a 400.

## Run it locally

```bash
export VERCEL_TOKEN=…                 # required for create/authorize/revoke
export VERCEL_TEAM_ID=…               # optional
export VERCEL_PROJECT_ID=…            # optional
export OPENSESAME_CONNECT_APP_ORIGINS=http://localhost:5180
node apps/connect-backend/server.mjs        # :8789
```

Pages talks to this relay for managed connectors (GitHub included). Set
`VITE_CONNECT_CALLBACK_BASE=http://127.0.0.1:8789` in `apps/pages/.env.local`.
There is no browser arm-token form — the relay holds the Vercel token.

## Deploy it

Vercel project rooted at `apps/connect-backend` — `api/connect/callback.mjs`
is the same handler as a serverless function. Set
`OPENSESAME_CONNECT_APP_ORIGINS` to the app origin.

## Local HTTPS for providers that demand it

```bash
node scripts/connect-dev-proxy.mjs          # :8443
```

Terminates TLS for `<lan-ip>.nip.io` (self-signed, generated into the
system temp dir) in front of Vite (`:5180`) and the relay (`:8789`), HMR
upgrades included. It prints the two values the session needs:

```bash
VITE_CONNECT_CALLBACK_BASE=https://<lan-ip>.nip.io:8443
OPENSESAME_CONNECT_APP_ORIGINS=http://localhost:5180
```

Put the first in `apps/pages/.env.local` (dev) or `os-runtime-config.json`
(deploy). Visit the https URL once in the approving browser and accept the
dev certificate. Providers that accept plain loopback callbacks skip all of
this — leave the callback base empty.
