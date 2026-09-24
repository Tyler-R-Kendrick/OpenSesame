-- Certificate Manager schema (plan 2026-08-30 §4.1).
--
-- Conventions mirror 0013_certificate_issuance.sql exactly: TEXT primary keys,
-- RFC3339 TEXT timestamps, organization_id REFERENCES organizations(id),
-- composite UNIQUE(organization_id, id) so child rows can key on the tenant
-- pair, version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0) on mutable rows,
-- and all-or-nothing CHECK groups on every sealed-blob column set. Sealed
-- columns hold ciphertext only; plaintext key material never reaches a column.
--
-- SEALED(prefix) below expands to <prefix>_key_id / <prefix>_ciphertext /
-- <prefix>_nonce / <prefix>_aad_digest plus the all-or-nothing CHECK.

-- —— existing-table extensions ————————————————————————————————
-- SQLite ADD COLUMN requires each new column to be nullable or carry a
-- non-NULL default; every statement below respects that.

ALTER TABLE certificate_authorities ADD COLUMN kind TEXT NOT NULL DEFAULT 'root'
  CHECK (kind IN ('root', 'intermediate'));
-- NOTE: parent_id is a same-organization certificate_authorities id. SQLite
-- cannot attach a composite REFERENCES clause through ADD COLUMN, so the
-- same-org parent relationship is enforced in crates/storage (insert_ca_link).
ALTER TABLE certificate_authorities ADD COLUMN parent_id TEXT;
ALTER TABLE certificate_authorities ADD COLUMN key_algorithm TEXT NOT NULL DEFAULT 'ecdsa-p256'
  CHECK (key_algorithm IN ('rsa-2048', 'rsa-4096', 'ecdsa-p256', 'ecdsa-p384', 'ed25519'));
ALTER TABLE certificate_authorities ADD COLUMN subject_json TEXT;
ALTER TABLE certificate_authorities ADD COLUMN path_len INTEGER
  CHECK (path_len IS NULL OR path_len >= 0);
ALTER TABLE certificate_authorities ADD COLUMN key_source TEXT NOT NULL DEFAULT 'sealed'
  CHECK (key_source IN ('sealed', 'hsm'));
-- NOTE: hsm_connector_id points at hsm_connectors(organization_id, id); the FK
-- cannot be attached through ADD COLUMN, so storage validates the pair.
ALTER TABLE certificate_authorities ADD COLUMN hsm_connector_id TEXT;
ALTER TABLE certificate_authorities ADD COLUMN hsm_key_label TEXT;
ALTER TABLE certificate_authorities ADD COLUMN crl_enabled INTEGER NOT NULL DEFAULT 1
  CHECK (crl_enabled IN (0, 1));
ALTER TABLE certificate_authorities ADD COLUMN crl_mirrors_json TEXT;
ALTER TABLE certificate_authorities ADD COLUMN pending_csr_pem TEXT;

ALTER TABLE issued_certificates ADD COLUMN application_id TEXT;
ALTER TABLE issued_certificates ADD COLUMN profile_id TEXT;
ALTER TABLE issued_certificates ADD COLUMN source TEXT NOT NULL DEFAULT 'issued'
  CHECK (source IN ('issued', 'imported', 'discovered'));
ALTER TABLE issued_certificates ADD COLUMN enrollment_method TEXT
  CHECK (enrollment_method IS NULL
    OR enrollment_method IN ('api', 'acme', 'est', 'scep', 'ui', 'import'));
ALTER TABLE issued_certificates ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE issued_certificates ADD COLUMN key_algorithm TEXT;
ALTER TABLE issued_certificates ADD COLUMN signature_algorithm TEXT;
ALTER TABLE issued_certificates ADD COLUMN fingerprint_sha256 TEXT;
ALTER TABLE issued_certificates ADD COLUMN chain_pem TEXT;
ALTER TABLE issued_certificates ADD COLUMN renewed_from_id TEXT;
ALTER TABLE issued_certificates ADD COLUMN renewed_by_id TEXT;
ALTER TABLE issued_certificates ADD COLUMN auto_renew_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (auto_renew_enabled IN (0, 1));
ALTER TABLE issued_certificates ADD COLUMN renew_before_seconds INTEGER
  CHECK (renew_before_seconds IS NULL OR renew_before_seconds > 0);
