# Access domains: a realm-bound forest

An `AccessDomain` is a named place authority lives — the thing an operator
points at when they say "everything under Platform › Production". Domains nest,
so a realm holds a **forest**: several roots, each a tree, every node with at
most one parent.

Implemented in `crates/domain/src/access_domain/` (host plane) and
`packages/os-domain/src/access-domain/` (client plane). Both are pure: no clock,
no I/O, no storage.

## The realm is the boundary

A `Realm` is the org/project pair [ADR 0038](../adr/0038-project-hierarchy-sharing.md)
already established, plus the project's kind. A forest is created *for* a realm
and refuses any node belonging to another one. There is no operation — not
insert, not reparent — that moves a domain from one project into another.

That refusal is what keeps two earlier decisions true:

- **Vault project crypto binding.** `crates/human-vault` seals a `project_id`
  into every envelope's AEAD associated data. A domain carrying a `VaultBinding`
  into a different project would name ciphertext whose associated data no longer
  matches. Since a binding takes its project from the realm, and the realm
  cannot change, the binding cannot drift.
- **Personal projects do not share.** ADR 0038's personal project refuses
  membership. A personal realm admits control for at most one principal, so
  nesting domains inside one organizes a single person's estate and never
  becomes a second, quieter sharing model.

## Invariants

| # | Invariant | Where it is enforced |
|---|-----------|----------------------|
| 1 | A node's realm equals its forest's realm | `Realm::assert_same_boundary` at every insert |
| 2 | One parent, no cycles | insert (fresh id under an existing parent cannot close a cycle); `reparent` refuses a new parent inside the moved subtree |
| 3 | Depth ≤ `MAX_DOMAIN_DEPTH` (8) | insert; `reparent` counts the moved subtree's whole height |
| 4 | Sibling slugs unique; slug is `[a-z0-9-]`, no leading/trailing hyphen | `assert_slug`, `assert_slug_free` |
| 5 | Nothing permanent hangs under something temporary | `DomainLifetime::assert_within` |
| 6 | A child never outlives its parent | same |
| 7 | A temporary lifetime is positive and ≤ 30 days | `assert_well_formed` |
| 8 | A live child under an expired ancestor is unreachable | `assert_reachable` |
| 9 | A vault binding's project is the realm's | `VaultBinding::assert_matches_realm` |
| 10 | Control inherits down only, stops at an `isolated` domain | `ControlIndex::effective_control` |
| 11 | Delegation never widens | `ControlIndex::insert_delegated` |
| 12 | A personal realm holds one controlling principal | `ControlIndex::insert` |

Acyclicity is property-tested over generated forests and generated move
sequences (`access_domain/proptests.rs`,
`__tests__/access-domain-properties.test.ts`), including the case where a cyclic
forest arrives by deserialization: the reads report it rather than looping.

## Notes for STORAGE (DDL)

These are the constraints the schema can carry, so a row that violates an
invariant cannot be written even by a path that skips the domain model. Nothing
here is implemented yet — this section is the handoff.

### `access_domains`

```sql
CREATE TABLE access_domains (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL,
  organization_id   TEXT NULL,
  project_kind      TEXT NOT NULL CHECK (project_kind IN ('personal','standard','temporary')),
  parent_id         TEXT NULL,
  slug              TEXT NOT NULL,
  display_name      TEXT NOT NULL,
  inheritance       TEXT NOT NULL CHECK (inheritance IN ('inherit','isolated')),
  lifetime_kind     TEXT NOT NULL CHECK (lifetime_kind IN ('permanent','temporary')),
  expires_at        TEXT NULL,
  vault_id          TEXT NULL,
  vault_project_id  TEXT NULL,
  created_at        TEXT NOT NULL,

  -- Invariant 1, in the schema: a parent must be in the same project. The
  -- composite foreign key is what makes cross-realm parentage unwritable,
  -- rather than merely refused upstream.
  UNIQUE (id, project_id),
  FOREIGN KEY (parent_id, project_id)
    REFERENCES access_domains (id, project_id) ON DELETE RESTRICT,

  -- Invariant 2, the one-hop case.
  CHECK (parent_id IS NULL OR parent_id <> id),

  -- Invariants 5-7: a deadline exists exactly when the lifetime is temporary.
  CHECK ((lifetime_kind = 'temporary') = (expires_at IS NOT NULL)),

  -- Invariant 9: a binding is whole, and its project is this row's project.
  CHECK ((vault_id IS NULL) = (vault_project_id IS NULL)),
  CHECK (vault_project_id IS NULL OR vault_project_id = project_id),
  FOREIGN KEY (vault_id, vault_project_id) REFERENCES vaults (id, project_id)
);
```

