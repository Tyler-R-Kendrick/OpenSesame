-- Credential generations close overlapping OAuth exchange/refresh races. The
-- default exists only so SQLite can upgrade tables that already contain rows;
-- every subsequent credential write supplies a fresh UUID generation.
ALTER TABLE connection_credentials ADD COLUMN version TEXT NOT NULL DEFAULT '';
UPDATE connection_credentials
SET version = lower(hex(randomblob(16)))
WHERE version = '';

-- Authorization states remember the generation visible when consent started.
-- Null means no credential existed, so only one overlapping first grant wins.
ALTER TABLE connection_authorizations ADD COLUMN credential_version TEXT;
