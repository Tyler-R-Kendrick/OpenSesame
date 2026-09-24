-- Generalized, hierarchical authority: the persistence half.
--
-- Five things are true about every table below, and they are the reason the
-- shape is what it is.
--
-- 1. A realm (`organization_id`) is a hard boundary, so it is a *column in every
--    key*, not a filter a service is trusted to remember. Every child table
--    references its parent by `(id, organization_id)`, so a row that names a
--    parent in another realm cannot be written even by a caller that forgot the
--    join predicate. `access_domains` references itself the same way: there is
--    no cross-realm reparenting to authorize because there is none to express.
--
-- 2. There is no second grant store. `grant_authority` is a sidecar keyed on the
--    existing `grants` row: the envelope in `grants.body_json` stays the grant,
--    and this table records what the generalized model adds — the domain it
--    lives in, its lineage, the digests that were reviewed, and the generations
--    it was issued against. A legacy grant simply has no sidecar, so it can
--    never satisfy a generalized dispatch by accident; `0033` widens nothing on
--    its own, and the backfill that fills sidecars in is deliberately separate
--    and refuses what it cannot reconstruct.
--
-- 3. Ancestor revocation is not this migration's mechanism. `grant_lineage` and
--    `grant_invalidations` (0033, ADR 0120) already fence a chain in one read,
--    and a second closure table beside them would be a second answer to the same
--    question. `fenced_authority` composes: it checks what those tables cannot
--    know — realm, domain, window, operational generation — and then asks the
--    0120 fence about the chain.
--
-- 4. Realm and domain revocation denies at a fence too. `authority_generations`
--    holds one monotonic counter per authority subject; a sidecar pins the
--    counters it was issued against. Revoking a realm, a domain or a root grant
--    is one UPDATE that bumps a counter, and every descendant stops passing the
--    fenced read in the same transaction — descendant cleanup and provider
--    revocation are reconciliation behind it, not the deny boundary.
--
-- 5. Budget capacity is conserved by the database. The inequality from the
--    specification is a table CHECK:
--        settled_usage + outstanding_reservations <= authorized_capacity
--    Reservation writes carry the guard in their WHERE clause so a loser sees a
--    clean zero-row deny rather than an error, and the CHECK stands behind them
--    so a future writer that forgets the guard fails instead of overselling a
--    root budget to two concurrent children.
--
-- 6. A restore must not resurrect authority. Every sidecar and every reservation
--    records the `operational_generation` it was written under. Recovery
--    advances that generation, and everything pinned to an older one stops
--    being usable without a row-by-row sweep. `database_identity` is minted here
--    by the database itself, so a restored file is recognisably a different
--    database from the one an outside witness recorded.

CREATE TABLE access_domains (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  parent_id TEXT,
  project_id TEXT REFERENCES projects(id),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'archived', 'terminated')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  depth INTEGER NOT NULL CHECK (depth >= 0 AND depth <= 32),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminated_at TEXT,
  UNIQUE (id, organization_id),
  FOREIGN KEY (parent_id, organization_id) REFERENCES access_domains(id, organization_id),
  CHECK (parent_id IS NULL OR parent_id <> id),
  CHECK ((lifecycle = 'terminated') = (terminated_at IS NOT NULL))
);

CREATE INDEX idx_access_domains_parent ON access_domains(organization_id, parent_id);

-- One counter per authority subject. `generation` only ever rises: a revoke, a
-- reparent, a domain termination and a recovery rotation all move it, and a
-- sidecar issued against an older value stops passing the fenced read.
CREATE TABLE authority_generations (
  organization_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN (
    'realm', 'domain', 'grant', 'cohort', 'session', 'principal'
  )),
  subject_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, subject_kind, subject_id)
);

