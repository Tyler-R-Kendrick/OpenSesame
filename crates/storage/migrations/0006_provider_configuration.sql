-- Provider-defined configuration stays sealed while a small, value-free index
-- lets API responses describe which fields are configured.
ALTER TABLE integrations ADD COLUMN configuration_ciphertext BLOB;
ALTER TABLE integrations ADD COLUMN configuration_nonce BLOB;
ALTER TABLE integrations ADD COLUMN configuration_aad_digest TEXT;
ALTER TABLE integrations ADD COLUMN configured_fields TEXT NOT NULL DEFAULT '[]';

UPDATE integrations
SET configured_fields = CASE
  WHEN client_id IS NOT NULL AND client_secret_ciphertext IS NOT NULL THEN '["client_id","client_secret"]'
  WHEN client_id IS NOT NULL THEN '["client_id"]'
  WHEN client_secret_ciphertext IS NOT NULL THEN '["client_secret"]'
  ELSE '[]'
END;

ALTER TABLE connection_credentials ADD COLUMN configured_fields TEXT NOT NULL DEFAULT '[]';
UPDATE connection_credentials
SET configured_fields = '["api_key"]'
WHERE token_type = 'api_key';
