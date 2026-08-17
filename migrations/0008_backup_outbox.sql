-- Event-driven GitHub backup (ADR 0039). Append-only: deployments that
-- already applied 0001 will not replay it, so outbox_events gains its
-- delivery-tracking columns here rather than in place.

ALTER TABLE outbox_events ADD COLUMN available_at TEXT;
ALTER TABLE outbox_events ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbox_events ADD COLUMN last_error TEXT;

CREATE INDEX IF NOT EXISTS idx_outbox_events_unpublished
  ON outbox_events(available_at, created_at)
  WHERE published_at IS NULL;

-- One backup target per organization: the GitHub repository an installed
-- GitHub App persists ciphertext snapshots into.
CREATE TABLE IF NOT EXISTS backup_targets (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id),
  integration_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT 'main',
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  last_commit_sha TEXT,
  last_synced_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
