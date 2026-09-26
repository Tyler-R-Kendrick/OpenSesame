# ADR 0146 — Connector plans, whole-configuration connectors, and the user-token proof

- Status: Accepted
- Date: 2026-09-25
- Builds on: [ADR 0005](0005-authority-handle-connectionref.md) (tokens stay
  with the authority), [ADR 0115](0115-front-door-and-connector-directory.md)
  (connectors by reference; a binding is a share of kind `connection`),
  [ADR 0127](0127-connect-callback-backend.md) (the Connect relay),
  [ADR 0128](0128-pages-without-host.md) (Pages speaks no Host), [ADR 0139](0139-one-definition-every-target.md)
  (one definition, every target)

## Context

The Connections page listed about 120 services from Vercel Connect's
catalogue, but almost none could be used:

1. **Every connector was created blank.** Pages sent Connect
   `POST /v1/connect/connectors` with `{ service, name }` only. Connect applies
   a preset only when `connectionMethod` names one, so the connector had no
   OAuth server, no client and no scopes — the same empty record whatever the
   service.
2. **There was nowhere to configure one.** A connector page showed either the
   Host OAuth form (dead since Pages stopped speaking Host, ADR 0128) or the
   sentence "This deployment has no Connect relay". Nothing asked for a client
   ID, an endpoint, a scope, or the relay's management key, and nothing
   anywhere offered to seal a Vercel token.
3. **Authorization was for the app, never for a person.** Every
   authorize and revoke used `subject: { type: "app" }`, so no person's token
   could be acquired and no connector could be delegated per person.
4. **Nothing proved a token could be had.** There was no equivalent of
   Vercel's "Test User Token".
5. **The service list was a hand-kept array** in `vercel-connect-catalog.ts`,
   with no knowledge of any service beyond its name.

## Decision

### 1. A plan per connector, generated from `spec/connectors/`

- `connect-services.json` pins Vercel Connect's public service registry
  (`GET https://api.vercel.com/v1/connect/services`, no credential) and the
  live OAuth discovery of every MCP server it lists (RFC 9728 → RFC 8414 /
  OIDC). `node scripts/release/pin-connect-services.mjs` re-pins it.
- `connect-presets.json` holds what we know about each service: for OAuth,
  the server URL, authorization / token / revocation / userinfo endpoints,
  client authentication, PKCE, scopes with their meaning, extra authorization
  parameters (Google's `access_type=offline`, Atlassian's `audience`),
  per-account host placeholders (`{domain}`, `{shop}`), where to register a
  client, and one read-only verify call; for API keys, where the key is issued,
  the header and scheme (or Basic pair), a key prefix, the API base, the
  instructions a person sees, and one read-only verify call. Researched from
  providers' discovery documents and docs, then held to
  `pnpm test:connect-preflight` (§4).
- Rows of the integration catalog (`catalog.json`) the presets do not cover
  are derived from its own OAuth block; a drift test keeps presets and the
  catalog in agreement wherever both describe a provider.
- `packages/app-core/scripts/emit-connect-presets.mjs` merges the three into
  one plan per connector (`connect-plan.ts`, zod-parsed); the Connections
  catalog is built from the plans. Every plan has at least one method —
  Vercel's managed app, a self-registering MCP server, an OAuth preset, an API
  key, or the generic OAuth integration with every field the person's to fill.
  There is no blank page.

### 2. A connector is created whole

`connect-create.ts` turns a plan plus what the person typed into Connect's
own request shapes, held to Vercel's published create schema in tests:

- OAuth with a client the person registered: `type: "oauth"` with
  `serverUrl`, `serverConfig` endpoints, `tokenEndpointAuthMethod`,
  `codeChallengeMethod` / `pkceRequired`, `authorizationUrlParams`,
  `userAuthorization.scopes` and `refreshTokens`.
- OAuth where the server registers its own clients (RFC 7591, or a client ID
  metadata document) and the person pasted none: the preset
  (`connectionMethod: "oauth"`), so Vercel registers the client — how Vercel
  itself creates a Resend connector.
- MCP: the preset (`connectionMethod: "mcp"`); a client ID only where the
  server registers none.
- API key: `subjectType: "user"` by default, so each person pastes their own
  key while authorizing; `app` with a shared key when asked.