ALTER TABLE issued_certificates ADD COLUMN revocation_reason INTEGER
  CHECK (revocation_reason IS NULL
    OR (revocation_reason BETWEEN 0 AND 10 AND revocation_reason <> 7));
ALTER TABLE issued_certificates ADD COLUMN revoked_at TEXT;
-- NOTE: the 0013 status column keeps its applied CHECK. New status values
-- ('active','renewed','revoked','expired','pending') are validated in Rust so
-- the applied constraint is never rewritten.
-- NOTE: plan §4.1 asked for SEALED(sealed_key) columns directly on
-- issued_certificates. That would break the standing 0013 invariant that an
-- inventory row is public material only — asserted by
-- `atomic_certificate_delivery_is_encrypted_expiring_and_single_use`, which
-- reads PRAGMA table_info(issued_certificates) and rejects any ciphertext or
-- nonce column. Managed-key custody therefore lives in the dedicated
-- managed_certificate_keys table below, keyed one-to-one on the certificate.
-- The storage API is unchanged: StoredManagedCertificate still carries an
-- optional `sealed_key`, written and read through that table.

CREATE INDEX IF NOT EXISTS idx_issued_certificates_fingerprint
  ON issued_certificates(organization_id, fingerprint_sha256);

CREATE INDEX IF NOT EXISTS idx_issued_certificates_expiry
  ON issued_certificates(organization_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_issued_certificates_application
  ON issued_certificates(organization_id, application_id, status);

CREATE INDEX IF NOT EXISTS idx_issued_certificates_profile
  ON issued_certificates(organization_id, profile_id, status);

CREATE TABLE IF NOT EXISTS managed_certificate_keys (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  certificate_id TEXT NOT NULL,
  sealed_key_key_id TEXT NOT NULL,
  sealed_key_ciphertext BLOB NOT NULL,
  sealed_key_nonce BLOB NOT NULL,
  sealed_key_aad_digest TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, id),
  UNIQUE(organization_id, certificate_id),
  FOREIGN KEY (organization_id, certificate_id)
    REFERENCES issued_certificates(organization_id, id) ON DELETE CASCADE,
  CHECK (length(sealed_key_key_id) > 0 AND length(sealed_key_ciphertext) > 0
    AND length(sealed_key_nonce) > 0 AND length(sealed_key_aad_digest) > 0)
);

-- —— policies and profiles ————————————————————————————————————

CREATE TABLE IF NOT EXISTS certificate_policies (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  preset TEXT NOT NULL CHECK (preset IN ('tls_server', 'tls_client', 'code_signing',
    'device', 'user', 'email_protection', 'dual_purpose_server', 'intermediate_ca', 'custom')),
  max_validity_seconds INTEGER CHECK (max_validity_seconds IS NULL OR max_validity_seconds > 0),
  rules_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, id),
  UNIQUE(organization_id, name),
  CHECK (length(name) > 0)
);

CREATE INDEX IF NOT EXISTS idx_certificate_policies_org_preset
  ON certificate_policies(organization_id, preset, name);

CREATE TABLE IF NOT EXISTS certificate_profiles (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  issuer_type TEXT NOT NULL CHECK (issuer_type IN ('ca', 'self_signed')),
  certificate_authority_id TEXT,
  policy_id TEXT NOT NULL,
  defaults_json TEXT NOT NULL,
  external_template TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, id),
  UNIQUE(organization_id, name),
  FOREIGN KEY (organization_id, policy_id)
    REFERENCES certificate_policies(organization_id, id),
  FOREIGN KEY (organization_id, certificate_authority_id)
    REFERENCES certificate_authorities(organization_id, id),
  CHECK (length(name) > 0),
  CHECK (issuer_type = 'self_signed' OR certificate_authority_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_certificate_profiles_org_policy
  ON certificate_profiles(organization_id, policy_id, name);

-- —— applications, membership, enrollment ——————————————————————

CREATE TABLE IF NOT EXISTS pki_applications (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, id),
  UNIQUE(organization_id, slug),
  CHECK (length(slug) > 0 AND length(display_name) > 0)
);

CREATE TABLE IF NOT EXISTS pki_application_members (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  application_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'auditor')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, id),
  UNIQUE(organization_id, application_id, subject),
  FOREIGN KEY (organization_id, application_id)
    REFERENCES pki_applications(organization_id, id) ON DELETE CASCADE,
  CHECK (length(subject) > 0)
);

CREATE INDEX IF NOT EXISTS idx_pki_application_members_subject
  ON pki_application_members(organization_id, subject, role);

