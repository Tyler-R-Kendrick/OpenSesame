# ADR 0127 — Thin Connect callback backend

## Status

Accepted.

## Context

Vercel Connect brokers provider OAuth without a Host, but the approval ends
in the provider's browser: somebody must tell the app the dance finished,
and some providers only accept `https` callback URLs. Loopback cannot give
them that. The app also must never hold the Vercel API token server-side —
there is no server side in a static Pages deployment — so whatever receives
the callback must hold nothing at all.

## Decision

`apps/connect-backend` is a zero-dependency callback relay, runnable locally
(`node server.mjs`) and deployable to Vercel (`api/connect/callback.mjs`,
same handler):

- It accepts the Connect/provider redirect, passes every query param
  through untouched, and 302s to the app's `return_to`.
- `return_to` is allowlisted to loopback http(s), its own origin, and
  configured https origins (`OPENSESAME_CONNECT_APP_ORIGINS`). Anything
  else gets a 400 — the relay can never bounce a browser elsewhere.
- The OAuth callback path still holds no provider tokens and no sessions.
- Management routes (`/api/connect/connectors|authorize|revoke`) hold the
  deployment's `VERCEL_TOKEN` server-side so the static PWA never asks a
  person to paste one. Provider tokens stay in Connect.

Local HTTPS for providers that demand it comes from
`scripts/dev/connect-dev-proxy.mjs`: a self-signed certificate for
`<lan-ip>.nip.io` (plain DNS, no account) terminating TLS in front of Vite
and the relay, with HMR upgrades forwarded. One manual trust click per
certificate in the approving browser; the approval itself stays on the
provider's real HTTPS.

The app passes the relay URL as `callbackUrl` when starting a Connect
authorization (`VITE_CONNECT_CALLBACK_BASE` / runtime config, empty by
default), and the connections route closes the popup on landing with
`?connection=` — the existing consent poll would settle anyway; this is
faster and tidier.

## Consequences

- Real logins complete with no Host: popup → provider → relay → app,
  opener settles on `active`.
- The relay's 400-on-unknown-return is covered by node tests; the
  allowlist, not cookies, is the whole of its callback security.
- `VERCEL_TOKEN` on the relay is deployment-owned; Pages never sees it.
- If a provider accepts plain loopback callbacks, the relay and the proxy
  stay out of the road entirely.
