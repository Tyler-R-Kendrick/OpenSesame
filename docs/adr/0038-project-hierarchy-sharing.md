# ADR 0038: Projects as the top-level hierarchy, with a personal default and optional sharing

## Status

Accepted

## Context

`Project` already existed in the identity plane (os-domain, Drizzle schema,
OpenFGA model, Rust `ProjectId`) but only as a claims-flow artifact: the sole
API was `POST /v1/projects/temporary`, there was no membership model, and the
client plane (`apps/pages`, sync, sealed stores) had no project concept at
all — one vault, one consent list, all under fixed global keys. Meanwhile
`crates/human-vault` already binds a `project_id` into every envelope's AEAD
associated data and `policy/openfga/model.fga` already hangs
`vault_collection`, `connection`, and `environment` off `project`.

Users need a top-level grouping: vaults, agents, sites and other resources
should all belong to a project, with a per-user default, the ability to swap
between projects, and the option to share a project with other principals.

## Decision

1. **Projects are the top-level container.** Vaults, agents, sites and other
   resources belong to exactly one project. Organizations remain an optional
   tier above (`Project.organizationId`), but nothing requires one.
2. **Project kinds.** `personal` — auto-provisioned default, one per
   principal (partial unique index), never shareable or deletable;
   `standard` — user-created, optionally shareable; `temporary` — TTL-bound,
   minted through the claims flow (unchanged behavior, now labeled).
3. **Personal default.** The Identity API lazily provisions the personal
   project on first touch (`ensurePersonalProject`), so existing principals
   pick one up too. It never spends quota.
4. **Swappable.** Each principal has an active project
   (`GET/PUT /v1/projects/active`); new resources (e.g. agent registration)
   land in the active project unless the request names one. A vanished
   active selection falls back to personal rather than failing.
5. **Optionally shareable.** `project_memberships`
   (owner/admin/member, mirroring organization memberships) with
   `/v1/projects/:id/members` CRUD. Owner/admin manage members; only owners
   touch the owner role; the last owner can neither be demoted nor removed;
   members may leave. Personal projects refuse membership entirely.
6. **Client plane.** `apps/pages` gains a local project registry
   (`projects.v1`) and a project switcher. Per-project state (vault header,
   body, attempts, prefs, site consents, broker policy) is stored under
   project-scoped KV keys; the personal project keeps the legacy un-prefixed
   keys so existing vaults stay readable without migration. Swapping reloads
   the app so no unlocked key survives the transition. Deleting a local
   project deletes its sealed blobs.
7. **Authorization.** `project.create` is policy-gated (denied to
   provisional principals, quota-bound via `maxProjects` for verified ones);
   temporary-project quota is unchanged. Membership mutations are serialized
   per project and audited (`project.created`, `project.switched`,
   `project.member_added`, `project.member_role_changed`,
   `project.member_removed`, `project.deleted`).

## Consequences

- The always-present personal project gives every surface a default scope,
  so "no project" states disappear without breaking membership-less
  temporary projects (their creator still resolves as owner).
- Client-side sharing of a *local* pages project requires linking it to a
  server project; the linkage (and populating `human-vault`'s
  `project_id` AEAD field with real project ids, per-project sync
  namespaces, and OpenFGA `vault_collection` tuple writers) is follow-up
  work with modelled-but-unwired seams already in place.
- Host-plane session revocation on project membership changes does not
  exist yet (organizations have it); project role changes take effect on
  the identity plane immediately but do not revoke Host sessions.
