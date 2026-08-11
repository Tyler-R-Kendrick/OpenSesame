# Connection broker

How a user authorizes a third-party service once, and how that authorization is brokered to
organizations, projects and agents. Decisions and rationale are in ADR 0032; enforcement
invariants come from ADR 0005. Provider-template and organization-integration decisions are
in ADR 0035.

## Planes

| Plane | Holds | Can read it? |
|---|---|---|
| Vault (`apps/pages`, OPFS) | passwords, passkeys, notes | No — sealed under the master password |
| Authority (gateway `:8787`) | provider access/refresh tokens | Yes — required for egress injection and refresh |

A connection is authority-plane state. The PWA is a control surface over it and never
receives credential material.

## Lifecycle

```
        POST /connections            POST /connections/{id}/authorize
draft ─────────────────────► pending ──────────────────────────────► (provider consent)
                                │                                            │
                                │            GET /oauth/callback/{provider}  │
                                ▼                                            ▼
                            failed ◄──── exchange error ──── code+state ──► active
                                                                             │
                    refresh ahead of expiry (automatic) ─────────────────────┤
                                                                             │
                    refresh rejected / revoked upstream ──► needs_reauth ────┤
                                                                             │
                    DELETE /connections/{id} ────────────► revoked ◄─────────┘
```

`needs_reauth` keeps the connection row, its bindings and its audit trail. Re-running
`authorize` on it returns it to `active` without rebinding anything.

## Status vocabulary

| Status | Meaning | User action |
|---|---|---|
| `pending` | created, consent not yet completed | finish the authorize flow |
| `active` | usable; access token valid or refreshable | none |
| `needs_reauth` | refresh failed or was revoked upstream | re-authorize |
| `expired` | access token expired and no refresh token exists | re-authorize |
| `revoked` | revoked here | none; create a new connection |
| `error` | exchange or provider failure; `status_detail` explains | retry or re-authorize |

## HTTP contract

Base `http://127.0.0.1:8787`. Auth is the gateway's existing scheme:
`Authorization: Bearer operator:<token>` or `Bearer opaque-session:<id>`.
Operators may select an organization with `X-OpenSesame-Organization: org:<uuid>`;
without it they use the bootstrap organization. Sessions are always fenced to their signed
organization claim and are forbidden from sending that header.
The OAuth callback is the one unauthenticated route — it is authenticated by `state`.

### Catalog

```
GET /api/v1/providers
200 { "providers": [ Provider ] }
```

```jsonc
Provider = {
  "id": "github",
  "display_name": "GitHub",
  "category": "developer" | "productivity" | "communication" | "storage" | "crm" | "payments" | "identity" | "testing",
  "docs_url": "https://docs.github.com/apps/oauth-apps",
  "auth_kind": "oauth2_authorization_code" | "api_key",
  "supports_refresh": true,
  "configured": false,                       // deployment has client id + secret
  "callback_url": "https://host.example/api/v1/oauth/callback/github",
  "missing_config": ["OPENSESAME_PROVIDER_GITHUB_CLIENT_ID", "..."],  // [] when configured
  "scopes": [ { "name": "repo", "description": "Full control of private repositories",
                "sensitive": true, "default": false } ],
  "egress": { "scheme": "https", "authorities": ["api.github.com"], "path_prefixes": [] },
  "operations": ["repository.read", "pull_request.create"]
}
```

### Integrations

```
GET    /api/v1/integrations       200 { "integrations": [ Integration ] }
POST   /api/v1/integrations       201 Integration                 // owner/admin
GET    /api/v1/integrations/{id}  200 Integration
PATCH  /api/v1/integrations/{id}  200 Integration                 // owner/admin
DELETE /api/v1/integrations/{id}  204                             // owner/admin, unused only
```

An integration contains `id`, `key`, `provider_id`, `display_name`, `source`
(`organization`, `shared_dev`, or `deployment`), `enabled`, `configured`, `callback_url`,
`scopes`, `client_id_hint`, `has_client_secret`, `connection_count`, `created_by`, and
timestamps. Client secrets are write-only. Omitting `client_secret` on PATCH preserves it;
an empty value clears it. `provider_id` is immutable; changing providers requires a new
integration. Environment integrations are read-only.

### Connections

```
GET    /api/v1/connections                      200 { "connections": [ Connection ] }
                                                // the caller's own; an operator sees the organization
POST   /api/v1/connections                      201 Connection
GET    /api/v1/connections/{id}                 200 Connection
DELETE /api/v1/connections/{id}                 200 { "revoked": true,
                                                      "provider_revocation": "ok"|"unsupported"|"failed" }
POST   /api/v1/connections/{id}/authorize       200 { "authorization_url", "state", "expires_at" }
POST   /api/v1/connections/{id}/refresh         200 Connection
POST   /api/v1/connections/{id}/credential      200 Connection   // api_key providers only
POST   /api/v1/connections/{id}/bindings        200 Connection
DELETE /api/v1/connections/{id}/bindings/{bid}  200 Connection
GET    /api/v1/connections/{id}/events          200 { "events": [ Event ] }
GET    /api/v1/oauth/callback/{provider_id}     302 or text/html   // provider redirect target
```

