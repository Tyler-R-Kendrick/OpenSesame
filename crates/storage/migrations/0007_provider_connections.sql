-- Native Fnox-style credential-provider records. This must be append-only:
-- deployments that already applied 0001 will not replay it.
CREATE TABLE IF NOT EXISTS provider_connections (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT REFERENCES projects(id),
  provider_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  body_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_provider_connections_org
  ON provider_connections(organization_id, created_at, id);
