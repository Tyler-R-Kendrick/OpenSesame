# Audit tick 35 — OAuth client registrations had no owner

Date: 2026-08-08
Scope: `apps/control-plane/src/routes/oauth-clients.ts`, `packages/contracts`,
`packages/os-domain`, `packages/database`

## Scanners

| Check | Result |
|-------|--------|
| osv-scanner | CLEAN |
| gitleaks (working tree) | CLEAN |
| cargo-deny | ok |
| clippy `--workspace --all-targets --all-features` | CLEAN |
| Residual review | oauth client routes had no ownership check; redirect URI validation accepted dangerous schemes |

## Findings fixed

### 1. Any verified principal could take over any OAuth client (high)

`OAuthClientRecord` carried no owner at all, and the routes looked clients up by
id alone. Every sibling resource in this app already scopes by owner
(`organizations` filters on `createdBy`, projects/agents carry
`ownerPrincipalId`) — OAuth clients were the outlier. Consequences for any
authenticated principal:

- `GET /v1/oauth/clients` listed **every** client in the deployment.
- `PATCH /v1/oauth/clients/{id}` could repoint another client's `redirectUris`
  at an attacker-controlled host — authorization-code interception, i.e. account
  takeover of that client's users — and rewrite its `allowedScopes` /
  `allowedResources`.
- `POST /{id}/rotate` and `POST /{id}/revoke` could break any client at will.

Additionally the `assurance !== "provisional"` gate existed only on create, so a
provisional principal could still mutate clients.

Fix: `ownerPrincipalId` is now part of the record (domain type, response
contract, and the `oauth_clients` table via migration `0001`), stamped on create.
Reads and mutations go through `loadOwnedClient`, which answers 404 for foreign
or unknown ids alike so the route is not an existence oracle. `assertVerified`
now guards patch/rotate/revoke as well as create.

### 2. `redirectUris` accepted `javascript:`, `data:` and `file:` URLs (high)

`z.string().url()` only checks that `new URL()` parses, which admits
`javascript:alert(1)`, `data:text/html,…`, `file:///etc/passwd`, URLs with
fragments, and URLs with embedded credentials — verified against the installed
zod. A registered `javascript:` redirect URI turns the authorization redirect
into script execution in the authorization server's own redirect context.

Fix: `RedirectUriSchema` / `isAllowedRedirectUri` accept only https, http on
loopback (RFC 8252 native-app development), and reverse-DNS private-use schemes
(`com.example.app:/cb`), and reject fragments (RFC 6749 §3.1.2) and embedded
credentials. Applied to both create and patch.

## Verification

- `pnpm --filter @opensesame/control-plane test` — new test proves a second
  principal cannot list, repoint, rotate or revoke another's client, that the
  owner still can, and that `javascript:` is refused with 400.
- `pnpm --filter @opensesame/contracts test` — scheme allow/deny table.
- `pnpm run test:all` green across 22 packages; `pnpm run build` 14/14.
- `pnpm --filter @opensesame/database db:generate` → `0001_yielding_wildside.sql`
  (nullable column + FK + index; no backfill needed since the control plane
  keeps clients in memory today).
