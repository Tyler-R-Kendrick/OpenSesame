# Connections experience

Competitive UX/DX/agent review for [Infisical App Connections](https://infisical.com/docs/integrations/app-connections/overview)
and [1Password Connect](https://www.1password.dev/connect). The provider list is
not the competition. The work is: make a connection easier to create, understand,
reuse, test, call, and revoke than either product.

Status: target design. This checkout already has a curated connection catalog,
provider pages, inline AI setup, connection refs and invocation. The gaps below
are the experience contract, not a claim of implementation.

## What exists today

- Curated catalog with one searchable tagged list, not a provider directory
  clone (`catalog-selection.ts`, `CatalogPanel.tsx`).
- Provider pages with method-specific forms, OAuth, API key, configuration and
  managed connectors.
- Inline model-provider setup as a sheet over the catalog, preserving the
  catalog context (`ai/use-ai-sheet.ts`).
- Connection status, provider connection list, reload, failures in the tray,
  vault-remember offer, and connection callbacks.
- ConnectionRef authority: an agent names a connection, never a secret
  (`ConnectionRef`, ADR 0005).
- Host invocation with max invoke level, bindings, egress, scopes, status and
  expiry (`packages/api-client` `invoke`, `Connection` model).
- Native connectors, key drivers, MCP, API-key connections, GitHub App, local
  git remotes, secret backends and 1Password Connect/SDK already exist.
- 1Password Connect is supported as a **secret backend** (read/write through
  the Connect API), not as a product API we expose.

## What Infisical does well

- One App Connections concept is reused by syncs, rotation, scanning and
  dynamic secrets.
- Organization vs project scope is explained; the UI warns that creating from
  a setup form makes a project connection and can duplicate credentials.
- A connection can be created from the feature form without losing progress.
- OAuth connections are UI-only; API creation is for non-OAuth methods.
- Connection IDs are the API handle; the UI uses the same dropdown.
- Some connections support platform-managed credentials.

## What 1Password Connect does well

- A self-hosted Connect server with its own API inside the customer network.
- Credentials file + multiple access tokens.
- Tokens are scoped to selected vaults, capped at 100, with 30/90/180-day
  expiry, rename and revoke.
- REST API: list/get vaults, list/add/get/replace/delete items, RFC 6902 patch,
  list/get files, file content, activity, health, metrics.
- Official SDKs (Go, JS, Python), CLI environment variables (`OP_CONNECT_HOST`,
  `OP_CONNECT_TOKEN`) and CI/Kubernetes integrations.
- Local cache allows unlimited re-requests after the first fetch; item usage
  reports.
- A separate management plane controls groups, environments and vault access.

## Where we should be simpler

### One Add flow, entered from the task

Do not make the catalog the only front door.

```text
What do you want to do?
  Use a provider from an agent
  Sync a vault / backup
  Back a secret store
  Connect an AI model
  Call an API from this device
        |
        v
Search providers / choose a task
        |
        v
Scope: This device | This project | This organization
        |
        v
Method: OAuth | API key | Basic | Configuration | Managed
        |
        v
Paste/authorize -> Verify -> Preview capabilities -> Save
```

- The task says which scope is recommended. "This project" is not the silent
  default when an organization-wide credential already exists.
- Creating from an AI sheet, backup, secret backend or agent page opens the same
  form and returns to the exact prior screen.
- The form is state-preserving across OAuth, tab focus, reload and a failed
  verification.

### Reuse before create

Before saving, fingerprint the credential and compare within the visible scope.

- Exact duplicate: "This is already connected as <name>; use it?" with one key.
- Same provider/account, different credential: warning with last used and
  owner; offer "use existing" or "create separate".
- Same provider, same scopes, different name: warn but allow.
- The warning never reveals a secret, only a keyed fingerprint and metadata.
- An organization connection is preferred over a duplicate project credential
  when the actor has access.

### A connection detail that answers the four questions

Every connection page shows:

1. **What is it?** Provider, method, scope, owner, status.
2. **What can it do?** Capabilities/operations, scopes, egress hosts, max invoke
   level, expiry.
3. **What uses it?** Used by list across agents, tasks, syncs, backups, vault
   items and features; last used; recent failures.
4. **What do I do now?** Test, rotate, reauthorize, share, revoke, or open the
   agent invocation.

Add a **Connection doctor**:

- Verify credential with the provider.
- Check required scopes and egress.
- Show the exact failing operation and the provider response class, never the
  token.
- Offer one action per failure: reauthorize, add scope, choose another method,
  or repair configuration.

### Verification before save

Current forms can save first and fail later. The target verifies before save
when the provider allows it:

- OAuth: token exchange + a cheap identity/read call.
- API key: a provider-specific probe if the provider exposes one; otherwise a
  declared "unverified" state, never a false success.
- Basic/config: a read-only operation.
- Managed: the Host reports capability.

The result is one of `verified`, `declared-unverified`, `unsupported`. The UI
never paints a green check for "saved".

## Developer experience

### One typed invocation surface

```ts
const result = await connections.invoke({
  ref: "conn://acme/github/main",
  operation: "issues.create",
  input: { owner, repo, title, body },
  idempotencyKey,
});
```

- Generated operations per provider from the catalog, not raw URLs in agent
  code.
- Typed errors: `needs_reauth`, `policy_denied`, `egress_denied`,
  `rate_limited`, `provider_error`, `unsupported_operation`.
- Each error carries a safe hint and the next action.
- `connections.describe(ref)` returns capabilities, scopes, egress and
  operations; `connections.test(ref)` returns a readiness verdict.
- OpenAPI and SDKs: TypeScript, Go and Python. CLI mirrors the same calls.
- Local emulator/fixture server for tests; no live provider required.
- Stable connectionRef; provider credentials rotate behind it.

### CLI

```bash
opensesame connect list --json
opensesame connect inspect conn://acme/github/main
opensesame connect test conn://acme/github/main
opensesame connect invoke conn://acme/github/main issues.create --input issue.json
```

No `--token` flag. Secrets stay in the Host/device store. The CLI prints the
receipt id, not the credential.

### Code you can paste

Every operation page shows a copyable invocation for TS, Go, Python, cURL and
MCP. The snippet uses the connectionRef and operation id, never a secret. The
same page shows the exact scope/egress needed.

## Agent experience

Agents should discover and use connections without a secret and without
learning a provider API by trial and error.

- **Discovery**: MCP/agent tools `connections.search`, `connections.describe`,
  `connections.test`, `connections.invoke`. Search by task ("open a pull
  request") and capability, not only provider name.
- **Dry run**: `connections.invoke(..., { dryRun: true })` returns the policy
  decision, egress host, method/path, and required scopes without executing.
- **Approval**: a connection outside the agent's standing grant raises one
  approval with the operation, scope and expiry; never a secret reveal.
- **Receipt**: every invocation returns a receipt id and a redacted outcome.
  The agent can retry idempotently with the same key.
- **Refusal**: a denied operation says which policy, scope or egress rule
  refused it and what to ask the operator for.
- **No raw credentials**: the agent gets a ConnectionRef, never an access token.
  A connection that cannot be invoked through the broker is not exposed to the
  agent at all.
- **Test as agent**: from the connection page, run one operation under the
  selected agent's grant and show the decision plus receipt. This is the
  counterpart to assume privilege, without impersonating the agent.

## 1Password Connect capability parity

1Password Connect is a self-hosted API. The equivalent OpenSesame surface is a
native daemon/CLI role, not a PWA page.

| 1Password Connect capability | OpenSesame target |
|---|---|
| Self-hosted Connect server | Native `opensesame connect serve` on a host/network the operator controls |
| `1password-credentials.json` | Sealed enrollment bundle; no plaintext standing file |
| Multiple access tokens | Multiple service tokens, each sealed as a hash and shown once |
| Token scoped to vaults | Token scoped to explicit vault/collection IDs and read/write operations |
| 100-vault cap | Configurable cap; default 100 for compatibility |
| 30/90/180-day expiry | Presets plus a custom bounded TTL; expiry revokes the token |
| Rename / revoke | Rename and revoke; no edit of scope after issue (revoke + reissue) |
| `GET /v1/vaults` | List only vaults the token may read; no existence leak |
| `GET /v1/vaults/:id` | Vault metadata, no item values |
| Item list/add/get/replace/delete | Same operations over a vault the token may write |
| RFC 6902 PATCH | Supported subset: item attributes and declared fields only |
| Files list/get/content | Attachment metadata and bounded content, with size caps |
| `GET /v1/activity` | Redacted activity: token id, operation, result, resource; never values |
| `/heartbeat`, `/health`, `/metrics` | Same operational endpoints; health reports sealed-store/sync state |
| Go/JS/Python SDKs | OpenSesame SDKs over the same endpoint, plus a compatibility client where the shapes map |
| `OP_CONNECT_HOST` / `OP_CONNECT_TOKEN` | `OPENSESAME_CONNECT_HOST` / `OPENSESAME_CONNECT_TOKEN`, with an explicit 1Password-compat mode only if we ship the exact API |
| Local cache / unlimited re-requests | Native daemon reads the sealed store locally; re-requests have no provider quota |
| Item usage reports | Local sealed activity, optional export; no cloud dependency |

The compatibility claim must be **exact** if we use 1Password's paths: same
paths, status codes, field names and error envelope for the supported subset.
Anything outside the subset returns a typed `unsupported` error. We do not
advertise a Connect-compatible API while silently returning a different shape.

### Connect API auth and scope

- Token format: opaque `oc_…`, shown once, stored as a digest.
- Token creation requires a scope selection and TTL; no "all vaults" default.
- Token is bound to the native daemon enrollment and cannot be used against a
  different instance.
- Revocation is immediate; no poll interval.
- Token cannot reveal item values it was not scoped to; list endpoints filter
  before serialization.
- Every read/write writes a redacted activity row with token id, actor (none for
  service token), resource and result.

## Native versus PWA

| Capability | Native | PWA |
|---|---|---|
| Connection catalog and setup | Yes | Yes |
| OAuth / API key / basic forms | Yes | Yes |
| Connection tests and doctor | Yes | Yes |
| ConnectionRef invocation | Yes | Through Host only |
| `connect serve` / Connect-compatible API | Yes | No; static hosting has no listener |
| Service tokens and vault-scoped API | Yes | Management UI, no server |
| Agent MCP discovery | Yes, local | Yes, Host-backed |
| Local-only credentials | Yes, sealed store | Yes, sealed vault |
| Unmodified SDK/CLI access | Yes | No; browser origin and CORS apply |

The PWA must not fake a local Connect server or a system API. It can manage
tokens and show connection health; the native daemon serves the API.

## Delivery slices

1. **Add flow.** Task-first entry, scope selector, reusable inline form, back to
   origin with state intact.
2. **Reuse and verification.** Credential fingerprint, duplicate warnings,
   verify-before-save, unverified state.
3. **Connection detail and doctor.** Used-by graph, capabilities, tests, rotate,
   reauthorize, revoke, last used.
4. **DX surface.** `describe`/`test`/`invoke`, idempotency keys, typed errors,
   OpenAPI, TS/Go/Python snippets.
5. **Agent surface.** MCP search/describe/test/invoke, dry run, approval,
   receipt, refusal reason, test-as-agent.
6. **Connect-compatible daemon.** Vault/item/file/activity/health/metrics
   endpoints, service tokens, scope/TTL/revoke/rename.
7. **Compatibility client and SDKs.** Exact path/field compatibility for the
   supported subset; conformance suite against 1Password's public API shapes.

## Acceptance

- A person can create a connection from an AI, backup, secret-backend or agent
  task and return to the exact prior screen with no lost input.
- A duplicate credential is detected and can be reused in one action; the UI
  never shows the secret in the warning.
- A saved connection is `verified`, `declared-unverified` or `unsupported`; no
  false green state.
- A connection detail answers what it is, what it can do, what uses it, and what
  to do next.
- An agent can search by task, describe capabilities, dry-run, invoke, receive a
  receipt and understand a refusal without seeing a secret.
- A native daemon passes the supported 1Password Connect conformance cases:
  list/get vaults, item CRUD, patch, files, activity, health, metrics, token
  expiry/revoke/rename and vault scoping.
- An out-of-scope token cannot list or read another vault, and no error reveals
  whether it exists.
- Revocation takes effect on the next request, not after a poll interval.
- The PWA contains no listener, service token server, `OP_CONNECT_*`
  compatibility claim or native secret.
