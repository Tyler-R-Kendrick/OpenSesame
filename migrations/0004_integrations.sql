-- Organization-managed provider instances. Provider endpoints remain in the
-- immutable built-in catalog; this table stores only safe metadata and sealed
-- OAuth client credentials.
CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  key TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  scopes TEXT NOT NULL,
  client_id TEXT,
  client_secret_ciphertext BLOB,
  client_secret_nonce BLOB,
  client_secret_aad_digest TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, key)
);

CREATE INDEX idx_integrations_organization_provider
  ON integrations(organization_id, provider_id);

-- Nullable for rows written before integrations existed. New writes always set
-- it; legacy callers may omit it only when one usable integration is unambiguous.
ALTER TABLE connections ADD COLUMN integration_id TEXT;
CREATE INDEX idx_connections_integration ON connections(integration_id);

ALTER TABLE connection_authorizations ADD COLUMN verifier_nonce BLOB;
ALTER TABLE connection_authorizations ADD COLUMN verifier_aad_digest TEXT;

-- Atomic guards close create/delete races without making synthetic deployment
-- integrations database rows. Organization integrations must exist at insert
-- and cannot disappear while a connection references them.
CREATE TRIGGER connection_integration_exists_insert
BEFORE INSERT ON connections
WHEN NEW.integration_id IS NOT NULL
  AND NEW.integration_id NOT LIKE 'deployment:%'
  AND NOT EXISTS (
    SELECT 1 FROM integrations
    WHERE id = NEW.integration_id AND organization_id = NEW.organization_id
  )
BEGIN
  SELECT RAISE(ABORT, 'integration_not_found');
END;

CREATE TRIGGER connection_integration_exists_update
BEFORE UPDATE OF integration_id ON connections
WHEN NEW.integration_id IS NOT NULL
  AND NEW.integration_id NOT LIKE 'deployment:%'
  AND NOT EXISTS (
    SELECT 1 FROM integrations
    WHERE id = NEW.integration_id AND organization_id = NEW.organization_id
  )
BEGIN
  SELECT RAISE(ABORT, 'integration_not_found');
END;

CREATE TRIGGER integration_delete_guard
BEFORE DELETE ON integrations
WHEN EXISTS (
  SELECT 1 FROM connections
  WHERE integration_id = OLD.id AND organization_id = OLD.organization_id
)
BEGIN
  SELECT RAISE(ABORT, 'integration_in_use');
END;
