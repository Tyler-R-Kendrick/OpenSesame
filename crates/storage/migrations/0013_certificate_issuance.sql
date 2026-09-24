-- Durable certificate authority and issuance state. Existing certificate data in
-- host_kv is deliberately untouched: application code must seal it before copying
-- it into these tables.

CREATE TABLE IF NOT EXISTS certificate_authorities (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  issuer_kind TEXT NOT NULL,
  issuer_connection_id TEXT,
  display_name TEXT NOT NULL,
  public_metadata_json TEXT NOT NULL,
  sealed_key_id TEXT NOT NULL,
  sealed_ciphertext BLOB NOT NULL,
  sealed_nonce BLOB NOT NULL,
  sealed_aad_digest TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  status TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, id),
  CHECK (length(sealed_key_id) > 0 AND length(sealed_ciphertext) > 0
    AND length(sealed_nonce) > 0 AND length(sealed_aad_digest) > 0),
  CHECK (is_default = 0 OR status = 'active')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_certificate_authorities_one_default
  ON certificate_authorities(organization_id)
  WHERE is_default = 1;

CREATE INDEX IF NOT EXISTS idx_certificate_authorities_org_status
  ON certificate_authorities(organization_id, status, created_at);

CREATE TABLE IF NOT EXISTS certificate_issuance_requests (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  authority_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_by TEXT NOT NULL,
  state TEXT NOT NULL,
  common_name TEXT NOT NULL,
  san_json TEXT NOT NULL,
  delivery_key_id TEXT,
  delivery_ciphertext BLOB,
  delivery_nonce BLOB,
  delivery_aad_digest TEXT,
  delivery_expires_at TEXT,
  expires_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, id),
  UNIQUE(organization_id, request_digest),
  UNIQUE(organization_id, idempotency_key),
  FOREIGN KEY (organization_id, authority_id)
    REFERENCES certificate_authorities(organization_id, id),
  CHECK (
    (delivery_key_id IS NULL AND delivery_ciphertext IS NULL AND delivery_nonce IS NULL
      AND delivery_aad_digest IS NULL AND delivery_expires_at IS NULL)
    OR
    (delivery_key_id IS NOT NULL AND delivery_ciphertext IS NOT NULL AND delivery_nonce IS NOT NULL
      AND delivery_aad_digest IS NOT NULL AND delivery_expires_at IS NOT NULL
      AND length(delivery_key_id) > 0 AND length(delivery_ciphertext) > 0
      AND length(delivery_nonce) > 0 AND length(delivery_aad_digest) > 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_certificate_requests_org_state_expiry
  ON certificate_issuance_requests(organization_id, state, expires_at);

CREATE INDEX IF NOT EXISTS idx_certificate_requests_authority
  ON certificate_issuance_requests(authority_id, created_at);

CREATE TABLE IF NOT EXISTS issued_certificates (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  authority_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  certificate_digest TEXT NOT NULL,
  serial_number TEXT NOT NULL,
  common_name TEXT NOT NULL,
  san_json TEXT NOT NULL,
  not_before TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, id),
  UNIQUE(organization_id, request_id),
  UNIQUE(organization_id, certificate_digest),
  UNIQUE(authority_id, serial_number),
  FOREIGN KEY (organization_id, authority_id)
    REFERENCES certificate_authorities(organization_id, id),
  FOREIGN KEY (organization_id, request_id)
    REFERENCES certificate_issuance_requests(organization_id, id)
);

CREATE INDEX IF NOT EXISTS idx_issued_certificates_org_expiry
  ON issued_certificates(organization_id, status, expires_at);
