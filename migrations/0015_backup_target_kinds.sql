-- Backup targets grow a kind discriminator (ADR 0061 §6). Additive: existing
-- GitHub rows read back kind='github_app' and keep working unchanged.
--
-- kind='connector' rows deliver ciphertext snapshots through the connection
-- broker's authorized egress instead of the GitHub App path: provider_id and
-- connection_id name the Host connection, config carries non-secret shape
-- only (the route refuses secret-shaped keys; credentials live sealed under
-- the connection, never here).

ALTER TABLE backup_targets ADD COLUMN kind TEXT NOT NULL DEFAULT 'github_app';
ALTER TABLE backup_targets ADD COLUMN provider_id TEXT;
ALTER TABLE backup_targets ADD COLUMN connection_id TEXT;
ALTER TABLE backup_targets ADD COLUMN config TEXT;
