-- One durable budget per existing EST configuration, shared by enrollment and
-- re-enrollment. No requester-selected buckets or plaintext credentials persist.
ALTER TABLE est_configs ADD COLUMN passphrase_attempts INTEGER NOT NULL DEFAULT 0
  CHECK (passphrase_attempts BETWEEN 0 AND 5);
ALTER TABLE est_configs ADD COLUMN passphrase_window_expires INTEGER NOT NULL DEFAULT 0;
