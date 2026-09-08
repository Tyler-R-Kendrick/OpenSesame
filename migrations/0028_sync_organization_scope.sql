-- Preserve legacy ciphertext without guessing an organization from a new caller.
-- Empty organization_id is quarantined and never admitted by network routes.
ALTER TABLE encrypted_sync_blobs RENAME TO encrypted_sync_blobs_legacy;
CREATE TABLE encrypted_sync_blobs (
  organization_id TEXT NOT NULL DEFAULT '',
  id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  ingestion_epoch INTEGER NOT NULL DEFAULT 0,
  ciphertext BLOB NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, id)
);
INSERT INTO encrypted_sync_blobs (organization_id, id, owner_id, epoch, ingestion_epoch, ciphertext, updated_at)
  SELECT '', id, owner_id, epoch, ROW_NUMBER() OVER (ORDER BY owner_id, epoch, id), ciphertext, updated_at FROM encrypted_sync_blobs_legacy;
DROP TABLE encrypted_sync_blobs_legacy;
CREATE INDEX idx_encrypted_sync_blobs_org_owner_cursor
  ON encrypted_sync_blobs(organization_id, owner_id, ingestion_epoch, id);
CREATE TABLE sync_ingestion_clock (singleton INTEGER PRIMARY KEY CHECK(singleton=1), epoch INTEGER NOT NULL);
INSERT INTO sync_ingestion_clock(singleton,epoch) SELECT 1, COALESCE(MAX(ingestion_epoch),0) FROM encrypted_sync_blobs;
