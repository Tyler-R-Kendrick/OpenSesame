-- Org-scoped custom connector definitions (ADR 0032 extension).
-- Definitions are public metadata only: OAuth client credentials for a custom
-- provider are sealed through the existing integrations table, and API keys
-- through connection credentials. provider_json is the derived catalog
-- Provider record, validated before insert.
CREATE TABLE IF NOT EXISTS custom_providers (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  provider_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, id)
);
