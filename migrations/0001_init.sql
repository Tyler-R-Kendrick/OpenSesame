-- OpenSesame initial control-plane schema (SQLite/Postgres compatible subset)
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(organization_id, name)
);

CREATE TABLE IF NOT EXISTS environments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, name)
);

CREATE TABLE IF NOT EXISTS principals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS external_identities (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  evidence_digest TEXT NOT NULL,
  UNIQUE(issuer, subject)
);

CREATE TABLE IF NOT EXISTS actors (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS actor_instances (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES actors(id),
  public_key_jwk TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT REFERENCES projects(id),
  connector_id TEXT NOT NULL,
  connector_version TEXT NOT NULL,
  component_digest TEXT NOT NULL,
  display_name TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  body_json TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS claim_sessions (
  id TEXT PRIMARY KEY,
  body_json TEXT NOT NULL,
  claim_token_hash TEXT NOT NULL UNIQUE,
  user_code_hash TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS intents (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  body_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(organization_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS invocations (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES intents(id),
  state TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  body_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  invocation_id TEXT NOT NULL REFERENCES invocations(id),
  body_json TEXT NOT NULL,
  signature TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT
);

CREATE TABLE IF NOT EXISTS vaults (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT REFERENCES projects(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS encrypted_item_revisions (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL REFERENCES vaults(id),
  item_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  envelope_version INTEGER NOT NULL,
  ciphertext BLOB NOT NULL,
  wrapping_json TEXT NOT NULL,
  ad_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(vault_id, item_id, revision)
);

CREATE TABLE IF NOT EXISTS authority_health (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  quorum_ok INTEGER NOT NULL,
  sealed INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO authority_health (id, quorum_ok, sealed, updated_at)
VALUES (1, 1, 0, datetime('now'));
