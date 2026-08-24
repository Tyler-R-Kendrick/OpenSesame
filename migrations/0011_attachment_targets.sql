-- Attachment replication target (ADR 0054).
--
-- One row per organization naming where sealed attachment ciphertext should be
-- replicated. The gateway never holds attachment chunks: clients push sealed
-- bytes through the replicate endpoints, which inject the provider credential
-- and forward. So this table carries configuration and status only — no token
-- material, no chunk digests, no plaintext.
CREATE TABLE IF NOT EXISTS attachment_targets (
  organization_id      TEXT PRIMARY KEY,
  connection_id        TEXT NOT NULL,
  provider_id          TEXT NOT NULL,
  folder_path          TEXT NOT NULL,
  enabled              INTEGER NOT NULL DEFAULT 1,
  status               TEXT NOT NULL DEFAULT 'configured',
  last_error           TEXT,
  updated_at_unix_ms   INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