- Managed (Slack, Linear, Microsoft, …): Vercel's own app.

The connector page shows the plan's whole configuration, editable, before and
after creation (`PATCH` through the relay), and never a secret it does not
hold: a blank secret keeps the stored one.

### 3. A person authorizes for themselves; the relay proves the token

- Authorization carries `subject: { type: "user", id }` — the signed-in
  principal, or a vault-scoped id for a device with no Identity session. The
  relay accepts only `app` or a `user` with a well-formed id.
- `POST /api/connect/token-check` (management key) requests the person's
  token from Connect, fingerprints it (`sha256`, 12 hex), calls the service's
  own verify endpoint with it and answers
  `{ subject, expiresAt, scopes, fingerprint, verified: { status, ok, account } }`.
  **The token never leaves the relay.** The verify target is chosen from the
  pinned presets by the connector's service (or, for a custom OAuth
  connector, its host) — never from the request — with no redirects followed
  and a bounded read; `{domain}`-style values are recovered only from the
  connector's own stored endpoints and only as host-shaped strings.
- A page with no relay can create, edit and authorize connectors with a
  sealed Vercel token, but cannot run the proof: that would put a provider
  token in the page (ADR 0005).

### 4. Every connector is proven

- `apps/pages/src/lib/connect-conformance/` drives each plan × method end to
  end: the page's own builders create the connector through the real relay
  handlers; a Connect emulator holds every body to Vercel's schema and runs a
  real authorization-code exchange (or RFC 7591 registration, or a CIMD
  client) against a strict provider emulator that enforces the preset's client
  authentication, PKCE, redirect URI and required parameters; the relay's
  token proof then acquires the person's token and the provider's verify call
  answers yes. Negative controls (wrong client authentication, wrong secret,
  PKCE dropped, a token the service refuses) fail the way a provider would.
- `pnpm test:connect-preflight` checks every real endpoint read-only: each
  OAuth authorization endpoint answers as a live server, each discovery
  document agrees with its preset, each MCP server's metadata chain resolves,
  and each API-key verify endpoint demands a key.
- Against a live Vercel Connect account the same flow needs a person to
  approve at the provider; `docs/operators/connect-connectors.md` is the
  runbook.

### 5. Access is the share ledger

A connector page's Access panel writes `connection` shares
(`local-share-grants.ts`) — person or agent, policy, duration — the ledger
Access › Resources already reads (ADR 0115). No second authority model.

## Consequences

- 186 connectors (166 in Vercel's registry, 20 more from the integration
  catalog) open filled in; 220 connector × method paths across 185 services
  are proven to end in a person's token in conformance, every one confirmed
  by the service's own verify call. Linq and Snowflake, run by Vercel with
  its own app and publishing nothing a client can exercise, are the two
  proven only against live Connect.
- The presets are research, pinned: a provider that moves an endpoint fails
  `test:connect-preflight` rather than a person's first authorization.
- Two managed rows (Linq, Snowflake) publish nothing a client can exercise and
  are proven only against live Connect.
- GitHub keeps its GitHub App flow (ADR 0126); the Git forges keep their
  backup form beside the Connect panels.
- Connect draws a row from its plan, and is its only road, when Vercel's
  registry lists the service, when it is a Git forge, or when Pages bundles no
  row of its own. A bundled row Vercel does not list (Doppler, Hugging Face)
  keeps its own row and road, with Connect beside it.
- Card issuers (Privacy, Lithic, Marqeta, Stripe Issuing — catalog category
  `wallet`) are refused on Connect like the payment rails (ADR 0086 §6); their
  bundled rows keep the lease-and-ledger road of ADR 0123.
- Signed out, a person's Connect subject is a random id the device keeps for
  the vault, never the vault's name: every device's personal vault shares
  that name, and two people must never share a token.
- Saving a connector's settings sends only what the person changed, as a
  merge patch against what Connect read back, and refuses an edit that
  introduces a problem; Connect never returns a secret or, sometimes, a
  preset's defaults, so an untouched field is never resent or wiped.
- New relay routes: `POST /api/connect/connector/read`,
  `/api/connect/connector/update`, `/api/connect/token-check`, all behind the
  management key; `POST /api/connect/connectors` now forwards the whole
  configuration (Connect's create keys only).