CREATE TABLE IF NOT EXISTS enrollment_configs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  application_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('api', 'acme', 'est', 'scep')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  config_json TEXT NOT NULL,
  auto_renew_enabled INTEGER NOT NULL DEFAULT 0 CHECK (auto_renew_enabled IN (0, 1)),
  renew_before_seconds INTEGER CHECK (renew_before_seconds IS NULL OR renew_before_seconds > 0),
  sealed_secret_key_id TEXT,
  sealed_secret_ciphertext BLOB,
  sealed_secret_nonce BLOB,
  sealed_secret_aad_digest TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, id),
  UNIQUE(organization_id, application_id, profile_id, method),
  FOREIGN KEY (organization_id, application_id)
    REFERENCES pki_applications(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, profile_id)
    REFERENCES certificate_profiles(organization_id, id),
  CHECK (
    (sealed_secret_key_id IS NULL AND sealed_secret_ciphertext IS NULL
      AND sealed_secret_nonce IS NULL AND sealed_secret_aad_digest IS NULL)
    OR
    (sealed_secret_key_id IS NOT NULL AND sealed_secret_ciphertext IS NOT NULL
      AND sealed_secret_nonce IS NOT NULL AND sealed_secret_aad_digest IS NOT NULL
      AND length(sealed_secret_key_id) > 0 AND length(sealed_secret_ciphertext) > 0
      AND length(sealed_secret_nonce) > 0 AND length(sealed_secret_aad_digest) > 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_enrollment_configs_profile_method
  ON enrollment_configs(organization_id, profile_id, method, enabled);

-- —— revocation ————————————————————————————————————————————————

CREATE TABLE IF NOT EXISTS certificate_revocations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  certificate_id TEXT NOT NULL,
  ca_id TEXT NOT NULL,
  serial TEXT NOT NULL,
  reason_code INTEGER NOT NULL CHECK (reason_code BETWEEN 0 AND 10 AND reason_code <> 7),
  revoked_at TEXT NOT NULL,
  crl_number INTEGER CHECK (crl_number IS NULL OR crl_number >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, id),
  UNIQUE(organization_id, ca_id, serial),
  FOREIGN KEY (organization_id, ca_id)
    REFERENCES certificate_authorities(organization_id, id),
  FOREIGN KEY (organization_id, certificate_id)
    REFERENCES issued_certificates(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_certificate_revocations_ca
  ON certificate_revocations(organization_id, ca_id, revoked_at);

CREATE TABLE IF NOT EXISTS crl_state (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ca_id TEXT NOT NULL,
  crl_number INTEGER NOT NULL CHECK (crl_number >= 0),
  this_update TEXT NOT NULL,
  next_update TEXT NOT NULL,
  sealed_der_key_id TEXT,
  sealed_der_ciphertext BLOB,
  sealed_der_nonce BLOB,
  sealed_der_aad_digest TEXT,
  mirror_urls_json TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, id),
  UNIQUE(organization_id, ca_id),
  FOREIGN KEY (organization_id, ca_id)
    REFERENCES certificate_authorities(organization_id, id) ON DELETE CASCADE,
  CHECK (
    (sealed_der_key_id IS NULL AND sealed_der_ciphertext IS NULL
      AND sealed_der_nonce IS NULL AND sealed_der_aad_digest IS NULL)
    OR
    (sealed_der_key_id IS NOT NULL AND sealed_der_ciphertext IS NOT NULL
      AND sealed_der_nonce IS NOT NULL AND sealed_der_aad_digest IS NOT NULL
      AND length(sealed_der_key_id) > 0 AND length(sealed_der_ciphertext) > 0
      AND length(sealed_der_nonce) > 0 AND length(sealed_der_aad_digest) > 0)
  )
);

-- —— network discovery ————————————————————————————————————————

CREATE TABLE IF NOT EXISTS discovery_jobs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  targets_json TEXT NOT NULL,
  ports_json TEXT NOT NULL,
  auto_scan INTEGER NOT NULL DEFAULT 0 CHECK (auto_scan IN (0, 1)),
  scan_interval_days INTEGER CHECK (scan_interval_days IS NULL OR scan_interval_days > 0),
  gateway_ref TEXT,
  allow_internal INTEGER NOT NULL DEFAULT 0 CHECK (allow_internal IN (0, 1)),
  last_scan_at TEXT,
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'scanning', 'failed')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, id),
  UNIQUE(organization_id, name),
  CHECK (length(name) > 0)
);

