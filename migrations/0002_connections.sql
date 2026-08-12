-- Connection broker state (ADR 0032). The 0001 `connections` table modelled a
-- connector installation and was never written to; this replaces it with the
-- broker's shape. Preserve the earlier catalog-install rows for explicit data
-- migration/audit; their connector-version schema cannot be losslessly coerced
-- into authorization-bearing broker connections.
ALTER TABLE connections RENAME TO legacy_connections;

-- organization_id/project_id carry no foreign key: a connection is authority-plane
-- state and may be created before the control plane has rows for either.
CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT,
  provider_id TEXT NOT NULL,
  logical_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL,
  status_detail TEXT,
  requested_scopes TEXT NOT NULL,
  granted_scopes TEXT NOT NULL,
  account_label TEXT,
  owner_kind TEXT NOT NULL,
  shareability TEXT NOT NULL,
  max_invoke_level INTEGER NOT NULL,
  egress_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, logical_name)
);

CREATE INDEX IF NOT EXISTS idx_connections_organization ON connections(organization_id);

-- The only table holding credential material, and it holds it sealed.
CREATE TABLE IF NOT EXISTS connection_credentials (
  connection_id TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
  ciphertext BLOB NOT NULL,
  nonce BLOB NOT NULL,
  aad_digest TEXT NOT NULL,
  token_type TEXT NOT NULL,
  expires_at TEXT,
  refreshable INTEGER NOT NULL,
  last_refreshed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connection_bindings (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_label TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(connection_id, target_kind, target_id)
);

CREATE INDEX IF NOT EXISTS idx_connection_bindings_connection ON connection_bindings(connection_id);

-- Holds a live PKCE verifier: single-use, TTL-bound, verifier erased on consumption.
CREATE TABLE IF NOT EXISTS connection_authorizations (
  state TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  code_verifier BLOB NOT NULL,
  redirect_uri TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_connection_authorizations_connection ON connection_authorizations(connection_id);

CREATE TABLE IF NOT EXISTS connection_events (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  detail TEXT,
  at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_connection_events_connection ON connection_events(connection_id);
