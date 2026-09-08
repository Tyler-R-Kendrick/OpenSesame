CREATE TABLE agent_launches (
  handle_digest TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  audience TEXT NOT NULL,
  resource TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  approved_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX agent_launch_expiry ON agent_launches(expires_at);
CREATE TABLE agent_capabilities (
  token_digest TEXT PRIMARY KEY,
  launch_digest TEXT NOT NULL REFERENCES agent_launches(handle_digest),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX agent_capability_expiry ON agent_capabilities(expires_at);
