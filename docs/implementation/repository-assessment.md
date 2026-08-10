# Repository Assessment — OpenSesame

**Date:** 2026-08-07  
**Assessor:** Integration lead (implementation run)  
**Repo state at assessment:** `ae185fa` — MIT LICENSE only

## What is already implemented?

Nothing beyond licensing. No packages, binaries, schemas, CI, deployments, or tests existed.

## Mapping to canonical resources

| Prompt resource | Existing code | Decision |
|-----------------|---------------|----------|
| Organization / Project / Environment | none | Introduce in `crates/domain` + migrations |
| Principal / Actor / ActorInstance | none | Introduce opaque typed IDs |
| Grant / Intent / Invocation / Receipt | none | Canonical IR in `crates/domain` |
| Connector / Connection | none | Manifest + WIT + host in `wit/`, `crates/connector-host` |
| Human E2EE vault | none | `crates/human-vault` + `packages/client-crypto` |
| Authority plane | none | OpenBao provider adapter |
| AuthZ | none | OpenFGA + AuthZEN adapter |
| Mesh | none | `MeshProvider` + Tailscale/static-mTLS adapters |

## Dependencies retained

None pre-existing. Greenfield defaults from the implementation prompt apply.

## Experimental / dead / duplicated / unsafe

N/A — empty tree.

## Public interfaces that must remain compatible

None. First public surface is `opensesame` CLI + `/api/v1` OpenAPI + WIT `opensesame:connector@1.0.0`.

## Data migrations required

Initial schema only (`migrations/0001_init.sql` and following). No legacy data.

## Smallest coherent change set

1. Domain + contracts + migrations  
2. Gateway (protected resource) + CLI (device/loopback login)  
3. AuthZ (OpenFGA model + PEP)  
4. Broker (intent → invocation → receipt)  
5. WASM connector host + mock connector  
6. Human-vault envelope + client crypto  
7. Local Compose profile + docs/security/ADR/REUSE  
8. Validation suite + evidence  

## Divergence from greenfield reference

| Area | Choice | Why |
|------|--------|-----|
| Product name | **OpenSesame** (not vault/Vault Fabric) | Repository name and LICENSE ownership |
| CLI binary | `opensesame` | Matches product |
| WIT package | `opensesame:connector@1.0.0` | Avoid generic "vault" branding |
| Local DB | SQLite behind same repository traits | Docker unavailable in this agent environment; PostgreSQL remains production default |
| HA validation | Compose manifests + documented failure drills; live three-node drill skipped without Docker | Honest availability reporting |
| Web console auth | Bundled Keycloak / external OIDC (not Clerk) | Self-hostable private fabric requirement overrides Vercel Marketplace auth defaults |

## Ownership map

| Area | Package / path |
|------|----------------|
| Domain IR | `crates/domain` |
| OpenAPI / JSON Schema / events | `api/` |
| Persistence | `crates/storage`, `migrations/` |
| AuthN / device flow | `crates/authn`, `apps/cli` |
| AuthZ / OpenFGA / AuthZEN | `crates/authz`, `policy/` |
| Broker | `crates/broker`, `apps/gateway`, `apps/worker` |
| Claims | `crates/claims` |
| Human vault | `crates/human-vault`, `packages/client-crypto`, `apps/browser-extension` |
| Connectors | `wit/`, `crates/connector-host`, `connectors/` |
| Rotation / PKI | `crates/rotation`, `crates/provider-openbao` |
| Mesh / edge | `crates/provider-static-mesh`, `apps/callback-edge` |
| Deploy | `deploy/` |
| Docs / validation | `docs/` |