Sibling uniqueness (invariant 4) needs **two** indexes, because a `UNIQUE`
constraint treats `NULL`s as distinct in both SQLite and Postgres — one
constraint over `(project_id, parent_id, slug)` would let two roots share a
slug:

```sql
CREATE UNIQUE INDEX access_domains_sibling_slug
  ON access_domains (project_id, parent_id, slug) WHERE parent_id IS NOT NULL;
CREATE UNIQUE INDEX access_domains_root_slug
  ON access_domains (project_id, slug) WHERE parent_id IS NULL;
```

Supporting indexes:

```sql
CREATE INDEX access_domains_children ON access_domains (project_id, parent_id);
CREATE INDEX access_domains_due
  ON access_domains (expires_at) WHERE expires_at IS NOT NULL;
```

### What the schema cannot enforce

- **Acyclicity beyond one hop, and the depth cap.** SQL has no constraint for
  either. Both are write-path obligations, and both want an integrity check that
  can be run against a live database — a recursive CTE over `parent_id` that
  reports any row whose walk revisits a node or exceeds 8 levels. Worth wiring
  into the same place other invariant checks run, because a cycle in this table
  is a hang in every reader that does not carry its own visited set.
- **Concurrent reparenting.** Two legal moves can compose into a cycle: `A`
  under `B` and `B` under `A` each pass their own subtree check against the
  state they read. Reparent must therefore be **serialized per project** — the
  same per-project transaction/lock pattern project membership mutations already
  use (ADR 0038 §7) — not merely wrapped in a transaction at the default
  isolation level.
- **Personal-realm single-principal (invariant 12).** It spans rows in
  `access_domain_controls` scoped by the domain's project, so it is either a
  trigger or a write-path check. The write path already does it; a trigger would
  make it defence in depth.
- **Removal order.** `ON DELETE RESTRICT` above is deliberate: the domain model
  removes a subtree deepest-first so the table is a valid forest after every
  single statement. A `CASCADE` would let a partial failure orphan children, and
  an orphan is the one shape every read here refuses to interpret.

### `access_domain_controls`

```sql
CREATE TABLE access_domain_controls (
  id           TEXT PRIMARY KEY,
  domain_id    TEXT NOT NULL REFERENCES access_domains (id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('member','admin','owner')),
  scope        TEXT NOT NULL CHECK (scope IN ('domain_only','subtree')),
  granted_at   TEXT NOT NULL,

  -- One assignment per principal per domain: a second row would make
  -- "what does this principal hold here" ambiguous, and revocation
  -- would withdraw whichever row was found first.
  UNIQUE (domain_id, principal_id)
);

CREATE INDEX access_domain_controls_principal
  ON access_domain_controls (principal_id);
```

`ON DELETE CASCADE` is right here and wrong on `access_domains.parent_id`: an
assignment has no meaning once its domain is gone, whereas a child domain very
much still exists.

### Lifecycle and events

`expires_at` is the column the lifecycle scanner reads
([ADR 0074](../adr/0074-expiry-lifecycle-hooks.md)). Access domains need an
`ExpirySubject` kind of their own so an expiring domain publishes on the
`lifecycle.*` feed like every other deadline, rather than growing a private
due-check. `AccessDomainForest::deadlines()` is the pure side of that: ids and
timestamps, sorted, nothing that could carry a value.

The wire strings in the `CHECK` constraints above are the frozen ones asserted
on both planes (`DOMAIN_*_WIRE` in `access_domain/bridge.rs` and
`access-domain/bridge.ts`). They are stored as-is; no lookup table.