CREATE INDEX IF NOT EXISTS idx_discovery_jobs_org_status
  ON discovery_jobs(organization_id, status, last_scan_at);

CREATE TABLE IF NOT EXISTS discovery_installations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  fingerprint_sha256 TEXT NOT NULL,
  cn TEXT,
  issuer TEXT,
  not_after TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  change_log_json TEXT NOT NULL DEFAULT '[]',
  matched_certificate_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, id),
  UNIQUE(organization_id, job_id, host, port),
  FOREIGN KEY (organization_id, job_id)
    REFERENCES discovery_jobs(organization_id, id) ON DELETE CASCADE,
  CHECK (length(host) > 0 AND length(fingerprint_sha256) > 0)
);
-- NOTE: matched_certificate_id deliberately carries no FK. A composite FK on
-- (organization_id, matched_certificate_id) could only be released with
-- ON DELETE SET NULL, which SQLite would apply to organization_id as well —
-- and that column is NOT NULL. The link is validated in crates/storage.

CREATE INDEX IF NOT EXISTS idx_discovery_installations_fingerprint
  ON discovery_installations(organization_id, fingerprint_sha256);

CREATE INDEX IF NOT EXISTS idx_discovery_installations_job
  ON discovery_installations(organization_id, job_id, last_seen_at);

-- —— HSM connectors and external CAs ————————————————————————————

CREATE TABLE IF NOT EXISTS hsm_connectors (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  sealed_pin_key_id TEXT,
  sealed_pin_ciphertext BLOB,
  sealed_pin_nonce BLOB,
  sealed_pin_aad_digest TEXT,
  module_hint TEXT NOT NULL,
  key_label_prefix TEXT,
  gateway_ref TEXT,
  status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (status IN ('unverified', 'verified', 'failed')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, id),
  UNIQUE(organization_id, label),
  CHECK (length(label) > 0),
  CHECK (
    (sealed_pin_key_id IS NULL AND sealed_pin_ciphertext IS NULL
      AND sealed_pin_nonce IS NULL AND sealed_pin_aad_digest IS NULL)
    OR
    (sealed_pin_key_id IS NOT NULL AND sealed_pin_ciphertext IS NOT NULL
      AND sealed_pin_nonce IS NOT NULL AND sealed_pin_aad_digest IS NOT NULL
      AND length(sealed_pin_key_id) > 0 AND length(sealed_pin_ciphertext) > 0
      AND length(sealed_pin_nonce) > 0 AND length(sealed_pin_aad_digest) > 0)
  )
);

CREATE TABLE IF NOT EXISTS external_ca_configs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('aws_pca', 'digicert_acme', 'digicert_direct',
    'sectigo', 'godaddy', 'azure_adcs', 'venafi_cloud', 'private_acme')),
  connection_id TEXT NOT NULL,
  config_json TEXT NOT NULL,
  trust_class TEXT NOT NULL
    CHECK (trust_class IN ('public_web', 'private_local', 'origin_only', 'test_only')),
  auto_renew INTEGER NOT NULL DEFAULT 0 CHECK (auto_renew IN (0, 1)),
  renew_before_seconds INTEGER CHECK (renew_before_seconds IS NULL OR renew_before_seconds > 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, id),
  UNIQUE(organization_id, kind, connection_id)
);

CREATE INDEX IF NOT EXISTS idx_external_ca_configs_org_kind
  ON external_ca_configs(organization_id, kind, trust_class);

-- —— code signing ——————————————————————————————————————————————

