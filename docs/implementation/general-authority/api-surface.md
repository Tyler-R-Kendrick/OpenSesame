# General authority — Host API surface

HTTP routes that write and read the Host `access_domains` / `grant_offers`
tables (ADR 0120). Storage: [`storage.md`](storage.md). Capability ids:
`authority.domain.*` in `packages/capability-registry`.

## Auth

Operator bearer/header **or** an owner/admin session. The path
`{organization}` must equal the caller's realm (`X-OpenSesame-Organization`
for operators; the session's organization for humans). A mismatch returns
`404 not_found` (fail closed). Members receive `403`.

No OpenFGA tuple writes on these routes. Projection dirty/applied helpers in
`crates/storage/src/authority/projection.rs` are for projectors; domain
mutations already emit outbox events from the storage transaction.

## Routes

| Method | Path | Storage |
|---|---|---|
| `GET` | `/api/v1/organizations/{organization}/access-domains` | `list_access_domains` |
| `POST` | `/api/v1/organizations/{organization}/access-domains` | `create_access_domain` |
| `GET` | `/api/v1/organizations/{organization}/access-domains/{id}` | `access_domain` |
| `POST` | `/api/v1/organizations/{organization}/access-domains/{id}/reparent` | `reparent_access_domain` |
| `POST` | `/api/v1/organizations/{organization}/access-domains/{id}/terminate` | `terminate_access_domain` |
| `POST` | `/api/v1/organizations/{organization}/grant-offers/{id}/activate` | `activate_grant_offer` |
| `POST` | `/api/v1/organizations/{organization}/grant-offers/{id}/revoke` | `revoke_grant_offer` |

Create body: optional `id` (generated `adom:…` when omitted), optional
`parent_id`, optional `project_id` (INV-COMPAT with ADR 0038 projects — a
domain may name a project in the same realm; it never becomes a second
membership model).

Reparent / terminate require `expected_revision` (CAS). Cross-realm parents
are unwritable at the schema FK and return `422 refused`.

## OpenAPI / client gaps

- Documented in `api/openapi/openapi.yaml` (Host OpenAPI).
- `packages/api-client` does **not** yet generate typed methods for these
  paths — add when a consumer needs them.
- Offer **create** / list / get are storage-ready (`create_grant_offer`) but
  not exposed on Host HTTP yet; activate/revoke assume an offer already
  exists.
- Grant **issue** (`issue_authority`) remains a storage/API follow-up; these
  routes do not mint grants.
