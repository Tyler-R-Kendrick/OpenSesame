# ADR 0032: Connection broker for service integrations

## Status
Accepted

## Context
ADR 0005 defined `ConnectionRef` and the invariant that a handle is not a capability, and
ADR 0006 defined how a connection is projected into a workload. Both assumed a connection
already existed. Nothing acquired one: there was no provider catalog, no third-party
authorization-code flow, no credential storage, and no refresh. `wit/connector/world.wit`
declared `host-oauth.acquire` with no implementation, and the `connections` table in
`migrations/0001_init.sql` was never written to.

Nango, Paragon and Merge solve acquisition with a hosted broker that holds provider
credentials and refreshes them. That model conflicts with the client-side vault, where
OpenSesame holds nothing it can read. The two are reconciled by treating them as different
assets rather than by picking one.

## Decision
1. **A connection is authority-plane state, not vault state.** The vault is end-to-end
   encrypted and the server cannot read it. A connection credential is deliberately the
   opposite: the authority plane must decrypt it to inject at egress and to refresh it while
   the human is absent. These are separate stores with separate threat models, and the UI
   must say so rather than imply the vault holds provider tokens.
2. **Authorize once, per identity scope.** A connection is owned by an organization,
   optionally narrowed to a project, and is bound to the agents/projects permitted to use
   it. Re-authorization is required only to widen scopes or after refresh fails.
   The organization is not on its own an access boundary: one gateway serves many
   callers out of a single organization, so the caller a connection was created for
   is recorded on the row, and only that caller — or an operator — may read, authorize,
   re-key, refresh, revoke or bind it. A connection with no recorded owner is
   operator-only rather than everybody's.
3. **Provider catalog is data, not code paths.** Each provider declares its endpoints,
   scope vocabulary, token-endpoint auth method, refresh support, and — critically — its
   default `EgressBinding`. The egress allowlist that ADR 0005 enforces is derived from the
   provider, so a GitHub connection cannot be used to reach a non-GitHub host.
4. **Authorization code + PKCE S256 always**, including for confidential clients. `state` is
   single-use, TTL-bound, and bound to the connection it started from.
5. **Refresh is a broker responsibility.** Access tokens refresh ahead of expiry when a
   refresh token allows it. Refresh-token rotation is assumed: a rotated token replaces its
   predecessor atomically. Exhausted or rejected refresh moves the connection to
   `needs_reauth` rather than deleting it, so bindings and audit survive.
6. **Credential material never crosses the API boundary.** Connection responses carry
   status, scopes, expiry and bindings. There is no endpoint that returns an access token,
   a refresh token, or a client secret. Level 3 materialization stays denied per ADR 0005.
7. **Credentials are encrypted at rest** under a deployment key, with the connection and
   organization ids as associated data, so a row lifted from one tenant does not decrypt
   under another.
8. **A provider with no configured client is shown, not hidden.** The catalog reports
   `configured: false` and names the environment variables the deployment is missing.
   Offering a connect button that cannot work is worse than saying why.

## Consequences
- New `crates/connection-broker`; `crates/storage` gains a versioned migrator so schema can
  change after `0001_init.sql`.
- The gateway gains connection lifecycle routes and a real `GET` OAuth callback, replacing
  the stub in `apps/callback-edge` that discarded the code.
- `GET /api/v1/connections` keeps returning `connection_ref` and stays reference-only.
- The PWA gains a Connections section: the first surface where OpenSesame holds something on
  the user's behalf, which the copy must make explicit.
- Provider tokens become an asset worth stealing from the authority plane. This is the cost
  of refresh-while-absent and is why §6 and §7 are not negotiable.
