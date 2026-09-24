# connect-backend

Connect callback relay and management proxy for Vercel Connect. The
callback path holds no provider tokens or sessions. Management routes hold
the deployment `VERCEL_TOKEN` server-side — see ADR 0127.

## Layout

| Path | What it holds |
|------|---------------|
| `src/` | The relay itself: the callback, management and GitHub App handlers, the `return_to` allowlist, the forge host guard and the pinned fetch. `src/server.mjs` serves all of them on `:8789` for local use. |
| `api/` | Vercel serverless routes, one file per route. Each is a thin adapter over a handler in `src/`. |
| `test/` | `node --test` suites (`pnpm --filter @opensesame/connect-backend test`). |

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

## Who may manage connectors

The relay is public, and an `Origin` header is something any non-browser
client can write. So the Origin allowlist is CORS, never authorization:

| Route | Gate |
|-------|------|
| `GET /api/connect/connectors` | Origin allowlist. Answers only the fields the Pages catalog maps (ids, names, service, timestamps, granted scope names) — never the upstream body whole. |
| `POST /api/connect/connectors` | Origin allowlist **and** `Authorization: Bearer <OPENSESAME_CONNECT_MANAGE_KEY>` |
| `POST /api/connect/authorize` | same, and `callbackUrl` must be this relay's own `/api/connect/callback` carrying only an allowlisted `return_to` (400 `invalid_callback` otherwise) |
| `POST /api/connect/revoke` | same |

The key is compared in constant time. With `OPENSESAME_CONNECT_MANAGE_KEY`
unset (or shorter than 32 characters) every mutation answers 403
`management_disabled` — the relay fails closed. A missing or wrong key is
401. Generate one with `openssl rand -base64 48`.

Pages sends the key only when the operator has provided it: it rides in the
sealed Vercel Connect record (`config/vercel-connect-auth`, field
`manageKey`) inside the vault, never in plaintext storage, and only on the
three mutations. A visitor without it can still list, and a create,
authorize or revoke from their session is refused.

If the relay sits behind a proxy that rewrites `Host` (the dev proxy below
does), set `OPENSESAME_CONNECT_RELAY_ORIGIN` to the relay's public origin so
`callbackUrl` still matches it.

`POST /api/github-app/webhook-pending` drains an installation's webhook
nudges only after GitHub itself answers `GET /app/installations/{id}` with
200 for a JWT the presented key signs, and names the same `app_id`. A key
that merely parses drains nothing.

`POST /api/git-backup/put` with `forge: "gitea"` takes a `baseUrl` that
must be a bare `https://host[:port]` origin — no userinfo, path, query or
fragment — whose name is neither an IP literal nor a DNS answer in a
loopback, private, link-local, CGNAT, metadata or other non-public range.
The request then connects only to the addresses that check vetted
(`src/pinned-fetch.mjs` answers the socket's lookup from that list, while SNI,
certificate verification and `Host` keep the name), so a resolver that
answers differently the second time (DNS rebinding) cannot steer it to a
private address. Forge requests never follow redirects. An operator can pin
the accepted hosts with `OPENSESAME_GITEA_HOSTS` (comma-separated `host` or
`host:port`; listed hosts are trusted as written and resolved normally).
Requests with no `Origin` are refused.

## Run it locally

```bash
export VERCEL_TOKEN=…                 # required for create/authorize/revoke
export OPENSESAME_CONNECT_MANAGE_KEY=… # ≥ 32 chars; unset → mutations refused
export VERCEL_TEAM_ID=…               # optional
export VERCEL_PROJECT_ID=…            # optional
export OPENSESAME_CONNECT_APP_ORIGINS=http://localhost:5180
node apps/connect-backend/src/server.mjs        # :8789
```

Pages talks to this relay for managed connectors (GitHub included). Set
`VITE_CONNECT_CALLBACK_BASE=http://127.0.0.1:8789` in `apps/pages/.env.local`.
There is no browser arm-token form — the relay holds the Vercel token.

## Deploy it

Vercel project rooted at `apps/connect-backend` — `api/connect/callback.mjs`
is the same handler as a serverless function. Set
`OPENSESAME_CONNECT_APP_ORIGINS` to the app origin, and
`OPENSESAME_CONNECT_MANAGE_KEY` (a Sensitive environment variable) if the
deployment should create, authorize or revoke connectors at all.

## Local HTTPS for providers that demand it

```bash
node scripts/dev/connect-dev-proxy.mjs          # :8443
```

Terminates TLS for `<lan-ip>.nip.io` (self-signed, generated into the
system temp dir) in front of Vite (`:5180`) and the relay (`:8789`), HMR
upgrades included. It prints the two values the session needs:

```bash
VITE_CONNECT_CALLBACK_BASE=https://<lan-ip>.nip.io:8443
OPENSESAME_CONNECT_APP_ORIGINS=http://localhost:5180
```

The proxy rewrites `Host` to `127.0.0.1:8789`, so also start the relay with
`OPENSESAME_CONNECT_RELAY_ORIGIN=https://<lan-ip>.nip.io:8443`.

Put the first in `apps/pages/.env.local` (dev) or `os-runtime-config.json`
(deploy). Visit the https URL once in the approving browser and accept the
dev certificate. Providers that accept plain loopback callbacks skip all of
this — leave the callback base empty.