```jsonc
Connection = {
  "connection_id": "connection_01J...",
  "integration_id": "integration_01J...",
  "connection_ref": "conn://<org>/<project>/github/main",   // ADR 0005 URI; always present
  "logical_name": "github/main",
  "display_name": "GitHub — acme",
  "provider_id": "github",
  "status": "pending",
  "status_detail": null,                    // human-readable cause when status is error/needs_reauth
  "organization_id": "organization_01J...",
  "project_id": null,
  "owner_kind": "organization",
  "shareability": "private" | "delegable" | "organization_wide",
  "requested_scopes": ["repo"],
  "granted_scopes": [],                     // as returned by the provider
  "account_label": null,                    // who we are connected as, e.g. "acme"
  "expires_at": null,                       // access token expiry
  "refreshable": false,
  "last_refreshed_at": null,
  "max_invoke_level": 2,
  "egress": { "scheme": "https", "authorities": ["api.github.com"], "path_prefixes": [] },
  "bindings": [ Binding ],
  "created_at": "2026-...", "updated_at": "2026-..."
}

Binding = { "id", "target_kind": "organization"|"project"|"agent",
            "target_id", "target_label", "created_at" }

Event = { "id", "kind": "created"|"authorize_started"|"authorized"|"refreshed"
                       |"refresh_failed"|"bound"|"unbound"|"revoked"|"error",
          "at", "detail" }
```

**No response body on any route may contain an access token, refresh token, authorization
code, code verifier, or client secret.** This is asserted in tests against the leak denylist
in `crates/authz/src/authority_use.rs`.

### Request bodies

```jsonc
POST /integrations
{ "key": "engineering", "provider_id": "github", "display_name": "Engineering GitHub",
  "scopes"?: [string], "client_id"?: string, "client_secret"?: string }

PATCH /integrations/{id}
{ "key"?: string, "display_name"?: string, "enabled"?: boolean, "scopes"?: [string],
  "client_id"?: string, "client_secret"?: string } // empty credentials clear; provider immutable

POST /connections
{ "integration_id": "integration_01J...", "provider_id"?: "github",
  "display_name"?: string, "logical_name"?: string,
  "project_id"?: string, "scopes"?: [string], "shareability"?: string }

POST /connections/{id}/authorize
{ "redirect_uri"?: string, "scopes"?: [string] }   // redirect_uri must be deployment-allowlisted

POST /connections/{id}/credential
{ "value": string }                                 // api_key providers

POST /connections/{id}/bindings
{ "target_kind": "project"|"agent"|"organization", "target_id": string, "target_label"?: string }
```

### Errors

`{ "error": "<code>", "hint": "<human sentence>" }` with codes:
`provider_unknown`, `provider_unconfigured`, `connection_not_found`, `invalid_state`,
`integration_not_found`, `integration_required`, `integration_conflict`,
`integration_read_only`, `integration_in_use`,
`state_expired`, `exchange_failed`, `not_refreshable`, `needs_reauth`, `redirect_not_allowed`,
`binding_exists`, `binding_not_found`, `unsupported_credential`, `invalid_request`,
`internal_error`, `unauthorized`, `forbidden`.

## Authorization flow

1. PWA `POST /connections` → `pending` connection.
2. PWA `POST /connections/{id}/authorize` → `authorization_url`. Broker stores the PKCE
   verifier and a single-use `state` (10 minute TTL) bound to the connection id.
3. PWA opens `authorization_url` in a popup.
4. Provider redirects to `GET /api/v1/oauth/callback/{provider_id}?code=…&state=…`.
5. Broker validates and consumes `state`, exchanges the code with the PKCE verifier,
   encrypts and stores the token set, sets `active`, and returns an HTML page that posts
   `{ type: "opensesame:connection", connectionId, status }` to `window.opener` and closes.
6. PWA also polls `GET /connections/{id}` so a blocked `postMessage` or a manually closed
   popup still converges.

`state` is single-use: replaying a consumed `state` returns `invalid_state`.

## Refresh

- A token is refreshed when `expires_at - now < refresh_skew` (60s), on demand at use, or
  when `POST /connections/{id}/refresh` is called.
- Rotation is assumed: if the provider returns a new refresh token, it atomically replaces
  the old one. If it does not, the existing one is retained.
- A rejected refresh sets `needs_reauth` with `status_detail`, and records a
  `refresh_failed` event. It does not delete the connection.

## Provider configuration

Per provider, from the environment:

```
OPENSESAME_PROVIDER_<ID>_CLIENT_ID
OPENSESAME_PROVIDER_<ID>_CLIENT_SECRET
OPENSESAME_PROVIDER_<ID>_AUTHORIZE_URL   # optional; self-hosted GitLab, Jira, etc.
OPENSESAME_PROVIDER_<ID>_TOKEN_URL       # optional
```

`<ID>` is the provider id upper-cased with `-` as `_`. Deployment-wide:

```
OPENSESAME_CONNECTION_KEY        # 32-byte base64; credential encryption key
OPENSESAME_PUBLIC_URL            # base for building the callback redirect_uri
OPENSESAME_CONNECTION_REDIRECT_ALLOWLIST   # comma-separated post-consent return origins
```

Without `OPENSESAME_CONNECTION_KEY` the broker refuses to store credentials and every
provider reports `configured: false`, rather than storing tokens under a default key.

## Verification

`opensesame-mock-upstream-idp` speaks authorization-code + PKCE S256 + `refresh_token`, so
it backs the `mock` catalog provider and the full loop — create, authorize, callback,
exchange, refresh, revoke — is exercised end to end in `apps/gateway` integration tests
without reaching the network.
