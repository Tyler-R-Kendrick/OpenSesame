# Operator guide (product experience)

## Visual / Source preferences

1. Open Settings → General (or the rail entry `settings/prefs.yaml`).
2. Appearance and locking are the Visual editor. The Source toggle shows the same draft as YAML.
3. Switching modes without editing keeps comments and blank lines.
4. `autoLockMinutes` may be any non-negative number (for example `7`). It is not coerced to 5 or 15.
5. `prefsRevision` cannot be written from source.
6. `.config/opensesame/prefs.yaml` is an alias of the same resource, not a second store.

## Commands

- `/` still searches the current pane.
- `Ctrl-l` or `:` opens the existing command bar (palette).
- Keybinding imports that name URLs or unknown actions are refused; the previous map stays.

## Host configs

When a project has no configs, Settings → Connectivity (Host configs) can create one in the UI. Source never shows stored secret values.

## Hosted OIDC applications

Identity › OIDC applications › Edit application is Visual/Source over the same client. Source writes PATCH `/v1/oauth/clients/:id`. `ownerPrincipalId` cannot be set in source. Workload `client_credentials` requires a confidential method (`private_key_jwt`) plus a public JWKS stored on the client row (`token_endpoint_jwks`). Token minting is `POST /token` on the Identity issuer, not a browser session. PATCH the JWKS to retire a key; PATCH `state: suspended` to stop minting. Replicas share the same Postgres row. Preview claims calls the same projector as issuance and does not sign a token.

OAuth2 Proxy is not native. Pin `v7.8.2`, point `oidc_issuer_url` at Identity discovery, use a public PKCE client, and never put a client secret in the generated recipe. The pinned binary still requires a non-empty `--client-secret` CLI value even for public PKCE; that placeholder is not a credential and must not be copied into the recipe. Live binary `/ping` against Identity discovery is covered by `oauth2-proxy-live.test.ts`.

Org owners set SCIM group-id → role mappings at `PUT /v1/organizations/:id/scim/mappings/:groupId`. A group named `owners` still grants nothing without that mapping.

## First-admin enrollment (hosted Identity)

There is no public first-user-wins administrator. An operator mints a short-lived single-use ticket, then the intended first admin consumes it:

1. `POST /v1/enrollment/tickets` with `Authorization: Bearer $OPENSESAME_OPERATOR_TOKEN`. The plaintext ticket is returned once.
2. `POST /v1/enrollment/bootstrap` with `{ "ticket": "...", "organization": { "slug": "...", "displayName": "..." } }`.
3. A second browser or a replay after restart with the same ticket is refused.

Tickets are hashed in durable store (`OpenSesame:EnrollmentTicket`). They are not a substitute for later organization membership administration.

## Limits

Guest/static Pages still need no Host or Identity. Hosted claims, client credentials, and SCIM require the Identity API. Simulation never issues tokens. Central revocation is not instant at an independent offline JWT verifier.
