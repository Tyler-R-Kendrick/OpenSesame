ALTER TABLE browser_clients ADD COLUMN authentication_json TEXT;
CREATE TABLE host_authorizations (
 id TEXT PRIMARY KEY,
 client_id TEXT NOT NULL REFERENCES browser_clients(id) ON DELETE CASCADE,
 digest TEXT NOT NULL UNIQUE,
 operation TEXT NOT NULL CHECK(operation IN ('browser.authenticate','agent.browser.control')),
 target_id TEXT NOT NULL,
 transition TEXT,
 run_version INTEGER,
 state TEXT NOT NULL CHECK(state IN ('pending','authorized','consumed')),
 evidence_jti TEXT UNIQUE,
 elevation_digest TEXT UNIQUE,
 expires_at INTEGER NOT NULL
);
CREATE INDEX host_authorizations_expiry ON host_authorizations(expires_at);
