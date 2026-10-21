# ADR 0184 — Linear authorizes and runs directly in the browser

- **Status:** Accepted; amended 2026-10-21
- **Date:** 2026-10-08
- **Amends:** [ADR 0183](0183-self-hosted-connector-configuration.md)
- **Uses:** [ADR 0128](0128-pages-without-host.md), [ADR 0149](0149-nothing-stored-in-the-clear.md), [ADR 0185](0185-native-browser-connectors.md)

## Context

The Linear form saved configuration but never applied it to Linear. Its
pending row could not execute a provider operation. A working static deployment
needs a real authorization road that does not require Vercel or a native API.
Linear supports public-client S256 PKCE, token refresh with the client ID,
and browser CORS for its token and GraphQL endpoints.

## Decision

1. **Managed** uses the deployment's registered public `linearClientId`;
   **Bring Your Own** uses a person-supplied Linear application ID or API key.
   The application registration and exact redirect URI belong to the operator.
   Public PKCE needs no client secret. No credential goes to a form-supplied
   endpoint; the driver fixes authorization and API destinations to Linear.
2. Authorize app and user actors separately with their selected scopes.
   Consent uses comma-separated scopes, `prompt=consent`, random state and
   S256. The encrypted, ten-minute pending transaction binds the connector,
   actor, application, configuration and redirect URI. Consume it once before
   exchange. `auth/linear.html` translates provider parameters into a namespace
   before app boot, so identity sign-in cannot consume provider consent.
3. Read Linear's viewer, organization and teams before accepting a key or
   OAuth grant. An optional expected workspace must match its ID, name or URL
   key; app and user must authorize the same organization. Store only
   provider-reported granted scopes. A key's specific permissions remain
   provider-managed rather than being represented as OAuth scope grants.
4. Keep access tokens, rotating refresh tokens and webhook signing secrets in
   the private half of the atomic encrypted device record. Wait for storage
   before success, redirect or invoking with a refreshed token. Public readers
   expose account/workspace identities, expiry and actual grants, never tokens.
   A reduced refresh grant persists accurately and requires reauthorization.
   Invalid tokens mark the actor for reauthorization. Safe label/icon edits
   preserve grants; changed actor scope sets revoke the old grant and reconsent.
5. Run typed, awaited GraphQL issue/project reads and issue creation. Lists
   request bounded summaries. Send only the selected actor's access token,
   using Bearer for OAuth and the raw API key for a personal key. Never use
   the generic invented connector-operation URL or secret-header map for Linear.
6. Webhooks are opt-in and require an HTTPS receiver plus app `admin` scope
   or an administrative API key. Persist a UUID/signing-secret intent before
   provider creation; retry reconciles that exact ID and configuration.
   Report completion only after Linear confirms an enabled subscription and
   its metadata is durable. Let the person copy the signing secret explicitly
   through the existing clipboard clearing mechanism. The static browser
   registers the subscription; the supplied receiver processes incoming events.
   Reconsent retains a durable obligation bound to the original workspace,
   permitting a fresh verified credential to reconcile an expired credential's
   subscription. The connection stays pending through cleanup and replacement.
   Temporary admin permission is revoked and replaced by the selected scopes
   before activation; selecting no app scopes removes the temporary grant.
   A replacement API key must verify the original workspace.
7. Disconnect removes the registered webhook and revokes OAuth access/refresh
   grants before forgetting their encrypted records. Progress is durable per
   actor, and repeated cleanup verifies provider absence rather than assuming
   any error means success. API keys supplied by a person are removed locally;
   the app does not destroy a potentially shared key in Linear.
   Rejected grants and refresh rotations are journaled before further provider
   mutations. Cleanup uses its own actor lease so each rotation can take the
   device-record lock; exact grant comparisons and a guarded atomic tombstone
   preserve concurrent authorizations. Unselected actors have a cleanup action
   that does not start OAuth consent.

## Amendment — 2026-10-21: Linear's default road is MCP

New Linear connections use Linear's published MCP authorization through the
compiled native MCP route. CIMD is preferred and needs no OAuth application;
when live metadata omits CIMD support, DCR is used only if the live registration
endpoint exactly matches the compiled endpoint. The primary page requests the
provider-advertised `read` permission by default. It does not ask a person to
choose Managed versus Bring Your Own and does not collect a client ID.

The specialized GraphQL OAuth, webhook and personal-API-key route in this ADR
remains available under an explicit Advanced disclosure for new connections,
and remains the custody route for existing specialized records. It is a separate
transport with separate sealed credentials; an MCP token is never silently
reused for GraphQL. OAuth application manifests may prefill a person's own
Linear application when they deliberately choose that fallback. XAA/EMA is not
enabled: no verified enterprise IdP, resource-client registration or token
exchange contract exists for this deployment.

## Consequences

Linear connections can become active and run real operations on a static,
self-hosted deployment. OAuth redirects require durable browser storage;
API-key verification can also operate in an explicitly session-only store.
The connector name and optional icon identify the local connection; they do
not rename the registered Linear OAuth application.

Protocol and production-browser tests exercise provider HTTP contracts,
failures, replay, workspace binding, rotation, revocation, webhook recovery
and encrypted reload. They use a disclosed protocol test authority; a real
person must grant consent to their own Linear application for a live account.
Live unauthenticated CORS preflight checks independently verify browser access
at Linear's official endpoints.

The new optional driver adds 59 KiB JavaScript and 19 KiB gzip across the
full production bundle (5668/1759 → 5727/1778 KiB), measured against base
`9c820c84abb1dc457ead0eb1aff27f8576b98fd0`, including the incoming record
workspace migration's effects on chunking. Its explicit full-app ceilings
increase from incoming 5676/1768 to 5727/1778 KiB, the measured minimum with
no extra headroom. The incoming 172 KiB CSS ceiling is preserved. Both hardened
local profiles exclude the driver and remain within their existing budgets:
the new base measures 3154/999 KiB and the merged result 3155/999 KiB in
each profile. Their budgets remain unchanged; no structural or anti-slop
debt is added.