CREATE TABLE IF NOT EXISTS signers (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  certificate_id TEXT,
  key_source TEXT NOT NULL CHECK (key_source IN ('sealed', 'hsm')),
  hsm_connector_id TEXT,
  hsm_key_label TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'failed', 'disabled', 'expired')),
  auto_renew INTEGER NOT NULL DEFAULT 0 CHECK (auto_renew IN (0, 1)),
  renew_before_seconds INTEGER CHECK (renew_before_seconds IS NULL OR renew_before_seconds > 0),
  sealed_key_key_id TEXT,
  sealed_key_ciphertext BLOB,
  sealed_key_nonce BLOB,
  sealed_key_aad_digest TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, id),
  UNIQUE(organization_id, name),
  FOREIGN KEY (organization_id, certificate_id)
    REFERENCES issued_certificates(organization_id, id),
  FOREIGN KEY (organization_id, hsm_connector_id)
    REFERENCES hsm_connectors(organization_id, id),
  CHECK (length(name) > 0),
  CHECK (key_source = 'sealed' OR hsm_connector_id IS NOT NULL),
  CHECK (
    (sealed_key_key_id IS NULL AND sealed_key_ciphertext IS NULL
      AND sealed_key_nonce IS NULL AND sealed_key_aad_digest IS NULL)
    OR
    (sealed_key_key_id IS NOT NULL AND sealed_key_ciphertext IS NOT NULL
      AND sealed_key_nonce IS NOT NULL AND sealed_key_aad_digest IS NOT NULL
      AND length(sealed_key_key_id) > 0 AND length(sealed_key_ciphertext) > 0
      AND length(sealed_key_nonce) > 0 AND length(sealed_key_aad_digest) > 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_signers_org_status
  ON signers(organization_id, status, name);

CREATE TABLE IF NOT EXISTS signer_members (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  signer_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('administrator', 'operator', 'auditor')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, id),
  UNIQUE(organization_id, signer_id, subject),
  FOREIGN KEY (organization_id, signer_id)
    REFERENCES signers(organization_id, id) ON DELETE CASCADE,
  CHECK (length(subject) > 0)
);

CREATE INDEX IF NOT EXISTS idx_signer_members_subject
  ON signer_members(organization_id, subject, role);

-- —— approvals ——————————————————————————————————————————————————

CREATE TABLE IF NOT EXISTS approval_policies (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('issuance', 'signing')),
  application_id TEXT,
  signer_id TEXT,
  name TEXT NOT NULL,
  max_request_ttl_seconds INTEGER
    CHECK (max_request_ttl_seconds IS NULL OR max_request_ttl_seconds > 0),
  machine_bypass INTEGER NOT NULL DEFAULT 0 CHECK (machine_bypass IN (0, 1)),
  covers_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, id),
  UNIQUE(organization_id, name),
  FOREIGN KEY (organization_id, application_id)
    REFERENCES pki_applications(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, signer_id)
    REFERENCES signers(organization_id, id) ON DELETE CASCADE,
  CHECK (length(name) > 0),
  CHECK (
    (scope = 'issuance' AND signer_id IS NULL)
    OR (scope = 'signing' AND application_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_approval_policies_scope
  ON approval_policies(organization_id, scope, application_id, signer_id);

CREATE TABLE IF NOT EXISTS approval_steps (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  policy_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  name TEXT NOT NULL,
  approvers_json TEXT NOT NULL,
  required_count INTEGER NOT NULL CHECK (required_count > 0),
  notify INTEGER NOT NULL DEFAULT 1 CHECK (notify IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, id),
  UNIQUE(organization_id, policy_id, seq),
  FOREIGN KEY (organization_id, policy_id)
    REFERENCES approval_policies(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  policy_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('issuance', 'signing')),
  requester TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('open', 'approved', 'rejected', 'cancelled', 'expired')),
  current_step INTEGER NOT NULL DEFAULT 0 CHECK (current_step >= 0),
  expires_at TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  result_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, id),
  FOREIGN KEY (organization_id, policy_id)
    REFERENCES approval_policies(organization_id, id) ON DELETE CASCADE,
  CHECK (length(requester) > 0 AND length(payload_digest) > 0)
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_status
  ON approval_requests(organization_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_approval_requests_policy
  ON approval_requests(organization_id, policy_id, created_at);

CREATE TABLE IF NOT EXISTS approval_decisions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  step_seq INTEGER NOT NULL CHECK (step_seq >= 0),
  approver TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
  comment TEXT,
  decided_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, id),
  UNIQUE(organization_id, request_id, step_seq, approver),
  FOREIGN KEY (organization_id, request_id)
    REFERENCES approval_requests(organization_id, id) ON DELETE CASCADE,
  CHECK (length(approver) > 0)
);

-- —— signing access records and the activity ledger ————————————

CREATE TABLE IF NOT EXISTS signing_access_records (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  signer_id TEXT NOT NULL,
  approval_request_id TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'active', 'expired', 'revoked', 'rejected')),
  signatures_allowed INTEGER CHECK (signatures_allowed IS NULL OR signatures_allowed > 0),
  signatures_used INTEGER NOT NULL DEFAULT 0 CHECK (signatures_used >= 0),
  window_expires_at TEXT,
  scope_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, id),
  FOREIGN KEY (organization_id, signer_id)
    REFERENCES signers(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, approval_request_id)
    REFERENCES approval_requests(organization_id, id),
  CHECK (signatures_allowed IS NULL OR signatures_used <= signatures_allowed)
);

