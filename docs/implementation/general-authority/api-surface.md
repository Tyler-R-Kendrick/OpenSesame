# General authority — Host API surface

HTTP routes that write and read the Host `access_domains` / `grant_offers`
tables (ADR 0120). Storage: [`storage.md`](storage.md). Capability ids:
`authority.domain.*` in `packages/capability-registry`.

## Auth

Operator bearer/header **or** an owner/admin session. The path
`{organization}` must equal the caller's realm (`X-OpenSesame-Organization`
for operators; the session's organization for humans). A mismatch returns
`404 not_found` (fail closed). Members receive `403`.

The access-domain and offer routes write no OpenFGA tuples. Projection
dirty/applied helpers in `crates/storage/src/authority/projection.rs` are for
projectors; domain mutations already emit outbox events from the storage
transaction. The grant-issue route is the exception: once the issue commits, and
only when an OpenFGA client is configured, it projects the grant's tuples
(`project_grant_live`, `crates/gateway/src/openfga_project.rs`); a failed
projection is logged and leaves the projection unmarked.

Issuing authority that names `credential.export` or `policy.edit`, or sets
`raw_credential_export`, needs the realm owner or the operator; an admin
receives `403`. `delegation_depth_remaining` must be 0 to 2.

## Routes

| Method | Path | Storage |
|---|---|---|
| `GET` | `/api/v1/organizations/{organization}/access-domains` | `list_access_domains` |
| `POST` | `/api/v1/organizations/{organization}/access-domains` | `create_access_domain` |
| `GET` | `/api/v1/organizations/{organization}/access-domains/{id}` | `access_domain` |
| `POST` | `/api/v1/organizations/{organization}/access-domains/{id}/reparent` | `reparent_access_domain` |
| `POST` | `/api/v1/organizations/{organization}/access-domains/{id}/terminate` | `terminate_access_domain` |
| `POST` | `/api/v1/organizations/{organization}/grants/{grant_id}/authority` | `issue_authority` |
| `POST` | `/api/v1/organizations/{organization}/grant-offers/{id}/activate` | `activate_grant_offer` |
| `POST` | `/api/v1/organizations/{organization}/grant-offers/{id}/revoke` | `revoke_grant_offer` |

Create body: optional `id` (generated `adom:…` when omitted), optional
`parent_id`, optional `project_id` (INV-COMPAT with ADR 0038 projects — a
domain may name a project in the same realm; it never becomes a second
membership model).

Reparent / terminate require `expected_revision` (CAS). Cross-realm parents
are unwritable at the schema FK and return `422 refused`.

## OpenAPI / client gaps

- Documented in `spec/openapi/host-api.yaml` (Host OpenAPI).
- `packages/api-client` does **not** yet generate typed methods for these
  paths — add when a consumer needs them.
- Offer **create** / list / get are storage-ready (`create_grant_offer`) but
  not exposed on Host HTTP yet; activate/revoke assume an offer already
  exists.
- Grant **issue** (`issue_authority`) is exposed as `POST .../grants/{grant_id}/authority`
  for an existing `grants` envelope; it does not insert the legacy grant row.