CREATE TABLE grant_authority (
  grant_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  root_grant_id TEXT NOT NULL,
  parent_grant_id TEXT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  issuance_basis TEXT NOT NULL CHECK (issuance_basis IN (
    'root', 'delegation', 'offer_activation', 'recurrence'
  )),
  lineage_digest TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  role_revision INTEGER,
  offer_id TEXT,
  delegation_depth_remaining INTEGER NOT NULL CHECK (delegation_depth_remaining >= 0),
  not_before TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  realm_generation INTEGER NOT NULL CHECK (realm_generation > 0),
  domain_generation INTEGER NOT NULL CHECK (domain_generation > 0),
  operational_generation INTEGER NOT NULL CHECK (operational_generation > 0),
  evidence_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (grant_id, organization_id),
  FOREIGN KEY (grant_id) REFERENCES grants(id),
  FOREIGN KEY (domain_id, organization_id) REFERENCES access_domains(id, organization_id),
  CHECK (expires_at > not_before),
  CHECK (parent_grant_id IS NULL OR parent_grant_id <> grant_id),
  CHECK ((issuance_basis = 'root') = (parent_grant_id IS NULL)),
  CHECK ((issuance_basis = 'root') = (root_grant_id = grant_id)),
  CHECK ((issuance_basis = 'offer_activation') = (offer_id IS NOT NULL))
);

CREATE INDEX idx_grant_authority_root ON grant_authority(organization_id, root_grant_id);
CREATE INDEX idx_grant_authority_domain ON grant_authority(organization_id, domain_id);
CREATE INDEX idx_grant_authority_parent ON grant_authority(organization_id, parent_grant_id);

-- Rights are correlated entries, never two independent lists. `(read, A)` and
-- `(write, B)` are two rows, and nothing in the schema or the queries above them
-- can pair the action of one with the resource of the other.
CREATE TABLE grant_permission_entries (
  grant_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  resource_selector TEXT NOT NULL,
  provider_operation_id TEXT NOT NULL,
  action_set_json TEXT NOT NULL,
  parameter_constraints_json TEXT NOT NULL,
  audience_set_json TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  PRIMARY KEY (grant_id, seq),
  FOREIGN KEY (grant_id, organization_id) REFERENCES grant_authority(grant_id, organization_id)
);

CREATE INDEX idx_permission_entries_operation
  ON grant_permission_entries(organization_id, provider_operation_id);

-- An offer names a cohort; it is not a token that cohort can spend. Activation
-- writes one row here and one individually bound grant, and the pair of unique
-- keys is what stops a second activation for the same person or a retry from
-- minting a second grant.
CREATE TABLE grant_offers (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  cohort_id TEXT NOT NULL,
  cohort_revision INTEGER NOT NULL CHECK (cohort_revision > 0),
  membership_binding TEXT NOT NULL CHECK (membership_binding IN ('snapshot', 'live')),
  envelope_grant_id TEXT NOT NULL,
  max_activations INTEGER NOT NULL CHECK (max_activations > 0),
  activations INTEGER NOT NULL DEFAULT 0 CHECK (activations >= 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (id, organization_id),
  FOREIGN KEY (domain_id, organization_id) REFERENCES access_domains(id, organization_id),
  FOREIGN KEY (envelope_grant_id, organization_id)
    REFERENCES grant_authority(grant_id, organization_id),
  CHECK (activations <= max_activations)
);

CREATE TABLE grant_offer_activations (
  offer_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  beneficiary_principal_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  cohort_revision INTEGER NOT NULL,
  membership_source TEXT NOT NULL,
  membership_issuer TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (offer_id, beneficiary_principal_id),
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (offer_id, organization_id) REFERENCES grant_offers(id, organization_id),
  FOREIGN KEY (grant_id, organization_id)
    REFERENCES grant_authority(grant_id, organization_id)
);

CREATE TABLE authority_budgets (
  organization_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN (
    'root_grant', 'principal', 'domain', 'session', 'engagement', 'workcell'
  )),
  scope_id TEXT NOT NULL,
  unit TEXT NOT NULL,
  window_key TEXT NOT NULL,
  authorized_capacity INTEGER NOT NULL CHECK (authorized_capacity >= 0),
  allocated_child_capacity INTEGER NOT NULL DEFAULT 0 CHECK (allocated_child_capacity >= 0),
  settled_usage INTEGER NOT NULL DEFAULT 0 CHECK (settled_usage >= 0),
  outstanding_reservations INTEGER NOT NULL DEFAULT 0 CHECK (outstanding_reservations >= 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, scope_kind, scope_id, unit, window_key),
  CHECK (settled_usage + outstanding_reservations <= authorized_capacity),
  CHECK (allocated_child_capacity <= authorized_capacity)
);