CREATE INDEX IF NOT EXISTS idx_signing_access_records_signer
  ON signing_access_records(organization_id, signer_id, status, window_expires_at);

CREATE TABLE IF NOT EXISTS signing_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  signer_id TEXT NOT NULL,
  access_record_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'denied')),
  command TEXT,
  application_name TEXT,
  application_sha256 TEXT,
  hostname TEXT,
  os_username TEXT,
  ip TEXT,
  data_hash TEXT,
  occurred_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, id),
  FOREIGN KEY (organization_id, signer_id)
    REFERENCES signers(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, access_record_id)
    REFERENCES signing_access_records(organization_id, id)
);

CREATE INDEX IF NOT EXISTS idx_signing_events_signer
  ON signing_events(organization_id, signer_id, occurred_at);

-- —— lifecycle alerting ————————————————————————————————————————

CREATE TABLE IF NOT EXISTS cert_alerts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  application_id TEXT NOT NULL,
  type TEXT NOT NULL
    CHECK (type IN ('expiration', 'issuance', 'renewal', 'revocation')),
  before_window_seconds INTEGER
    CHECK (before_window_seconds IS NULL OR before_window_seconds > 0),
  daily_reminder INTEGER NOT NULL DEFAULT 0 CHECK (daily_reminder IN (0, 1)),
  channels_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, id),
  FOREIGN KEY (organization_id, application_id)
    REFERENCES pki_applications(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cert_alerts_application
  ON cert_alerts(organization_id, application_id, type);

CREATE TABLE IF NOT EXISTS alert_deliveries (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  alert_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'pending')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at TEXT,
  payload_digest TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, id),
  FOREIGN KEY (organization_id, alert_id)
    REFERENCES cert_alerts(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_alert_deliveries_alert
  ON alert_deliveries(organization_id, alert_id, created_at);

-- —— certificate syncs ————————————————————————————————————————

CREATE TABLE IF NOT EXISTS cert_syncs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  certificate_id TEXT NOT NULL,
  destination_kind TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  name_schema TEXT NOT NULL,
  remove_on_expiry INTEGER NOT NULL DEFAULT 0 CHECK (remove_on_expiry IN (0, 1)),
  include_root INTEGER NOT NULL DEFAULT 0 CHECK (include_root IN (0, 1)),
  options_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_run_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, id),
  UNIQUE(organization_id, certificate_id, destination_kind, connection_id),
  FOREIGN KEY (organization_id, certificate_id)
    REFERENCES issued_certificates(organization_id, id) ON DELETE CASCADE,
  CHECK (length(destination_kind) > 0 AND length(connection_id) > 0)
);

CREATE INDEX IF NOT EXISTS idx_cert_syncs_certificate
  ON cert_syncs(organization_id, certificate_id, enabled);

CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sync_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  detail TEXT,
  ran_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, id),
  FOREIGN KEY (organization_id, sync_id)
    REFERENCES cert_syncs(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_sync
  ON sync_runs(organization_id, sync_id, ran_at);

-- —— ACME server ————————————————————————————————————————————————

CREATE TABLE IF NOT EXISTS acme_server_accounts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL,
  jwk_thumbprint TEXT NOT NULL,
  eab_kid TEXT,
  status TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'deactivated')),
  contacts_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, id),
  UNIQUE(organization_id, profile_id, jwk_thumbprint),
  FOREIGN KEY (organization_id, profile_id)
    REFERENCES certificate_profiles(organization_id, id) ON DELETE CASCADE,
  CHECK (length(jwk_thumbprint) > 0)
);

CREATE TABLE IF NOT EXISTS acme_orders (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'ready', 'processing', 'valid', 'invalid')),
  identifiers_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  finalize_csr_pem TEXT,
  certificate_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, id),
  FOREIGN KEY (organization_id, account_id)
    REFERENCES acme_server_accounts(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, certificate_id)
    REFERENCES issued_certificates(organization_id, id)
);

CREATE INDEX IF NOT EXISTS idx_acme_orders_account
  ON acme_orders(organization_id, account_id, status, expires_at);

