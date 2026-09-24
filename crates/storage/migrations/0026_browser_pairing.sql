CREATE TABLE browser_pairings (
  id TEXT PRIMARY KEY,
  device_digest TEXT NOT NULL UNIQUE,
  user_code_digest TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL,
  dpop_jkt TEXT NOT NULL,
  audience TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','approved','denied','consumed')),
  principal_id TEXT,
  organization_id TEXT,
  approved_at INTEGER,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX browser_pairings_expiry ON browser_pairings(expires_at);
CREATE TABLE browser_clients (
  id TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  dpop_jkt TEXT NOT NULL,
  audience TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  approved_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX browser_clients_owner ON browser_clients(principal_id, organization_id);
CREATE TABLE browser_grants (
  token_digest TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES browser_clients(id),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX browser_grants_expiry ON browser_grants(expires_at);
CREATE TABLE browser_proof_replay (digest TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE INDEX browser_proof_replay_expiry ON browser_proof_replay(expires_at);
CREATE TABLE browser_pairing_rate (bucket TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at INTEGER NOT NULL);