CREATE TABLE authority_budget_reservations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  unit TEXT NOT NULL,
  window_key TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  settled_quantity INTEGER NOT NULL DEFAULT 0 CHECK (settled_quantity >= 0),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'settled', 'released', 'void')),
  idempotency_key TEXT NOT NULL,
  operational_generation INTEGER NOT NULL CHECK (operational_generation > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, idempotency_key),
  CHECK (settled_quantity <= quantity)
);

CREATE INDEX idx_budget_reservations_scope ON authority_budget_reservations(
  organization_id, scope_kind, scope_id, unit, window_key, state
);

-- Desired authorization and observed enforcement are different facts, so they
-- are different columns with their own generations. A provider observation that
-- arrives late carries an older `observed_generation` and cannot overwrite a
-- newer revoke.
CREATE TABLE authority_provider_effects (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  provider_kind TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  external_handle TEXT,
  desired_state TEXT NOT NULL CHECK (desired_state IN ('present', 'absent')),
  desired_generation INTEGER NOT NULL CHECK (desired_generation > 0),
  observed_state TEXT NOT NULL CHECK (observed_state IN (
    'not_applied', 'applying', 'observed_active', 'revoking',
    'observed_removed', 'failed', 'unknown'
  )),
  observed_generation INTEGER NOT NULL DEFAULT 0,
  observed_at TEXT,
  evidence_digest TEXT,
  idempotency_key TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (grant_id, organization_id)
    REFERENCES grant_authority(grant_id, organization_id),
  CHECK (observed_generation <= desired_generation)
);

CREATE TABLE authority_evidence (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  issuer TEXT NOT NULL,
  subject_principal_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  digest TEXT NOT NULL,
  UNIQUE (organization_id, kind, digest),
  CHECK (expires_at > observed_at)
);

-- A projection is never the ledger. It records how far it has caught up, and a
-- reactivation that requires a projected fact may only proceed once
-- `applied_revision` has reached the revision the authority committed.
CREATE TABLE authority_projections (
  store TEXT NOT NULL CHECK (store IN ('openfga', 'identity', 'pages_cache', 'nats')),
  organization_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  committed_revision INTEGER NOT NULL CHECK (committed_revision > 0),
  applied_revision INTEGER NOT NULL DEFAULT 0 CHECK (applied_revision >= 0),
  model_id TEXT,
  dirty_since TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (store, organization_id, subject_kind, subject_id),
  CHECK (applied_revision <= committed_revision)
);

-- Single-writer topology, stated rather than assumed. A writer takes the one
-- lease, gets a fence token, and every mutation it makes carries that token; a
-- writer whose lease was taken over is refused instead of racing.
CREATE TABLE authority_writer_lease (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  writer_id TEXT NOT NULL,
  fence_token INTEGER NOT NULL CHECK (fence_token > 0),
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE authority_operational_generation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL CHECK (generation > 0),
  database_identity TEXT NOT NULL,
  established_at TEXT NOT NULL,
  restored_at TEXT,
  recovery_note TEXT
);

INSERT INTO authority_operational_generation
  (id, generation, database_identity, established_at)
VALUES (1, 1, lower(hex(randomblob(16))), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));

-- The backfill is resumable, and its bookkeeping says so out loud: a cursor it
-- can restart from, a count of what it refused, and the timestamp of the backup
-- check it is not allowed to run without.
CREATE TABLE authority_backfill_progress (
  id TEXT PRIMARY KEY,
  cursor_id TEXT,
  processed INTEGER NOT NULL DEFAULT 0 CHECK (processed >= 0),
  quarantined INTEGER NOT NULL DEFAULT 0 CHECK (quarantined >= 0),
  backup_verified_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE authority_backfill_quarantine (
  grant_id TEXT PRIMARY KEY,
  organization_id TEXT,
  reason TEXT NOT NULL,
  observed_at TEXT NOT NULL
);

-- A client that predates correlated permission entries would read a generalized
-- grant as the old flat action/resource pair and write it back without the
-- constraints it never parsed. The floor lets that client be refused by name
-- instead of silently narrowing nothing.
CREATE TABLE authority_client_floor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  minimum_client_revision INTEGER NOT NULL CHECK (minimum_client_revision > 0),
  updated_at TEXT NOT NULL
);

INSERT INTO authority_client_floor (id, minimum_client_revision, updated_at)
VALUES (1, 1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));