CREATE TABLE IF NOT EXISTS acme_challenges (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL,
  authz_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('http-01', 'dns-01')),
  token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'valid', 'invalid')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, id),
  UNIQUE(organization_id, order_id, authz_id, type),
  FOREIGN KEY (organization_id, order_id)
    REFERENCES acme_orders(organization_id, id) ON DELETE CASCADE,
  CHECK (length(token) > 0)
);

CREATE INDEX IF NOT EXISTS idx_acme_challenges_authz
  ON acme_challenges(organization_id, authz_id, status);

CREATE TABLE IF NOT EXISTS acme_nonces (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  nonce TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, id),
  UNIQUE(organization_id, nonce),
  CHECK (length(nonce) > 0)
);

CREATE INDEX IF NOT EXISTS idx_acme_nonces_issued
  ON acme_nonces(organization_id, issued_at);

-- —— EST and SCEP ——————————————————————————————————————————————

CREATE TABLE IF NOT EXISTS est_configs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL,
  sealed_passphrase_key_id TEXT,
  sealed_passphrase_ciphertext BLOB,
  sealed_passphrase_nonce BLOB,
  sealed_passphrase_aad_digest TEXT,
  bootstrap_chain_pem TEXT,
  require_bootstrap INTEGER NOT NULL DEFAULT 1 CHECK (require_bootstrap IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, id),
  UNIQUE(organization_id, profile_id),
  FOREIGN KEY (organization_id, profile_id)
    REFERENCES certificate_profiles(organization_id, id) ON DELETE CASCADE,
  CHECK (
    (sealed_passphrase_key_id IS NULL AND sealed_passphrase_ciphertext IS NULL
      AND sealed_passphrase_nonce IS NULL AND sealed_passphrase_aad_digest IS NULL)
    OR
    (sealed_passphrase_key_id IS NOT NULL AND sealed_passphrase_ciphertext IS NOT NULL
      AND sealed_passphrase_nonce IS NOT NULL AND sealed_passphrase_aad_digest IS NOT NULL
      AND length(sealed_passphrase_key_id) > 0 AND length(sealed_passphrase_ciphertext) > 0
      AND length(sealed_passphrase_nonce) > 0 AND length(sealed_passphrase_aad_digest) > 0)
  )
);

CREATE TABLE IF NOT EXISTS scep_configs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL,
  challenge_mode TEXT NOT NULL CHECK (challenge_mode IN ('static', 'dynamic')),
  sealed_static_secret_key_id TEXT,
  sealed_static_secret_ciphertext BLOB,
  sealed_static_secret_nonce BLOB,
  sealed_static_secret_aad_digest TEXT,
  ra_signs_with_ca INTEGER NOT NULL DEFAULT 1 CHECK (ra_signs_with_ca IN (0, 1)),
  include_ca_cert INTEGER NOT NULL DEFAULT 1 CHECK (include_ca_cert IN (0, 1)),
  allow_cert_renewal INTEGER NOT NULL DEFAULT 0 CHECK (allow_cert_renewal IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, id),
  UNIQUE(organization_id, profile_id),
  FOREIGN KEY (organization_id, profile_id)
    REFERENCES certificate_profiles(organization_id, id) ON DELETE CASCADE,
  CHECK (
    (sealed_static_secret_key_id IS NULL AND sealed_static_secret_ciphertext IS NULL
      AND sealed_static_secret_nonce IS NULL AND sealed_static_secret_aad_digest IS NULL)
    OR
    (sealed_static_secret_key_id IS NOT NULL AND sealed_static_secret_ciphertext IS NOT NULL
      AND sealed_static_secret_nonce IS NOT NULL
      AND sealed_static_secret_aad_digest IS NOT NULL
      AND length(sealed_static_secret_key_id) > 0
      AND length(sealed_static_secret_ciphertext) > 0
      AND length(sealed_static_secret_nonce) > 0
      AND length(sealed_static_secret_aad_digest) > 0)
  )
);

CREATE TABLE IF NOT EXISTS scep_challenges (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  config_id TEXT NOT NULL,
  challenge_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, id),
  UNIQUE(organization_id, config_id, challenge_hash),
  FOREIGN KEY (organization_id, config_id)
    REFERENCES scep_configs(organization_id, id) ON DELETE CASCADE,
  CHECK (length(challenge_hash) > 0)
);

CREATE INDEX IF NOT EXISTS idx_scep_challenges_config
  ON scep_challenges(organization_id, config_id, expires_at);
