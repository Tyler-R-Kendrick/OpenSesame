use anyhow::Context;
use async_trait::async_trait;
use chrono::Utc;
use opensesame_domain::{
    ConnectionId, ConnectionRecord, Grant, GrantId, Intent, Invocation, InvocationReceipt,
    OrganizationId, ProjectId,
};
use sqlx::{sqlite::SqlitePoolOptions, sqlite::SqliteRow, Row, SqlitePool};
use std::path::Path;

#[derive(Clone)]
pub struct Db {
    pool: SqlitePool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredSyncBlob {
    pub id: String,
    pub epoch: u64,
    pub ciphertext: Vec<u8>,
}

fn db_u64(value: i64, field: &str) -> anyhow::Result<u64> {
    u64::try_from(value).with_context(|| format!("negative {field} in database"))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncWriteOutcome {
    Accepted,
    BatchAborted,
    ForeignOwner,
    OwnerQuota,
    StoreFull,
    StaleEpoch,
}

#[derive(Clone, PartialEq, Eq)]
pub struct SealedCertificateMaterial {
    pub key_id: String,
    pub ciphertext: Vec<u8>,
    pub nonce: Vec<u8>,
    pub aad_digest: String,
}

impl std::fmt::Debug for SealedCertificateMaterial {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SealedCertificateMaterial")
            .field("key_id", &self.key_id)
            .field("ciphertext", &"[REDACTED]")
            .field("nonce", &"[REDACTED]")
            .field("aad_digest", &self.aad_digest)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredCertificateAuthority {
    pub id: String,
    pub organization_id: String,
    pub issuer_kind: String,
    pub issuer_connection_id: Option<String>,
    pub display_name: String,
    pub public_metadata_json: String,
    pub sealed_material: SealedCertificateMaterial,
    pub is_default: bool,
    pub status: String,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SealedCertificateDelivery {
    pub material: SealedCertificateMaterial,
    pub expires_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredCertificateIssuanceRequest {
    pub id: String,
    pub organization_id: String,
    pub authority_id: String,
    pub request_digest: String,
    pub idempotency_key: String,
    pub created_by: String,
    pub state: String,
    pub common_name: String,
    pub san_json: String,
    pub delivery: Option<SealedCertificateDelivery>,
    pub expires_at: String,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredIssuedCertificate {
    pub id: String,
    pub organization_id: String,
    pub authority_id: String,
    pub request_id: String,
    pub certificate_digest: String,
    pub serial_number: String,
    pub common_name: String,
    pub san_json: String,
    pub not_before: String,
    pub expires_at: String,
    pub status: String,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// Purpose-separated seal scopes for Certificate Manager custody.
///
/// Every sealed blob is produced with `seal_scoped(key, SCOPE, id, organization,
/// plaintext)`, so the scope string becomes part of the additional authenticated
/// data. Ciphertext sealed for one purpose therefore cannot be opened as another
/// even when an attacker can move rows between tables.
pub mod seal_scopes {
    /// Managed leaf private keys the host generated on a subject's behalf.
    pub const MANAGED_LEAF_KEY: &str = "managed_leaf_key";
    /// Per-enrollment-method secrets stored on `enrollment_configs`.
    pub const ENROLLMENT_SECRET: &str = "enrollment_secret";
    /// ACME external account binding HMAC keys.
    pub const EAB_SECRET: &str = "eab_secret";
    /// EST bootstrap passphrases.
    pub const EST_PASSPHRASE: &str = "est_passphrase";
    /// SCEP static challenge secrets.
    pub const SCEP_STATIC_SECRET: &str = "scep_static_secret";
    /// Code-signing private keys held in sealed custody.
    pub const SIGNER_KEY: &str = "signer_key";
    /// HSM partition PINs.
    pub const HSM_PIN: &str = "hsm_pin";
    /// Credentials used to talk to an external certificate authority.
    pub const EXTERNAL_CA_CREDENTIAL: &str = "external_ca_credential";
    /// Signed certificate revocation lists at rest.
    pub const CRL_DER: &str = "crl_der";
    /// ACME account keys.
    pub const ACME_ACCOUNT_KEY: &str = "acme_account_key";
}

/// Membership role on a PKI application or a code signer.
///
/// Applications spell the highest role `admin` and signers spell it
/// `administrator`; both map onto [`Role::Admin`] so callers compare one ladder.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Role {
    /// Read-only access to inventory and activity.
    Auditor,
    /// May request issuance or signatures within policy.
    Operator,
    /// May change configuration and membership.
    Admin,
}

impl Role {
    /// Parse a role as stored on `pki_application_members`.
    #[must_use]
    pub fn from_application_str(value: &str) -> Option<Self> {
        match value {
            "admin" => Some(Self::Admin),
            "operator" => Some(Self::Operator),
            "auditor" => Some(Self::Auditor),
            _ => None,
        }
    }

    /// Parse a role as stored on `signer_members`.
    #[must_use]
    pub fn from_signer_str(value: &str) -> Option<Self> {
        match value {
            "administrator" => Some(Self::Admin),
            "operator" => Some(Self::Operator),
            "auditor" => Some(Self::Auditor),
            _ => None,
        }
    }

    /// Spelling used by `pki_application_members.role`.
    #[must_use]
    pub fn as_application_str(self) -> &'static str {
        match self {
            Self::Admin => "admin",
            Self::Operator => "operator",
            Self::Auditor => "auditor",
        }
    }

    /// Spelling used by `signer_members.role`.
    #[must_use]
    pub fn as_signer_str(self) -> &'static str {
        match self {
            Self::Admin => "administrator",
            Self::Operator => "operator",
            Self::Auditor => "auditor",
        }
    }
}

/// Where an approval request's current step stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalStepOutcome {
    /// The step has not gathered its required approvals yet.
    Pending,
    /// The step gathered enough approvals; the request may advance.
    StepSatisfied,
    /// An approver rejected, so the request cannot proceed.
    Rejected,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredCertificatePolicy {
    pub id: String,
    pub organization_id: String,
    pub name: String,
    pub description: Option<String>,
    pub preset: String,
    pub max_validity_seconds: Option<i64>,
    pub rules_json: String,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredCertificateProfile {
    pub id: String,
    pub organization_id: String,
    pub name: String,
    pub issuer_type: String,
    pub certificate_authority_id: Option<String>,
    pub policy_id: String,
    pub defaults_json: String,
    pub external_template: Option<String>,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredPkiApplication {
    pub id: String,
    pub organization_id: String,
    pub slug: String,
    pub display_name: String,
    pub description: Option<String>,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredPkiApplicationMember {
    pub id: String,
    pub organization_id: String,
    pub application_id: String,
    pub subject: String,
    pub role: String,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// Per-application enrollment wiring. The method secret is ciphertext only; its
/// `Debug` never renders the sealed bytes.
#[derive(Clone, PartialEq, Eq)]
pub struct StoredEnrollmentConfig {
    pub id: String,
    pub organization_id: String,
    pub application_id: String,
    pub profile_id: String,
    pub method: String,
    pub enabled: bool,
    pub config_json: String,
    pub auto_renew_enabled: bool,
    pub renew_before_seconds: Option<i64>,
    pub sealed_secret: Option<SealedCertificateMaterial>,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

impl std::fmt::Debug for StoredEnrollmentConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("StoredEnrollmentConfig")
            .field("id", &self.id)
            .field("organization_id", &self.organization_id)
            .field("application_id", &self.application_id)
            .field("profile_id", &self.profile_id)
            .field("method", &self.method)
            .field("enabled", &self.enabled)
            .field("config_json", &self.config_json)
            .field("auto_renew_enabled", &self.auto_renew_enabled)
            .field("renew_before_seconds", &self.renew_before_seconds)
            .field("sealed_secret", &"[REDACTED]")
            .field("version", &self.version)
            .field("created_at", &self.created_at)
            .field("updated_at", &self.updated_at)
            .finish()
    }
}

/// A row of the managed certificate inventory: the 0013 `issued_certificates`
/// columns plus every 0016 extension.
///
/// Public material only, per ADR 0052. A managed private key is never a column
/// here; it lives in `managed_certificate_keys` and is reached solely through
/// [`Db::get_managed_certificate_key`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredManagedCertificate {
    pub id: String,
    pub organization_id: String,
    pub authority_id: String,
    pub request_id: String,
    pub certificate_digest: String,
    pub serial_number: String,
    pub common_name: String,
    pub san_json: String,
    pub not_before: String,
    pub expires_at: String,
    pub status: String,
    pub application_id: Option<String>,
    pub profile_id: Option<String>,
    pub source: String,
    pub enrollment_method: Option<String>,
    pub metadata_json: String,
    pub key_algorithm: Option<String>,
    pub signature_algorithm: Option<String>,
    pub fingerprint_sha256: Option<String>,
    pub chain_pem: Option<String>,
    pub renewed_from_id: Option<String>,
    pub renewed_by_id: Option<String>,
    pub auto_renew_enabled: bool,
    pub renew_before_seconds: Option<i64>,
    pub revocation_reason: Option<i64>,
    pub revoked_at: Option<String>,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// Sealed custody for a certificate's managed private key.
///
/// This is the only Certificate Manager table that stores private key material
/// at rest. It exists to serve server-driven renewal and certificate syncs; no
/// inventory read path joins it, so a certificate listing or projection can
/// never pick key material up by accident.
#[derive(Clone, PartialEq, Eq)]
pub struct StoredManagedCertificateKey {
    pub id: String,
    pub organization_id: String,
    pub certificate_id: String,
    pub sealed_key: SealedCertificateMaterial,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

impl std::fmt::Debug for StoredManagedCertificateKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("StoredManagedCertificateKey")
            .field("id", &self.id)
            .field("organization_id", &self.organization_id)
            .field("certificate_id", &self.certificate_id)
            .field("sealed_key", &"[REDACTED]")
            .field("version", &self.version)
            .field("created_at", &self.created_at)
            .field("updated_at", &self.updated_at)
            .finish()
    }
}

/// Dynamic, always-parameterized filter for [`Db::list_certificates`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CertificateFilter {
    pub status: Option<String>,
    pub common_name_contains: Option<String>,
    pub san_contains: Option<String>,
    pub profile_id: Option<String>,
    pub application_id: Option<String>,
    pub expiring_before: Option<String>,
    pub metadata_key: Option<String>,
    pub metadata_value: Option<String>,
    pub limit: Option<i64>,
}

/// Non-secret counts backing the Certificates dashboard.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DashboardRollup {
    pub total: i64,
    pub by_status: std::collections::BTreeMap<String, i64>,
    pub by_key_algorithm: std::collections::BTreeMap<String, i64>,
    pub by_issuing_ca: std::collections::BTreeMap<String, i64>,
    pub by_enrollment_method: std::collections::BTreeMap<String, i64>,
    pub expiring_within_7_days: i64,
    pub expiring_within_30_days: i64,
    pub expiring_within_90_days: i64,
}

/// Per-authority signing configuration exposed by the CA signing-config route.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredCaSigningConfig {
    pub certificate_authority_id: String,
    pub organization_id: String,
    pub kind: String,
    pub key_algorithm: String,
    pub key_source: String,
    pub hsm_connector_id: Option<String>,
    pub hsm_key_label: Option<String>,
    pub path_len: Option<i64>,
    pub crl_enabled: bool,
    pub crl_mirrors_json: Option<String>,
    pub parent_id: Option<String>,
    pub pending_csr_pem: Option<String>,
    pub version: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredCertificateRevocation {
    pub id: String,
    pub organization_id: String,
    pub certificate_id: String,
    pub ca_id: String,
    pub serial: String,
    pub reason_code: i64,
    pub revoked_at: String,
    pub crl_number: Option<i64>,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// Signed CRL state for one authority. The DER body is sealed at rest.
#[derive(Clone, PartialEq, Eq)]
pub struct StoredCrlState {
    pub id: String,
    pub organization_id: String,
    pub ca_id: String,
    pub crl_number: i64,
    pub this_update: String,
    pub next_update: String,
    pub sealed_der: Option<SealedCertificateMaterial>,
    pub mirror_urls_json: Option<String>,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

impl std::fmt::Debug for StoredCrlState {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("StoredCrlState")
            .field("id", &self.id)
            .field("organization_id", &self.organization_id)
            .field("ca_id", &self.ca_id)
            .field("crl_number", &self.crl_number)
            .field("this_update", &self.this_update)
            .field("next_update", &self.next_update)
            .field("sealed_der", &"[REDACTED]")
            .field("mirror_urls_json", &self.mirror_urls_json)
            .field("version", &self.version)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredDiscoveryJob {
    pub id: String,
    pub organization_id: String,
    pub name: String,
    pub description: Option<String>,
    pub targets_json: String,
    pub ports_json: String,
    pub auto_scan: bool,
    pub scan_interval_days: Option<i64>,
    pub gateway_ref: Option<String>,
    pub allow_internal: bool,
    pub last_scan_at: Option<String>,
    pub status: String,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredDiscoveryInstallation {
    pub id: String,
    pub organization_id: String,
    pub job_id: String,
    pub host: String,
    pub port: i64,
    pub fingerprint_sha256: String,
    pub cn: Option<String>,
    pub issuer: Option<String>,
    pub not_after: Option<String>,
    pub first_seen_at: String,
    pub last_seen_at: String,
    pub change_log_json: String,
    pub matched_certificate_id: Option<String>,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredApprovalPolicy {
    pub id: String,
    pub organization_id: String,
    pub scope: String,
    pub application_id: Option<String>,
    pub signer_id: Option<String>,
    pub name: String,
    pub max_request_ttl_seconds: Option<i64>,
    pub machine_bypass: bool,
    pub covers_json: String,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredApprovalStep {
    pub id: String,
    pub organization_id: String,
    pub policy_id: String,
    pub seq: i64,
    pub name: String,
    pub approvers_json: String,
    pub required_count: i64,
    pub notify: bool,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredApprovalRequest {
    pub id: String,
    pub organization_id: String,
    pub policy_id: String,
    pub kind: String,
    pub requester: String,
    pub status: String,
    pub current_step: i64,
    pub expires_at: String,
    pub payload_digest: String,
    pub scope_json: String,
    pub result_id: Option<String>,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredApprovalDecision {
    pub id: String,
    pub organization_id: String,
    pub request_id: String,
    pub step_seq: i64,
    pub approver: String,
    pub decision: String,
    pub comment: Option<String>,
    pub decided_at: String,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// A code signer. A sealed signing key never renders through `Debug`.
#[derive(Clone, PartialEq, Eq)]
pub struct StoredSigner {
    pub id: String,
    pub organization_id: String,
    pub name: String,
    pub certificate_id: Option<String>,
    pub key_source: String,
    pub hsm_connector_id: Option<String>,
    pub hsm_key_label: Option<String>,
    pub status: String,
    pub auto_renew: bool,
    pub renew_before_seconds: Option<i64>,
    pub sealed_key: Option<SealedCertificateMaterial>,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

impl std::fmt::Debug for StoredSigner {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("StoredSigner")
            .field("id", &self.id)
            .field("organization_id", &self.organization_id)
            .field("name", &self.name)
            .field("certificate_id", &self.certificate_id)
            .field("key_source", &self.key_source)
            .field("hsm_connector_id", &self.hsm_connector_id)
            .field("hsm_key_label", &self.hsm_key_label)
            .field("status", &self.status)
            .field("auto_renew", &self.auto_renew)
            .field("renew_before_seconds", &self.renew_before_seconds)
            .field("sealed_key", &"[REDACTED]")
            .field("version", &self.version)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredSignerMember {
    pub id: String,
    pub organization_id: String,
    pub signer_id: String,
    pub subject: String,
    pub role: String,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredSigningAccessRecord {
    pub id: String,
    pub organization_id: String,
    pub signer_id: String,
    pub approval_request_id: Option<String>,
    pub status: String,
    pub signatures_allowed: Option<i64>,
    pub signatures_used: i64,
    pub window_expires_at: Option<String>,
    pub scope_json: String,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredSigningEvent {
    pub id: String,
    pub organization_id: String,
    pub signer_id: String,
    pub access_record_id: Option<String>,
    pub outcome: String,
    pub command: Option<String>,
    pub application_name: Option<String>,
    pub application_sha256: Option<String>,
    pub hostname: Option<String>,
    pub os_username: Option<String>,
    pub ip: Option<String>,
    pub data_hash: Option<String>,
    pub occurred_at: String,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredCertAlert {
    pub id: String,
    pub organization_id: String,
    pub application_id: String,
    pub alert_type: String,
    pub before_window_seconds: Option<i64>,
    pub daily_reminder: bool,
    pub channels_json: String,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredAlertDelivery {
    pub id: String,
    pub organization_id: String,
    pub alert_id: String,
    pub channel: String,
    pub outcome: String,
    pub attempts: i64,
    pub last_attempt_at: Option<String>,
    pub payload_digest: String,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredCertSync {
    pub id: String,
    pub organization_id: String,
    pub certificate_id: String,
    pub destination_kind: String,
    pub connection_id: String,
    pub name_schema: String,
    pub remove_on_expiry: bool,
    pub include_root: bool,
    pub options_json: String,
    pub enabled: bool,
    pub last_run_at: Option<String>,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredSyncRun {
    pub id: String,
    pub organization_id: String,
    pub sync_id: String,
    pub outcome: String,
    pub detail: Option<String>,
    pub ran_at: String,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// An HSM partition binding. The PIN is ciphertext only and never rendered.
#[derive(Clone, PartialEq, Eq)]
pub struct StoredHsmConnector {
    pub id: String,
    pub organization_id: String,
    pub label: String,
    pub sealed_pin: Option<SealedCertificateMaterial>,
    pub module_hint: String,
    pub key_label_prefix: Option<String>,
    pub gateway_ref: Option<String>,
    pub status: String,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

impl std::fmt::Debug for StoredHsmConnector {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("StoredHsmConnector")
            .field("id", &self.id)
            .field("organization_id", &self.organization_id)
            .field("label", &self.label)
            .field("sealed_pin", &"[REDACTED]")
            .field("module_hint", &self.module_hint)
            .field("key_label_prefix", &self.key_label_prefix)
            .field("gateway_ref", &self.gateway_ref)
            .field("status", &self.status)
            .field("version", &self.version)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredExternalCaConfig {
    pub id: String,
    pub organization_id: String,
    pub kind: String,
    pub connection_id: String,
    pub config_json: String,
    pub trust_class: String,
    pub auto_renew: bool,
    pub renew_before_seconds: Option<i64>,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredAcmeAccount {
    pub id: String,
    pub organization_id: String,
    pub profile_id: String,
    pub jwk_thumbprint: String,
    pub eab_kid: Option<String>,
    pub status: String,
    pub contacts_json: String,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredAcmeOrder {
    pub id: String,
    pub organization_id: String,
    pub account_id: String,
    pub status: String,
    pub identifiers_json: String,
    pub expires_at: String,
    pub finalize_csr_pem: Option<String>,
    pub certificate_id: Option<String>,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredAcmeChallenge {
    pub id: String,
    pub organization_id: String,
    pub order_id: String,
    pub authz_id: String,
    pub challenge_type: String,
    pub token: String,
    pub status: String,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// EST enrollment configuration. The bootstrap passphrase is sealed at rest.
#[derive(Clone, PartialEq, Eq)]
pub struct StoredEstConfig {
    pub id: String,
    pub organization_id: String,
    pub profile_id: String,
    pub sealed_passphrase: Option<SealedCertificateMaterial>,
    pub bootstrap_chain_pem: Option<String>,
    pub require_bootstrap: bool,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

impl std::fmt::Debug for StoredEstConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("StoredEstConfig")
            .field("id", &self.id)
            .field("organization_id", &self.organization_id)
            .field("profile_id", &self.profile_id)
            .field("sealed_passphrase", &"[REDACTED]")
            .field("require_bootstrap", &self.require_bootstrap)
            .field("version", &self.version)
            .finish_non_exhaustive()
    }
}

/// SCEP enrollment configuration. The static challenge is sealed at rest.
#[derive(Clone, PartialEq, Eq)]
pub struct StoredScepConfig {
    pub id: String,
    pub organization_id: String,
    pub profile_id: String,
    pub challenge_mode: String,
    pub sealed_static_secret: Option<SealedCertificateMaterial>,
    pub ra_signs_with_ca: bool,
    pub include_ca_cert: bool,
    pub allow_cert_renewal: bool,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

impl std::fmt::Debug for StoredScepConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("StoredScepConfig")
            .field("id", &self.id)
            .field("organization_id", &self.organization_id)
            .field("profile_id", &self.profile_id)
            .field("challenge_mode", &self.challenge_mode)
            .field("sealed_static_secret", &"[REDACTED]")
            .field("ra_signs_with_ca", &self.ra_signs_with_ca)
            .field("include_ca_cert", &self.include_ca_cert)
            .field("allow_cert_renewal", &self.allow_cert_renewal)
            .field("version", &self.version)
            .finish_non_exhaustive()
    }
}

/// A minted, single-use SCEP challenge. Only the hash of the challenge is
/// stored; the plaintext challenge is handed to the operator once and never
/// persisted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredScepChallenge {
    pub id: String,
    pub organization_id: String,
    pub config_id: String,
    pub challenge_hash: String,
    pub expires_at: String,
    pub consumed_at: Option<String>,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// Receipt evidence plus the authoritative organization resolved through its
/// invocation and intent. Legacy signed bodies may omit the organization; the
/// join supplies authorization context without changing the signed bytes.
pub struct StoredReceipt {
    pub receipt: InvocationReceipt,
    pub organization_id: OrganizationId,
}

fn decode_receipt_for_organization(
    body: &str,
    organization_id: &str,
) -> anyhow::Result<StoredReceipt> {
    let receipt: InvocationReceipt = serde_json::from_str(body)?;
    let organization_id = OrganizationId::parse(organization_id)?;
    if receipt
        .organization_id
        .is_some_and(|claimed| claimed != organization_id)
    {
        anyhow::bail!("receipt organization does not match invocation intent");
    }
    Ok(StoredReceipt {
        receipt,
        organization_id,
    })
}

/// Embedded schema versions, applied in order, once each. Appending is the only
/// permitted edit: an applied version is never rewritten.
const MIGRATIONS: &[(&str, &str)] = &[
    (
        "0001_init",
        include_str!("../../../migrations/0001_init.sql"),
    ),
    (
        "0002_connections",
        include_str!("../../../migrations/0002_connections.sql"),
    ),
    (
        "0003_connection_owner",
        include_str!("../../../migrations/0003_connection_owner.sql"),
    ),
    (
        "0004_integrations",
        include_str!("../../../migrations/0004_integrations.sql"),
    ),
    (
        "0005_credential_generation",
        include_str!("../../../migrations/0005_credential_generation.sql"),
    ),
    (
        "0006_provider_configuration",
        include_str!("../../../migrations/0006_provider_configuration.sql"),
    ),
    (
        "0007_provider_connections",
        include_str!("../../../migrations/0007_provider_connections.sql"),
    ),
    (
        "0008_backup_outbox",
        include_str!("../../../migrations/0008_backup_outbox.sql"),
    ),
    (
        "0009_host_kv",
        include_str!("../../../migrations/0009_host_kv.sql"),
    ),
    (
        "0010_connection_materialization",
        include_str!("../../../migrations/0010_connection_materialization.sql"),
    ),
    (
        "0011_attachment_targets",
        include_str!("../../../migrations/0011_attachment_targets.sql"),
    ),
    (
        "0012_connection_delegations",
        include_str!("../../../migrations/0012_connection_delegations.sql"),
    ),
    (
        "0013_certificate_issuance",
        include_str!("../../../migrations/0013_certificate_issuance.sql"),
    ),
    (
        "0014_custom_providers",
        include_str!("../../../migrations/0014_custom_providers.sql"),
    ),
    (
        "0015_backup_target_kinds",
        include_str!("../../../migrations/0015_backup_target_kinds.sql"),
    ),
    (
        "0016_certificate_manager",
        include_str!("../../../migrations/0016_certificate_manager.sql"),
    ),
    (
        "0017_lifecycle_hooks",
        include_str!("../../../migrations/0017_lifecycle_hooks.sql"),
    ),
    (
        "0018_rotation_leases",
        include_str!("../../../migrations/0018_rotation_leases.sql"),
    ),
];

/// Embedded migration versions in the order they are applied.
///
/// Exposed so contract tests can pin the append-only ordering without reaching
/// into the embedded SQL itself.
#[must_use]
pub fn migration_versions() -> Vec<&'static str> {
    MIGRATIONS.iter().map(|(version, _)| *version).collect()
}

impl Db {
    /// Connect to `SQLite` and apply all pending embedded migrations.
    ///
    /// # Errors
    ///
    /// Returns an error when the database cannot be opened or migrated.
    pub async fn connect_sqlite(url: &str) -> anyhow::Result<Self> {
        let pool = SqlitePoolOptions::new()
            .max_connections(if url == "sqlite::memory:" { 1 } else { 5 })
            .connect(url)
            .await?;
        let db = Self { pool };
        db.migrate().await?;
        Ok(db)
    }

    /// Open a migrated, process-local `SQLite` database.
    ///
    /// # Errors
    ///
    /// Returns an error when `SQLite` initialization or migration fails.
    pub async fn connect_memory() -> anyhow::Result<Self> {
        Self::connect_sqlite("sqlite::memory:").await
    }

    /// Apply each unapplied embedded migration atomically and in order.
    ///
    /// # Errors
    ///
    /// Returns an error when migration state cannot be read or a migration
    /// transaction cannot be completed.
    pub async fn migrate(&self) -> anyhow::Result<()> {
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
        )
        .execute(&self.pool)
        .await
        .context("creating schema_migrations")?;

        for (version, sql) in MIGRATIONS {
            if self.migration_applied(version).await? {
                continue;
            }
            // A version lands whole or not at all, so a failure mid-file cannot
            // leave a database that reports itself migrated.
            let mut tx = self.pool.begin().await?;
            for stmt in split_statements(sql) {
                sqlx::query(&stmt)
                    .execute(&mut *tx)
                    .await
                    .with_context(|| format!("migration {version}: {stmt}"))?;
            }
            sqlx::query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
                .bind(version)
                .bind(Utc::now().to_rfc3339())
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            tracing::info!(migration = version, "schema migration applied");
        }
        Ok(())
    }

    /// List embedded migration versions already recorded by the database.
    ///
    /// # Errors
    ///
    /// Returns an error when migration records cannot be queried.
    pub async fn applied_migrations(&self) -> anyhow::Result<Vec<String>> {
        let rows = sqlx::query("SELECT version FROM schema_migrations ORDER BY version ASC")
            .fetch_all(&self.pool)
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| r.get::<String, _>("version"))
            .collect())
    }

    async fn migration_applied(&self, version: &str) -> anyhow::Result<bool> {
        let row = sqlx::query("SELECT 1 AS present FROM schema_migrations WHERE version = ?")
            .bind(version)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.is_some())
    }

    #[must_use]
    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    /// Report whether the authority is both quorate and unsealed.
    ///
    /// # Errors
    ///
    /// Returns an error when authority health cannot be queried.
    pub async fn authority_quorum_ok(&self) -> anyhow::Result<bool> {
        let row = sqlx::query("SELECT quorum_ok, sealed FROM authority_health WHERE id = 1")
            .fetch_one(&self.pool)
            .await?;
        let quorum_ok: i64 = row.get("quorum_ok");
        let sealed: i64 = row.get("sealed");
        Ok(quorum_ok == 1 && sealed == 0)
    }

    /// Update the persisted authority quorum state.
    ///
    /// # Errors
    ///
    /// Returns an error when the health row cannot be updated.
    pub async fn set_authority_quorum(&self, ok: bool) -> anyhow::Result<()> {
        sqlx::query("UPDATE authority_health SET quorum_ok = ?, updated_at = ? WHERE id = 1")
            .bind(i32::from(ok))
            .bind(Utc::now().to_rfc3339())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Persist a new organization.
    ///
    /// # Errors
    ///
    /// Returns an error when the organization violates database constraints or
    /// cannot be inserted.
    pub async fn create_organization(&self, id: &OrganizationId, name: &str) -> anyhow::Result<()> {
        sqlx::query("INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)")
            .bind(id.to_string())
            .bind(name)
            .bind(Utc::now().to_rfc3339())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Persist a project belonging to an organization.
    ///
    /// # Errors
    ///
    /// Returns an error when the organization is absent, constraints fail, or
    /// the project cannot be inserted.
    pub async fn create_project(
        &self,
        id: &ProjectId,
        org: &OrganizationId,
        name: &str,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO projects (id, organization_id, name, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind(id.to_string())
        .bind(org.to_string())
        .bind(name)
        .bind(Utc::now().to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Validate and atomically persist a provider connection.
    ///
    /// # Errors
    ///
    /// Returns an error when public configuration is unsafe, serialization
    /// fails, or the transaction cannot be committed.
    pub async fn insert_connection(&self, connection: &ConnectionRecord) -> anyhow::Result<()> {
        connection
            .assert_public_config_safe()
            .map_err(anyhow::Error::msg)?;
        let mut transaction = self.pool.begin().await?;
        // Organization membership is established by Identity before Host mints
        // the session. Materialize that trusted tenant locally so the provider
        // connection can satisfy Host's foreign-key boundary.
        sqlx::query("INSERT OR IGNORE INTO organizations (id, name, created_at) VALUES (?, ?, ?)")
            .bind(connection.organization_id.to_string())
            .bind(connection.organization_id.to_string())
            .bind(Utc::now().to_rfc3339())
            .execute(&mut *transaction)
            .await?;
        sqlx::query(
            "INSERT INTO provider_connections (id, organization_id, project_id, provider_id, display_name, body_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(connection.id.to_string())
        .bind(connection.organization_id.to_string())
        .bind(connection.project_id.map(|id| id.to_string()))
        .bind(&connection.provider_id)
        .bind(&connection.display_name)
        .bind(serde_json::to_string(connection)?)
        .bind(connection.created_at.to_rfc3339())
        .bind(connection.updated_at.to_rfc3339())
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(())
    }

    /// Validate and update an organization-scoped provider connection.
    ///
    /// # Errors
    ///
    /// Returns an error when public configuration is unsafe, serialization
    /// fails, or the database update fails.
    pub async fn update_connection(&self, connection: &ConnectionRecord) -> anyhow::Result<bool> {
        connection
            .assert_public_config_safe()
            .map_err(anyhow::Error::msg)?;
        let result = sqlx::query(
            "UPDATE provider_connections SET provider_id = ?, display_name = ?, body_json = ?, updated_at = ? WHERE id = ? AND organization_id = ?",
        )
        .bind(&connection.provider_id)
        .bind(&connection.display_name)
        .bind(serde_json::to_string(connection)?)
        .bind(connection.updated_at.to_rfc3339())
        .bind(connection.id.to_string())
        .bind(connection.organization_id.to_string())
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Read one organization-scoped provider connection.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or stored JSON is invalid.
    pub async fn get_connection(
        &self,
        organization_id: &OrganizationId,
        id: &ConnectionId,
    ) -> anyhow::Result<Option<ConnectionRecord>> {
        let row = sqlx::query(
            "SELECT body_json FROM provider_connections WHERE id = ? AND organization_id = ?",
        )
        .bind(id.to_string())
        .bind(organization_id.to_string())
        .fetch_optional(&self.pool)
        .await?;
        row.map(|row| serde_json::from_str(&row.get::<String, _>("body_json")))
            .transpose()
            .map_err(Into::into)
    }

    /// List provider connections belonging to one organization.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or any stored connection is invalid.
    pub async fn list_connections(
        &self,
        organization_id: &OrganizationId,
    ) -> anyhow::Result<Vec<ConnectionRecord>> {
        let rows = sqlx::query(
            "SELECT body_json FROM provider_connections WHERE organization_id = ? ORDER BY created_at, id",
        )
        .bind(organization_id.to_string())
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| serde_json::from_str(&row.get::<String, _>("body_json")).map_err(Into::into))
            .collect()
    }

    /// Delete one organization-scoped provider connection.
    ///
    /// # Errors
    ///
    /// Returns an error when the database deletion fails.
    pub async fn delete_connection(
        &self,
        organization_id: &OrganizationId,
        id: &ConnectionId,
    ) -> anyhow::Result<bool> {
        let result =
            sqlx::query("DELETE FROM provider_connections WHERE id = ? AND organization_id = ?")
                .bind(id.to_string())
                .bind(organization_id.to_string())
                .execute(&self.pool)
                .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Persist an authorization grant.
    ///
    /// # Errors
    ///
    /// Returns an error when serialization or insertion fails.
    pub async fn insert_grant(&self, grant: &Grant) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO grants (id, organization_id, body_json, revoked_at, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(grant.id.to_string())
        .bind(grant.organization_id.to_string())
        .bind(serde_json::to_string(grant)?)
        .bind(grant.revoked_at.map(|t| t.to_rfc3339()))
        .bind(grant.created_at.to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Find a grant by identifier, applying the authoritative revocation column.
    ///
    /// # Errors
    ///
    /// Returns an error when the query or stored grant cannot be decoded.
    pub async fn find_grant(&self, id: &GrantId) -> anyhow::Result<Option<Grant>> {
        let row = sqlx::query("SELECT body_json, revoked_at FROM grants WHERE id = ?")
            .bind(id.to_string())
            .fetch_optional(&self.pool)
            .await?;
        let Some(row) = row else { return Ok(None) };
        let mut grant: Grant = serde_json::from_str(&row.get::<String, _>("body_json"))?;
        // The column is the authority on revocation: `revoke_grant` writes it
        // without rewriting body_json, so a stale body must not resurrect a
        // revoked grant.
        if let Some(revoked) = row.get::<Option<String>, _>("revoked_at") {
            grant.revoked_at = grant.revoked_at.or_else(|| {
                chrono::DateTime::parse_from_rfc3339(&revoked)
                    .ok()
                    .map(|t| t.with_timezone(&chrono::Utc))
            });
        }
        Ok(Some(grant))
    }

    /// Revoke a live grant once.
    ///
    /// # Errors
    ///
    /// Returns an error when the update fails.
    pub async fn revoke_grant(
        &self,
        id: &GrantId,
        at: chrono::DateTime<chrono::Utc>,
    ) -> anyhow::Result<bool> {
        let result =
            sqlx::query("UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
                .bind(at.to_rfc3339())
                .bind(id.to_string())
                .execute(&self.pool)
                .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Assert every hop of a delegation chain is live, walking `parent_grant_id`
    /// up from `grant` to the root. Ancestor revocation must kill descendants:
    /// a child that stayed "active" after its parent died would be authority
    /// that outlived the thing it narrowed (ADR 0044 decision 8).
    ///
    /// # Errors
    ///
    /// Returns an error when a grant is inactive, missing, malformed, or cyclic.
    pub async fn assert_grant_chain_active(
        &self,
        grant: &Grant,
        now: chrono::DateTime<chrono::Utc>,
    ) -> anyhow::Result<()> {
        grant.assert_active(now)?;
        let mut cursor = grant.parent_grant_id;
        // Bounded walk: depth is validated at mint, but a storage cycle must
        // fail closed rather than spin.
        for _ in 0..16 {
            let Some(parent_id) = cursor else {
                return Ok(());
            };
            let parent = self
                .find_grant(&parent_id)
                .await?
                .ok_or_else(|| anyhow::anyhow!("delegation chain hop missing: {parent_id}"))?;
            parent.assert_active(now)?;
            cursor = parent.parent_grant_id;
        }
        anyhow::bail!("delegation chain too deep to verify")
    }

    /// Persist an invocation intent and its idempotency key.
    ///
    /// # Errors
    ///
    /// Returns an error when serialization or insertion fails.
    pub async fn insert_intent(&self, intent: &Intent) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO intents (id, organization_id, body_json, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(intent.id.to_string())
        .bind(intent.organization_id.to_string())
        .bind(serde_json::to_string(intent)?)
        .bind(&intent.idempotency_key)
        .bind(intent.issued_at.to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Persist an invocation attempt.
    ///
    /// # Errors
    ///
    /// Returns an error when serialization or insertion fails.
    pub async fn insert_invocation(&self, inv: &Invocation) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO invocations (id, intent_id, state, attempt, lease_owner, lease_expires_at, body_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(inv.id.to_string())
        .bind(inv.intent_id.to_string())
        .bind(format!("{:?}", inv.state).to_lowercase())
        .bind(i64::from(inv.attempt))
        .bind(&inv.lease_owner)
        .bind(inv.lease_expires_at.map(|t| t.to_rfc3339()))
        .bind(serde_json::to_string(inv)?)
        .bind(inv.created_at.to_rfc3339())
        .bind(inv.updated_at.to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Persist a signed invocation receipt.
    ///
    /// # Errors
    ///
    /// Returns an error when serialization or insertion fails.
    pub async fn insert_receipt(&self, receipt: &InvocationReceipt) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO receipts (id, invocation_id, body_json, signature, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(receipt.id.to_string())
        .bind(receipt.invocation_id.to_string())
        .bind(serde_json::to_string(receipt)?)
        .bind(&receipt.signature)
        .bind(receipt.completed_at.to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Read a receipt with its authoritative organization binding.
    ///
    /// # Errors
    ///
    /// Returns an error when the query or decoding fails, including when a
    /// receipt claims a different organization from its intent.
    pub async fn get_receipt(
        &self,
        id: &opensesame_domain::ReceiptId,
    ) -> anyhow::Result<Option<StoredReceipt>> {
        let keyed = id.to_string();
        let bare = id.as_uuid().to_string();
        let row = sqlx::query(
            r"
            SELECT r.body_json, i.organization_id AS authoritative_organization_id
            FROM receipts r
            JOIN invocations inv ON inv.id = r.invocation_id
            JOIN intents i ON i.id = inv.intent_id
            WHERE r.id = ? OR r.id = ?
            ",
        )
        .bind(&keyed)
        .bind(&bare)
        .fetch_optional(&self.pool)
        .await?;
        Ok(match row {
            Some(r) => {
                let body: String = r.get("body_json");
                let organization_id: String = r.get("authoritative_organization_id");
                Some(decode_receipt_for_organization(&body, &organization_id)?)
            }
            None => None,
        })
    }

    /// Count invocation rows for an intent.
    ///
    /// # Errors
    ///
    /// Returns an error when the count query fails.
    pub async fn count_invocations_for_intent(
        &self,
        intent_id: &opensesame_domain::IntentId,
    ) -> anyhow::Result<i64> {
        let row = sqlx::query("SELECT COUNT(*) as c FROM invocations WHERE intent_id = ?")
            .bind(intent_id.to_string())
            .fetch_one(&self.pool)
            .await?;
        Ok(row.get::<i64, _>("c"))
    }

    /// Count all persisted receipts.
    ///
    /// # Errors
    ///
    /// Returns an error when the count query fails.
    pub async fn count_receipts(&self) -> anyhow::Result<i64> {
        let row = sqlx::query("SELECT COUNT(*) as c FROM receipts")
            .fetch_one(&self.pool)
            .await?;
        Ok(row.get::<i64, _>("c"))
    }

    /// Find the first receipt for an organization-scoped idempotency key.
    ///
    /// # Errors
    ///
    /// Returns an error when querying or decoding fails, including an invalid
    /// receipt organization binding.
    pub async fn find_receipt_by_idempotency(
        &self,
        org: &OrganizationId,
        key: &str,
    ) -> anyhow::Result<Option<InvocationReceipt>> {
        let row = sqlx::query(
            r"
            SELECT r.body_json, i.organization_id AS authoritative_organization_id
            FROM receipts r
            JOIN invocations inv ON inv.id = r.invocation_id
            JOIN intents i ON i.id = inv.intent_id
            WHERE i.organization_id = ? AND i.idempotency_key = ?
            ORDER BY r.created_at ASC
            LIMIT 1
            ",
        )
        .bind(org.to_string())
        .bind(key)
        .fetch_optional(&self.pool)
        .await?;
        Ok(match row {
            Some(r) => {
                let body: String = r.get("body_json");
                let organization_id: String = r.get("authoritative_organization_id");
                Some(decode_receipt_for_organization(&body, &organization_id)?.receipt)
            }
            None => None,
        })
    }

    /// Find an intent by organization and idempotency key.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or stored intent JSON is invalid.
    pub async fn find_intent_by_idempotency(
        &self,
        org: &OrganizationId,
        key: &str,
    ) -> anyhow::Result<Option<Intent>> {
        let row = sqlx::query(
            "SELECT body_json FROM intents WHERE organization_id = ? AND idempotency_key = ?",
        )
        .bind(org.to_string())
        .bind(key)
        .fetch_optional(&self.pool)
        .await?;
        Ok(match row {
            Some(r) => {
                let body: String = r.get("body_json");
                Some(serde_json::from_str(&body)?)
            }
            None => None,
        })
    }

    /// Atomically persist an encrypted item revision and its outbox event.
    ///
    /// # Errors
    ///
    /// Returns an error when insertion, outbox creation, or transaction commit
    /// fails.
    pub async fn insert_encrypted_item(
        &self,
        vault_id: &str,
        item_id: &str,
        revision: i64,
        ciphertext: &[u8],
        wrapping_json: &str,
        ad_digest: &str,
    ) -> anyhow::Result<()> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO encrypted_item_revisions (id, vault_id, item_id, revision, envelope_version, ciphertext, wrapping_json, ad_digest, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)",
        )
        .bind(uuid::Uuid::now_v7().to_string())
        .bind(vault_id)
        .bind(item_id)
        .bind(revision)
        .bind(ciphertext)
        .bind(wrapping_json)
        .bind(ad_digest)
        .bind(Utc::now().to_rfc3339())
        .execute(&mut *transaction)
        .await?;
        append_outbox_tx(
            &mut transaction,
            "vault.item_revision.written",
            &serde_json::json!({
                "vault_id": vault_id,
                "item_id": item_id,
                "revision": revision,
            })
            .to_string(),
        )
        .await?;
        transaction.commit().await?;
        Ok(())
    }

    /// Atomically write an owner-scoped encrypted sync blob and outbox event.
    ///
    /// # Errors
    ///
    /// Returns an error when the epoch exceeds `SQLite`'s range or a database
    /// transaction fails.
    pub async fn write_sync_blob(
        &self,
        owner_id: &str,
        blob: &StoredSyncBlob,
        store_limit: i64,
        owner_limit: i64,
    ) -> anyhow::Result<SyncWriteOutcome> {
        let outcomes = self
            .write_sync_blobs(
                owner_id,
                std::slice::from_ref(blob),
                store_limit,
                owner_limit,
            )
            .await?;
        outcomes
            .into_iter()
            .next()
            .context("single sync write produced no outcome")
    }

    /// Atomically write a related set of opaque sync blobs.
    ///
    /// If any member conflicts or exceeds quota, no member is written. This
    /// keeps a sealed vault header/body pair at one epoch and gives clients a
    /// reliable pull-merge-retry boundary.
    ///
    /// # Errors
    ///
    /// Returns an error when an epoch exceeds `SQLite`'s range or the database
    /// transaction fails.
    pub async fn write_sync_blobs(
        &self,
        owner_id: &str,
        blobs: &[StoredSyncBlob],
        store_limit: i64,
        owner_limit: i64,
    ) -> anyhow::Result<Vec<SyncWriteOutcome>> {
        if blobs.is_empty() {
            return Ok(Vec::new());
        }
        let epochs = blobs
            .iter()
            .map(|blob| i64::try_from(blob.epoch).context("sync epoch exceeds SQLite range"))
            .collect::<anyhow::Result<Vec<_>>>()?;
        let mut transaction = self.pool.begin().await?;
        let store_count: i64 = sqlx::query("SELECT COUNT(*) AS count FROM encrypted_sync_blobs")
            .fetch_one(&mut *transaction)
            .await?
            .get("count");
        let owner_count: i64 =
            sqlx::query("SELECT COUNT(*) AS count FROM encrypted_sync_blobs WHERE owner_id = ?")
                .bind(owner_id)
                .fetch_one(&mut *transaction)
                .await?
                .get("count");

        let mut outcomes = Vec::with_capacity(blobs.len());
        let mut existing = Vec::with_capacity(blobs.len());
        let mut new_count = 0i64;
        for (index, blob) in blobs.iter().enumerate() {
            // ponytail: batches are capped at 64 by the route; a linear scan is
            // smaller than another set allocation. Replace if that cap grows.
            if blobs[..index].iter().any(|prior| prior.id == blob.id) {
                outcomes.push(SyncWriteOutcome::BatchAborted);
                existing.push(false);
                continue;
            }
            let row = sqlx::query("SELECT owner_id, epoch FROM encrypted_sync_blobs WHERE id = ?")
                .bind(&blob.id)
                .fetch_optional(&mut *transaction)
                .await?;
            let outcome = match row {
                Some(ref row) if row.get::<String, _>("owner_id") != owner_id => {
                    SyncWriteOutcome::ForeignOwner
                }
                Some(ref row) if row.get::<i64, _>("epoch") >= epochs[index] => {
                    SyncWriteOutcome::StaleEpoch
                }
                Some(_) => SyncWriteOutcome::Accepted,
                None if store_count + new_count >= store_limit => SyncWriteOutcome::StoreFull,
                None if owner_count + new_count >= owner_limit => SyncWriteOutcome::OwnerQuota,
                None => {
                    new_count += 1;
                    SyncWriteOutcome::Accepted
                }
            };
            existing.push(row.is_some());
            outcomes.push(outcome);
        }

        if outcomes
            .iter()
            .any(|outcome| *outcome != SyncWriteOutcome::Accepted)
        {
            for outcome in outcomes
                .iter_mut()
                .filter(|outcome| **outcome == SyncWriteOutcome::Accepted)
            {
                *outcome = SyncWriteOutcome::BatchAborted;
            }
            return Ok(outcomes);
        }

        let updated_at = Utc::now().to_rfc3339();
        for ((blob, epoch), exists) in blobs.iter().zip(epochs).zip(existing) {
            if exists {
                sqlx::query(
                    "UPDATE encrypted_sync_blobs SET epoch = ?, ciphertext = ?, updated_at = ? WHERE id = ? AND owner_id = ?",
                )
                .bind(epoch)
                .bind(&blob.ciphertext)
                .bind(&updated_at)
                .bind(&blob.id)
                .bind(owner_id)
                .execute(&mut *transaction)
                .await?;
            } else {
                sqlx::query(
                    "INSERT INTO encrypted_sync_blobs (id, owner_id, epoch, ciphertext, updated_at) VALUES (?, ?, ?, ?, ?)",
                )
                .bind(&blob.id)
                .bind(owner_id)
                .bind(epoch)
                .bind(&blob.ciphertext)
                .bind(&updated_at)
                .execute(&mut *transaction)
                .await?;
            }
            append_sync_blob_outbox(&mut transaction, owner_id, &blob.id, epoch).await?;
        }
        transaction.commit().await?;
        Ok(outcomes)
    }

    /// List owner-scoped encrypted sync blobs newer than `since_epoch`.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or a stored epoch is negative.
    pub async fn list_sync_blobs(
        &self,
        owner_id: &str,
        since_epoch: u64,
    ) -> anyhow::Result<Vec<StoredSyncBlob>> {
        let Ok(since_epoch) = i64::try_from(since_epoch) else {
            return Ok(vec![]);
        };
        let rows = sqlx::query(
            "SELECT id, epoch, ciphertext FROM encrypted_sync_blobs WHERE owner_id = ? AND epoch > ? ORDER BY epoch, id",
        )
        .bind(owner_id)
        .bind(since_epoch)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(StoredSyncBlob {
                    id: row.get("id"),
                    epoch: db_u64(row.get("epoch"), "sync epoch")?,
                    ciphertext: row.get("ciphertext"),
                })
            })
            .collect()
    }

    /// Count all encrypted sync blobs.
    ///
    /// # Errors
    ///
    /// Returns an error when the count query fails.
    pub async fn count_sync_blobs(&self) -> anyhow::Result<i64> {
        Ok(
            sqlx::query("SELECT COUNT(*) AS count FROM encrypted_sync_blobs")
                .fetch_one(&self.pool)
                .await?
                .get("count"),
        )
    }

    /// Advance an owner/device sync cursor without allowing it to move backward.
    ///
    /// # Errors
    ///
    /// Returns an error when the epoch exceeds `SQLite`'s range, database access
    /// fails, or a stored cursor is negative.
    pub async fn advance_sync_cursor(
        &self,
        owner_id: &str,
        device_id: &str,
        epoch: u64,
        max_cursors: i64,
    ) -> anyhow::Result<Option<u64>> {
        let epoch = i64::try_from(epoch).context("sync cursor exceeds SQLite range")?;
        let mut transaction = self.pool.begin().await?;
        let existing = sqlx::query(
            "SELECT epoch FROM sync_device_cursors WHERE owner_id = ? AND device_id = ?",
        )
        .bind(owner_id)
        .bind(device_id)
        .fetch_optional(&mut *transaction)
        .await?;
        if existing.is_none() {
            let count: i64 = sqlx::query("SELECT COUNT(*) AS count FROM sync_device_cursors")
                .fetch_one(&mut *transaction)
                .await?
                .get("count");
            if count >= max_cursors {
                return Ok(None);
            }
        }
        sqlx::query(
            "INSERT INTO sync_device_cursors (owner_id, device_id, epoch, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(owner_id, device_id) DO UPDATE SET epoch = MAX(epoch, excluded.epoch), updated_at = excluded.updated_at",
        )
        .bind(owner_id)
        .bind(device_id)
        .bind(epoch)
        .bind(Utc::now().to_rfc3339())
        .execute(&mut *transaction)
        .await?;
        let cursor = sqlx::query(
            "SELECT epoch FROM sync_device_cursors WHERE owner_id = ? AND device_id = ?",
        )
        .bind(owner_id)
        .bind(device_id)
        .fetch_one(&mut *transaction)
        .await?
        .get::<i64, _>("epoch");
        let cursor = db_u64(cursor, "sync cursor")?;
        transaction.commit().await?;
        Ok(Some(cursor))
    }

    // —— transactional outbox (ADR 0039) ————————————————————————

    /// Broadcast a change event in its own transaction. Mutations that already
    /// hold a transaction use [`append_outbox_tx`] instead, so the event and
    /// the change it describes commit or roll back together.
    ///
    /// # Errors
    ///
    /// Returns an error when the outbox row or transaction cannot be committed.
    pub async fn append_outbox(
        &self,
        event_type: &str,
        payload_json: &str,
    ) -> anyhow::Result<String> {
        let mut transaction = self.pool.begin().await?;
        let id = append_outbox_tx(&mut transaction, event_type, payload_json).await?;
        transaction.commit().await?;
        Ok(id)
    }

    /// Claim due unpublished events for one worker pass. Claimed rows have
    /// their `available_at` pushed `lease_seconds` into the future, so a
    /// crashed worker's claim expires instead of wedging the queue.
    ///
    /// # Errors
    ///
    /// Returns an error when due events cannot be queried, leased, or committed.
    pub async fn claim_outbox_batch(
        &self,
        limit: i64,
        lease_seconds: i64,
    ) -> anyhow::Result<Vec<OutboxEvent>> {
        let now = Utc::now();
        let mut transaction = self.pool.begin().await?;
        let rows = sqlx::query(
            "SELECT id, event_type, payload_json, created_at, attempts FROM outbox_events \
             WHERE published_at IS NULL AND (available_at IS NULL OR available_at <= ?) \
             ORDER BY created_at, id LIMIT ?",
        )
        .bind(now.to_rfc3339())
        .bind(limit)
        .fetch_all(&mut *transaction)
        .await?;
        let events: Vec<OutboxEvent> = rows
            .into_iter()
            .map(|row| OutboxEvent {
                id: row.get("id"),
                event_type: row.get("event_type"),
                payload_json: row.get("payload_json"),
                created_at: row.get("created_at"),
                attempts: row.get("attempts"),
            })
            .collect();
        if !events.is_empty() {
            let lease = (now + chrono::Duration::seconds(lease_seconds)).to_rfc3339();
            for event in &events {
                sqlx::query("UPDATE outbox_events SET available_at = ? WHERE id = ?")
                    .bind(&lease)
                    .bind(&event.id)
                    .execute(&mut *transaction)
                    .await?;
            }
        }
        transaction.commit().await?;
        Ok(events)
    }

    /// Mark selected outbox events as published in one transaction.
    ///
    /// # Errors
    ///
    /// Returns an error when an update or transaction commit fails.
    pub async fn mark_outbox_published(&self, ids: &[String]) -> anyhow::Result<()> {
        let now = Utc::now().to_rfc3339();
        let mut transaction = self.pool.begin().await?;
        for id in ids {
            sqlx::query(
                "UPDATE outbox_events SET published_at = ?, last_error = NULL WHERE id = ?",
            )
            .bind(&now)
            .bind(id)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        Ok(())
    }

    /// Compensation for a failed delivery: release the claim, count the
    /// attempt, and back the event off so retries do not spin.
    ///
    /// # Errors
    ///
    /// Returns an error when an update or transaction commit fails.
    pub async fn park_outbox(
        &self,
        ids: &[String],
        error: &str,
        backoff_seconds: i64,
    ) -> anyhow::Result<()> {
        let available = (Utc::now() + chrono::Duration::seconds(backoff_seconds)).to_rfc3339();
        let mut transaction = self.pool.begin().await?;
        for id in ids {
            sqlx::query(
                "UPDATE outbox_events SET available_at = ?, attempts = attempts + 1, last_error = ? \
                 WHERE id = ? AND published_at IS NULL",
            )
            .bind(&available)
            .bind(error)
            .bind(id)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        Ok(())
    }

    /// Terminal compensation for a poison event: record the failure and stop
    /// retrying. Full-snapshot resync reconciles whatever the event described.
    ///
    /// # Errors
    ///
    /// Returns an error when an update or transaction commit fails.
    pub async fn dead_letter_outbox(&self, ids: &[String], error: &str) -> anyhow::Result<()> {
        let now = Utc::now().to_rfc3339();
        let mut transaction = self.pool.begin().await?;
        for id in ids {
            sqlx::query(
                "UPDATE outbox_events SET published_at = ?, last_error = ? WHERE id = ? AND published_at IS NULL",
            )
            .bind(&now)
            .bind(error)
            .bind(id)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        Ok(())
    }

    /// Count outbox events that have not been published.
    ///
    /// # Errors
    ///
    /// Returns an error when the count query fails.
    pub async fn count_unpublished_outbox(&self) -> anyhow::Result<i64> {
        Ok(
            sqlx::query("SELECT COUNT(*) AS count FROM outbox_events WHERE published_at IS NULL")
                .fetch_one(&self.pool)
                .await?
                .get("count"),
        )
    }

    // —— certificate authority and issuance —————————————————————

    /// Insert a sealed certificate authority.
    ///
    /// # Errors
    ///
    /// Returns an error when validation, serialization, or persistence fails.
    pub async fn insert_certificate_authority(
        &self,
        authority: &StoredCertificateAuthority,
    ) -> anyhow::Result<()> {
        validate_sealed_material(&authority.sealed_material)?;
        if authority.is_default && authority.status != "active" {
            anyhow::bail!("only an active certificate authority may be default");
        }
        serde_json::from_str::<serde_json::Value>(&authority.public_metadata_json)
            .context("certificate authority public metadata is not valid JSON")?;
        let mut transaction = self.pool.begin().await?;
        sqlx::query("INSERT OR IGNORE INTO organizations (id, name, created_at) VALUES (?, ?, ?)")
            .bind(&authority.organization_id)
            .bind(&authority.organization_id)
            .bind(&authority.created_at)
            .execute(&mut *transaction)
            .await?;
        sqlx::query(
            "INSERT INTO certificate_authorities (id, organization_id, issuer_kind, issuer_connection_id, display_name, public_metadata_json, sealed_key_id, sealed_ciphertext, sealed_nonce, sealed_aad_digest, is_default, status, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&authority.id)
        .bind(&authority.organization_id)
        .bind(&authority.issuer_kind)
        .bind(&authority.issuer_connection_id)
        .bind(&authority.display_name)
        .bind(&authority.public_metadata_json)
        .bind(&authority.sealed_material.key_id)
        .bind(&authority.sealed_material.ciphertext)
        .bind(&authority.sealed_material.nonce)
        .bind(&authority.sealed_material.aad_digest)
        .bind(i64::from(authority.is_default))
        .bind(&authority.status)
        .bind(authority.version)
        .bind(&authority.created_at)
        .bind(&authority.updated_at)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_certificate_authority(
        &self,
        organization_id: &str,
        authority_id: &str,
    ) -> anyhow::Result<Option<StoredCertificateAuthority>> {
        let row = sqlx::query(
            "SELECT * FROM certificate_authorities WHERE organization_id = ? AND id = ?",
        )
        .bind(organization_id)
        .bind(authority_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(stored_certificate_authority))
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_default_certificate_authority(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Option<StoredCertificateAuthority>> {
        let row = sqlx::query(
            "SELECT * FROM certificate_authorities WHERE organization_id = ? AND is_default = 1",
        )
        .bind(organization_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(stored_certificate_authority))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_certificate_authorities(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Vec<StoredCertificateAuthority>> {
        let rows = sqlx::query(
            "SELECT * FROM certificate_authorities WHERE organization_id = ? ORDER BY is_default DESC, created_at, id",
        )
        .bind(organization_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_certificate_authority).collect())
    }

    /// Select one active default using compare-and-swap. This never falls back
    /// to another issuer when the selected row is absent, stale, or inactive.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction fails.
    pub async fn set_default_certificate_authority(
        &self,
        organization_id: &str,
        authority_id: &str,
        expected_version: i64,
    ) -> anyhow::Result<bool> {
        let mut transaction = self.pool.begin().await?;
        let target = sqlx::query(
            "SELECT version, status FROM certificate_authorities WHERE organization_id = ? AND id = ?",
        )
        .bind(organization_id)
        .bind(authority_id)
        .fetch_optional(&mut *transaction)
        .await?;
        let Some(target) = target else {
            return Ok(false);
        };
        if target.get::<i64, _>("version") != expected_version
            || target.get::<String, _>("status") != "active"
        {
            return Ok(false);
        }
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "UPDATE certificate_authorities SET is_default = 0, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND is_default = 1 AND id <> ?",
        )
        .bind(&now)
        .bind(organization_id)
        .bind(authority_id)
        .execute(&mut *transaction)
        .await?;
        let updated = sqlx::query(
            "UPDATE certificate_authorities SET is_default = 1, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ? AND status = 'active'",
        )
        .bind(&now)
        .bind(organization_id)
        .bind(authority_id)
        .bind(expected_version)
        .execute(&mut *transaction)
        .await?;
        if updated.rows_affected() != 1 {
            transaction.rollback().await?;
            return Ok(false);
        }
        transaction.commit().await?;
        Ok(true)
    }

    /// # Errors
    ///
    /// Returns an error when the update fails.
    pub async fn update_certificate_authority_status(
        &self,
        organization_id: &str,
        authority_id: &str,
        expected_version: i64,
        status: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query(
            "UPDATE certificate_authorities SET status = ?, is_default = CASE WHEN ? = 'active' THEN is_default ELSE 0 END, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ?",
        )
        .bind(status)
        .bind(status)
        .bind(Utc::now().to_rfc3339())
        .bind(organization_id)
        .bind(authority_id)
        .bind(expected_version)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when validation or insertion fails.
    pub async fn insert_certificate_issuance_request(
        &self,
        request: &StoredCertificateIssuanceRequest,
    ) -> anyhow::Result<bool> {
        validate_san_json(&request.san_json)?;
        if request.state != "created" || request.delivery.is_some() {
            anyhow::bail!("new certificate issuance requests must be unfulfilled and created");
        }
        let result = sqlx::query(
            "INSERT INTO certificate_issuance_requests (id, organization_id, authority_id, request_digest, idempotency_key, created_by, state, common_name, san_json, delivery_key_id, delivery_ciphertext, delivery_nonce, delivery_aad_digest, delivery_expires_at, expires_at, version, created_at, updated_at) \
             SELECT ?, ?, id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM certificate_authorities \
             WHERE id = ? AND organization_id = ? AND status = 'active'",
        )
        .bind(&request.id)
        .bind(&request.organization_id)
        .bind(&request.request_digest)
        .bind(&request.idempotency_key)
        .bind(&request.created_by)
        .bind(&request.state)
        .bind(&request.common_name)
        .bind(&request.san_json)
        .bind(request.delivery.as_ref().map(|d| &d.material.key_id))
        .bind(request.delivery.as_ref().map(|d| &d.material.ciphertext))
        .bind(request.delivery.as_ref().map(|d| &d.material.nonce))
        .bind(request.delivery.as_ref().map(|d| &d.material.aad_digest))
        .bind(request.delivery.as_ref().map(|d| &d.expires_at))
        .bind(&request.expires_at)
        .bind(request.version)
        .bind(&request.created_at)
        .bind(&request.updated_at)
        .bind(&request.authority_id)
        .bind(&request.organization_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the lookup or stored-record decoding fails.
    pub async fn find_certificate_issuance_by_idempotency(
        &self,
        organization_id: &str,
        idempotency_key: &str,
    ) -> anyhow::Result<Option<StoredCertificateIssuanceRequest>> {
        let row = sqlx::query(
            "SELECT * FROM certificate_issuance_requests WHERE organization_id = ? AND idempotency_key = ?",
        )
        .bind(organization_id)
        .bind(idempotency_key)
        .fetch_optional(&self.pool)
        .await?;
        row.as_ref()
            .map(stored_certificate_issuance_request)
            .transpose()
    }

    /// # Errors
    ///
    /// Returns an error when the state update fails.
    pub async fn transition_certificate_issuance(
        &self,
        organization_id: &str,
        request_id: &str,
        expected_version: i64,
        expected_state: &str,
        next_state: &str,
    ) -> anyhow::Result<bool> {
        if certificate_issuance_state_is_terminal(expected_state) || next_state == "completed" {
            return Ok(false);
        }
        let result = sqlx::query(
            "UPDATE certificate_issuance_requests SET state = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ? AND state = ? AND julianday(expires_at) > julianday(?)",
        )
        .bind(next_state)
        .bind(Utc::now().to_rfc3339())
        .bind(organization_id)
        .bind(request_id)
        .bind(expected_version)
        .bind(expected_state)
        .bind(Utc::now().to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Atomically records key-free certificate metadata and the encrypted,
    /// time-bounded delivery payload. A stale request cannot create a record.
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the transaction fails.
    pub async fn complete_certificate_issuance(
        &self,
        organization_id: &str,
        request_id: &str,
        expected_version: i64,
        expected_state: &str,
        delivery: &SealedCertificateDelivery,
        issued: &StoredIssuedCertificate,
    ) -> anyhow::Result<bool> {
        if certificate_issuance_state_is_terminal(expected_state) {
            return Ok(false);
        }
        validate_sealed_material(&delivery.material)?;
        validate_san_json(&issued.san_json)?;
        if issued.organization_id != organization_id || issued.request_id != request_id {
            anyhow::bail!("issued certificate ownership does not match request");
        }
        let mut transaction = self.pool.begin().await?;
        let updated = sqlx::query(
            "UPDATE certificate_issuance_requests SET state = 'completed', delivery_key_id = ?, delivery_ciphertext = ?, delivery_nonce = ?, delivery_aad_digest = ?, delivery_expires_at = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND authority_id = ? AND common_name = ? AND san_json = ? AND version = ? AND state = ? AND julianday(expires_at) > julianday(?)",
        )
        .bind(&delivery.material.key_id)
        .bind(&delivery.material.ciphertext)
        .bind(&delivery.material.nonce)
        .bind(&delivery.material.aad_digest)
        .bind(&delivery.expires_at)
        .bind(Utc::now().to_rfc3339())
        .bind(organization_id)
        .bind(request_id)
        .bind(&issued.authority_id)
        .bind(&issued.common_name)
        .bind(&issued.san_json)
        .bind(expected_version)
        .bind(expected_state)
        .bind(Utc::now().to_rfc3339())
        .execute(&mut *transaction)
        .await?;
        if updated.rows_affected() != 1 {
            transaction.rollback().await?;
            return Ok(false);
        }
        sqlx::query(
            "INSERT INTO issued_certificates (id, organization_id, authority_id, request_id, certificate_digest, serial_number, common_name, san_json, not_before, expires_at, status, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&issued.id)
        .bind(&issued.organization_id)
        .bind(&issued.authority_id)
        .bind(&issued.request_id)
        .bind(&issued.certificate_digest)
        .bind(&issued.serial_number)
        .bind(&issued.common_name)
        .bind(&issued.san_json)
        .bind(&issued.not_before)
        .bind(&issued.expires_at)
        .bind(&issued.status)
        .bind(issued.version)
        .bind(&issued.created_at)
        .bind(&issued.updated_at)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(true)
    }

    /// Destructive read of a still-valid encrypted delivery. The clear and
    /// version bump happen in the same transaction, so concurrent readers get
    /// at most one payload.
    ///
    /// # Errors
    ///
    /// Returns an error when delivery decoding or the transaction fails.
    pub async fn take_certificate_delivery(
        &self,
        organization_id: &str,
        request_id: &str,
        now: &str,
    ) -> anyhow::Result<Option<SealedCertificateDelivery>> {
        let mut transaction = self.pool.begin().await?;
        let row = sqlx::query(
            "SELECT version, delivery_key_id, delivery_ciphertext, delivery_nonce, delivery_aad_digest, delivery_expires_at \
             FROM certificate_issuance_requests WHERE organization_id = ? AND id = ? AND state = 'completed'",
        )
        .bind(organization_id)
        .bind(request_id)
        .fetch_optional(&mut *transaction)
        .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        let version: i64 = row.get("version");
        let Some(expires_at) = row.get::<Option<String>, _>("delivery_expires_at") else {
            return Ok(None);
        };
        if certificate_time_is_expired(&expires_at, now)? {
            clear_certificate_delivery(&mut transaction, request_id, version).await?;
            transaction.commit().await?;
            return Ok(None);
        }
        let delivery = sealed_certificate_delivery(&row)?;
        if !clear_certificate_delivery(&mut transaction, request_id, version).await? {
            transaction.rollback().await?;
            return Ok(None);
        }
        transaction.commit().await?;
        Ok(Some(delivery))
    }

    /// Reads a bounded encrypted delivery without consuming it. Callers must
    /// acknowledge only after the response has been durably stored by the
    /// holder; this avoids losing a generated private key on transport failure.
    ///
    /// # Errors
    ///
    /// Returns an error when delivery decoding or the transaction fails.
    pub async fn get_certificate_delivery(
        &self,
        organization_id: &str,
        request_id: &str,
        created_by: &str,
        now: &str,
    ) -> anyhow::Result<Option<SealedCertificateDelivery>> {
        let mut transaction = self.pool.begin().await?;
        let row = sqlx::query(
            "SELECT version, delivery_key_id, delivery_ciphertext, delivery_nonce, delivery_aad_digest, delivery_expires_at \
             FROM certificate_issuance_requests WHERE organization_id = ? AND id = ? AND created_by = ? AND state = 'completed'",
        )
        .bind(organization_id)
        .bind(request_id)
        .bind(created_by)
        .fetch_optional(&mut *transaction)
        .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        let version: i64 = row.get("version");
        let Some(expires_at) = row.get::<Option<String>, _>("delivery_expires_at") else {
            return Ok(None);
        };
        if certificate_time_is_expired(&expires_at, now)? {
            clear_certificate_delivery(&mut transaction, request_id, version).await?;
            transaction.commit().await?;
            return Ok(None);
        }
        let delivery = sealed_certificate_delivery(&row)?;
        transaction.commit().await?;
        Ok(Some(delivery))
    }

    /// Clears an encrypted delivery after holder acknowledgement. The CAS makes
    /// repeated or concurrent acknowledgements harmless.
    ///
    /// # Errors
    ///
    /// Returns an error when the lookup or transaction fails.
    pub async fn acknowledge_certificate_delivery(
        &self,
        organization_id: &str,
        request_id: &str,
        created_by: &str,
    ) -> anyhow::Result<bool> {
        let row = sqlx::query(
            "SELECT version FROM certificate_issuance_requests \
             WHERE organization_id = ? AND id = ? AND created_by = ? AND state = 'completed' AND delivery_ciphertext IS NOT NULL",
        )
        .bind(organization_id)
        .bind(request_id)
        .bind(created_by)
        .fetch_optional(&self.pool)
        .await?;
        let Some(row) = row else {
            return Ok(false);
        };
        let mut transaction = self.pool.begin().await?;
        let cleared =
            clear_certificate_delivery(&mut transaction, request_id, row.get::<i64, _>("version"))
                .await?;
        transaction.commit().await?;
        Ok(cleared)
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_issued_certificate(
        &self,
        organization_id: &str,
        certificate_id: &str,
    ) -> anyhow::Result<Option<StoredIssuedCertificate>> {
        let row =
            sqlx::query("SELECT * FROM issued_certificates WHERE organization_id = ? AND id = ?")
                .bind(organization_id)
                .bind(certificate_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.as_ref().map(stored_issued_certificate))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_issued_certificates_expiring_before(
        &self,
        organization_id: &str,
        before: &str,
    ) -> anyhow::Result<Vec<StoredIssuedCertificate>> {
        let rows = sqlx::query(
            "SELECT * FROM issued_certificates WHERE organization_id = ? AND status = 'active' AND julianday(expires_at) <= julianday(?) ORDER BY expires_at, id",
        )
        .bind(organization_id)
        .bind(before)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_issued_certificate).collect())
    }

    // —— host operator kv ————————————————————————————————

    /// Read a host-operator key/value entry.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn get_host_kv(&self, key: &str) -> anyhow::Result<Option<String>> {
        let row = sqlx::query("SELECT value FROM host_kv WHERE key = ?")
            .bind(key)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|r| r.get::<String, _>("value")))
    }

    /// Insert or replace a host-operator key/value entry.
    ///
    /// # Errors
    ///
    /// Returns an error when the database write fails.
    pub async fn set_host_kv(&self, key: &str, value: &str) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO host_kv (key, value, updated_at) VALUES (?, ?, ?) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        )
        .bind(key)
        .bind(value)
        .bind(Utc::now().to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Insert `key` only when absent. Returns `true` when this call claimed the key.
    ///
    /// # Errors
    ///
    /// Returns an error when the database write fails.
    pub async fn try_claim_host_kv(&self, key: &str, value: &str) -> anyhow::Result<bool> {
        let result = sqlx::query(
            "INSERT INTO host_kv (key, value, updated_at) VALUES (?, ?, ?) \
             ON CONFLICT(key) DO NOTHING",
        )
        .bind(key)
        .bind(value)
        .bind(Utc::now().to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    /// Delete a host-operator key/value entry.
    ///
    /// # Errors
    ///
    /// Returns an error when the database deletion fails.
    pub async fn delete_host_kv(&self, key: &str) -> anyhow::Result<()> {
        sqlx::query("DELETE FROM host_kv WHERE key = ?")
            .bind(key)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // —— backup targets (ADR 0039) ——————————————————————————————

    /// Insert or update the encrypted-backup target for an organization.
    ///
    /// # Errors
    ///
    /// Returns an error when the database write fails.
    pub async fn upsert_backup_target(&self, target: &BackupTarget) -> anyhow::Result<()> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO backup_targets (organization_id, integration_id, installation_id, owner, repo, branch, enabled, status, kind, provider_id, connection_id, config, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(organization_id) DO UPDATE SET \
               integration_id = excluded.integration_id, \
               installation_id = excluded.installation_id, \
               owner = excluded.owner, \
               repo = excluded.repo, \
               branch = excluded.branch, \
               enabled = excluded.enabled, \
               status = excluded.status, \
               kind = excluded.kind, \
               provider_id = excluded.provider_id, \
               connection_id = excluded.connection_id, \
               config = excluded.config, \
               last_error = NULL, \
               updated_at = excluded.updated_at",
        )
        .bind(&target.organization_id)
        .bind(&target.integration_id)
        .bind(&target.installation_id)
        .bind(&target.owner)
        .bind(&target.repo)
        .bind(&target.branch)
        .bind(i64::from(target.enabled))
        .bind(&target.status)
        .bind(&target.kind)
        .bind(&target.provider_id)
        .bind(&target.connection_id)
        .bind(&target.config)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Read an organization's encrypted-backup target.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn get_backup_target(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Option<BackupTarget>> {
        let row = sqlx::query(
            "SELECT organization_id, integration_id, installation_id, owner, repo, branch, enabled, status, last_commit_sha, last_synced_at, last_error, kind, provider_id, connection_id, config \
             FROM backup_targets WHERE organization_id = ?",
        )
        .bind(organization_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|row| BackupTarget {
            organization_id: row.get("organization_id"),
            integration_id: row.get("integration_id"),
            installation_id: row.get("installation_id"),
            owner: row.get("owner"),
            repo: row.get("repo"),
            branch: row.get("branch"),
            enabled: row.get::<i64, _>("enabled") != 0,
            status: row.get("status"),
            last_commit_sha: row.get("last_commit_sha"),
            last_synced_at: row.get("last_synced_at"),
            last_error: row.get("last_error"),
            kind: row.get("kind"),
            provider_id: row.get("provider_id"),
            connection_id: row.get("connection_id"),
            config: row.get("config"),
        }))
    }

    /// Record the outcome of a backup pass without touching the configuration.
    ///
    /// # Errors
    ///
    /// Returns an error when the database update fails.
    pub async fn record_backup_outcome(
        &self,
        organization_id: &str,
        status: &str,
        last_commit_sha: Option<&str>,
        last_error: Option<&str>,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "UPDATE backup_targets SET status = ?, \
               last_commit_sha = COALESCE(?, last_commit_sha), \
               last_synced_at = CASE WHEN ? IS NOT NULL THEN ? ELSE last_synced_at END, \
               last_error = ?, updated_at = ? WHERE organization_id = ?",
        )
        .bind(status)
        .bind(last_commit_sha)
        .bind(last_commit_sha)
        .bind(Utc::now().to_rfc3339())
        .bind(last_error)
        .bind(Utc::now().to_rfc3339())
        .bind(organization_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Insert or update an organization's attachment replication target.
    ///
    /// # Errors
    ///
    /// Returns an error when the database write fails.
    pub async fn upsert_attachment_target(&self, target: &AttachmentTarget) -> anyhow::Result<()> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO attachment_targets (organization_id, connection_id, provider_id, folder_path, enabled, status, updated_at_unix_ms, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(organization_id) DO UPDATE SET \
               connection_id = excluded.connection_id, \
               provider_id = excluded.provider_id, \
               folder_path = excluded.folder_path, \
               enabled = excluded.enabled, \
               status = excluded.status, \
               last_error = NULL, \
               updated_at_unix_ms = excluded.updated_at_unix_ms, \
               updated_at = excluded.updated_at",
        )
        .bind(&target.organization_id)
        .bind(&target.connection_id)
        .bind(&target.provider_id)
        .bind(&target.folder_path)
        .bind(i64::from(target.enabled))
        .bind(&target.status)
        .bind(target.updated_at_unix_ms)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Read an organization's attachment replication target.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn get_attachment_target(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Option<AttachmentTarget>> {
        let row = sqlx::query(
            "SELECT organization_id, connection_id, provider_id, folder_path, enabled, status, last_error, updated_at_unix_ms \
             FROM attachment_targets WHERE organization_id = ?",
        )
        .bind(organization_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|row| AttachmentTarget {
            organization_id: row.get("organization_id"),
            connection_id: row.get("connection_id"),
            provider_id: row.get("provider_id"),
            folder_path: row.get("folder_path"),
            enabled: row.get::<i64, _>("enabled") != 0,
            status: row.get("status"),
            last_error: row.get("last_error"),
            updated_at_unix_ms: row.get("updated_at_unix_ms"),
        }))
    }

    /// Record a replication failure without disturbing the configuration.
    ///
    /// # Errors
    ///
    /// Returns an error when the update fails.
    pub async fn record_attachment_target_error(
        &self,
        organization_id: &str,
        last_error: Option<&str>,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "UPDATE attachment_targets SET status = ?, last_error = ?, updated_at = ? \
             WHERE organization_id = ?",
        )
        .bind(if last_error.is_some() { "error" } else { "ok" })
        .bind(last_error)
        .bind(Utc::now().to_rfc3339())
        .bind(organization_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Delete an organization's attachment replication target.
    ///
    /// # Errors
    ///
    /// Returns an error when the deletion fails.
    pub async fn delete_attachment_target(&self, organization_id: &str) -> anyhow::Result<()> {
        sqlx::query("DELETE FROM attachment_targets WHERE organization_id = ?")
            .bind(organization_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Delete an organization's encrypted-backup target.
    ///
    /// # Errors
    ///
    /// Returns an error when the database deletion fails.
    pub async fn delete_backup_target(&self, organization_id: &str) -> anyhow::Result<()> {
        sqlx::query("DELETE FROM backup_targets WHERE organization_id = ?")
            .bind(organization_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Ciphertext rows a snapshot is built from. Only sealed bytes leave this
    /// query; there is no plaintext anywhere in the backup path.
    ///
    /// # Errors
    ///
    /// Returns an error when encrypted revisions cannot be queried.
    pub async fn list_encrypted_item_revisions(
        &self,
    ) -> anyhow::Result<Vec<EncryptedItemRevision>> {
        let rows = sqlx::query(
            "SELECT vault_id, item_id, revision, ciphertext, wrapping_json, ad_digest FROM encrypted_item_revisions ORDER BY vault_id, item_id, revision",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| EncryptedItemRevision {
                vault_id: row.get("vault_id"),
                item_id: row.get("item_id"),
                revision: row.get("revision"),
                ciphertext: row.get("ciphertext"),
                wrapping_json: row.get("wrapping_json"),
                ad_digest: row.get("ad_digest"),
            })
            .collect())
    }

    /// List every owner-scoped encrypted sync blob for snapshot backup.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails or a stored epoch is negative.
    pub async fn list_all_sync_blobs(&self) -> anyhow::Result<Vec<(String, StoredSyncBlob)>> {
        let rows = sqlx::query(
            "SELECT id, owner_id, epoch, ciphertext FROM encrypted_sync_blobs ORDER BY owner_id, epoch, id",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok((
                    row.get("owner_id"),
                    StoredSyncBlob {
                        id: row.get("id"),
                        epoch: db_u64(row.get("epoch"), "sync epoch")?,
                        ciphertext: row.get("ciphertext"),
                    },
                ))
            })
            .collect()
    }

    // —— certificate manager: shared helpers ——————————————————————

    /// Materialize the tenant row so an org-scoped insert cannot trip the
    /// `organizations` foreign key on a freshly provisioned host.
    async fn ensure_organization_row(
        &self,
        organization_id: &str,
        created_at: &str,
    ) -> anyhow::Result<()> {
        sqlx::query("INSERT OR IGNORE INTO organizations (id, name, created_at) VALUES (?, ?, ?)")
            .bind(organization_id)
            .bind(organization_id)
            .bind(created_at)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // —— certificate policies ——————————————————————————————————————

    /// Persist a certificate policy.
    ///
    /// # Errors
    ///
    /// Returns an error when `rules_json` is not JSON or the insert violates a
    /// database constraint.
    pub async fn insert_certificate_policy(
        &self,
        policy: &StoredCertificatePolicy,
    ) -> anyhow::Result<()> {
        validate_json_document(&policy.rules_json, "certificate policy rules")?;
        self.ensure_organization_row(&policy.organization_id, &policy.created_at)
            .await?;
        sqlx::query(
            "INSERT INTO certificate_policies (id, organization_id, name, description, preset, max_validity_seconds, rules_json, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&policy.id)
        .bind(&policy.organization_id)
        .bind(&policy.name)
        .bind(&policy.description)
        .bind(&policy.preset)
        .bind(policy.max_validity_seconds)
        .bind(&policy.rules_json)
        .bind(policy.version)
        .bind(&policy.created_at)
        .bind(&policy.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_certificate_policy(
        &self,
        organization_id: &str,
        policy_id: &str,
    ) -> anyhow::Result<Option<StoredCertificatePolicy>> {
        let row =
            sqlx::query("SELECT * FROM certificate_policies WHERE organization_id = ? AND id = ?")
                .bind(organization_id)
                .bind(policy_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.as_ref().map(stored_certificate_policy))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_certificate_policies(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Vec<StoredCertificatePolicy>> {
        let rows = sqlx::query(
            "SELECT * FROM certificate_policies WHERE organization_id = ? ORDER BY name, id",
        )
        .bind(organization_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_certificate_policy).collect())
    }

    /// Compare-and-swap update; `policy.version` is the version the caller read.
    ///
    /// # Errors
    ///
    /// Returns an error when `rules_json` is not JSON or the update fails.
    pub async fn update_certificate_policy(
        &self,
        policy: &StoredCertificatePolicy,
    ) -> anyhow::Result<bool> {
        validate_json_document(&policy.rules_json, "certificate policy rules")?;
        let result = sqlx::query(
            "UPDATE certificate_policies SET name = ?, description = ?, preset = ?, max_validity_seconds = ?, rules_json = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ?",
        )
        .bind(&policy.name)
        .bind(&policy.description)
        .bind(&policy.preset)
        .bind(policy.max_validity_seconds)
        .bind(&policy.rules_json)
        .bind(now_rfc3339())
        .bind(&policy.organization_id)
        .bind(&policy.id)
        .bind(policy.version)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the deletion fails or a profile still references
    /// the policy.
    pub async fn delete_certificate_policy(
        &self,
        organization_id: &str,
        policy_id: &str,
    ) -> anyhow::Result<bool> {
        let result =
            sqlx::query("DELETE FROM certificate_policies WHERE organization_id = ? AND id = ?")
                .bind(organization_id)
                .bind(policy_id)
                .execute(&self.pool)
                .await?;
        Ok(result.rows_affected() == 1)
    }

    // —— certificate profiles ——————————————————————————————————————

    /// # Errors
    ///
    /// Returns an error when `defaults_json` is not JSON or the insert fails.
    pub async fn insert_certificate_profile(
        &self,
        profile: &StoredCertificateProfile,
    ) -> anyhow::Result<()> {
        validate_json_document(&profile.defaults_json, "certificate profile defaults")?;
        self.ensure_organization_row(&profile.organization_id, &profile.created_at)
            .await?;
        sqlx::query(
            "INSERT INTO certificate_profiles (id, organization_id, name, issuer_type, certificate_authority_id, policy_id, defaults_json, external_template, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&profile.id)
        .bind(&profile.organization_id)
        .bind(&profile.name)
        .bind(&profile.issuer_type)
        .bind(&profile.certificate_authority_id)
        .bind(&profile.policy_id)
        .bind(&profile.defaults_json)
        .bind(&profile.external_template)
        .bind(profile.version)
        .bind(&profile.created_at)
        .bind(&profile.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_certificate_profile(
        &self,
        organization_id: &str,
        profile_id: &str,
    ) -> anyhow::Result<Option<StoredCertificateProfile>> {
        let row =
            sqlx::query("SELECT * FROM certificate_profiles WHERE organization_id = ? AND id = ?")
                .bind(organization_id)
                .bind(profile_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.as_ref().map(stored_certificate_profile))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_certificate_profiles(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Vec<StoredCertificateProfile>> {
        let rows = sqlx::query(
            "SELECT * FROM certificate_profiles WHERE organization_id = ? ORDER BY name, id",
        )
        .bind(organization_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_certificate_profile).collect())
    }

    /// # Errors
    ///
    /// Returns an error when `defaults_json` is not JSON or the update fails.
    pub async fn update_certificate_profile(
        &self,
        profile: &StoredCertificateProfile,
    ) -> anyhow::Result<bool> {
        validate_json_document(&profile.defaults_json, "certificate profile defaults")?;
        let result = sqlx::query(
            "UPDATE certificate_profiles SET name = ?, issuer_type = ?, certificate_authority_id = ?, policy_id = ?, defaults_json = ?, external_template = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ?",
        )
        .bind(&profile.name)
        .bind(&profile.issuer_type)
        .bind(&profile.certificate_authority_id)
        .bind(&profile.policy_id)
        .bind(&profile.defaults_json)
        .bind(&profile.external_template)
        .bind(now_rfc3339())
        .bind(&profile.organization_id)
        .bind(&profile.id)
        .bind(profile.version)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the deletion fails.
    pub async fn delete_certificate_profile(
        &self,
        organization_id: &str,
        profile_id: &str,
    ) -> anyhow::Result<bool> {
        let result =
            sqlx::query("DELETE FROM certificate_profiles WHERE organization_id = ? AND id = ?")
                .bind(organization_id)
                .bind(profile_id)
                .execute(&self.pool)
                .await?;
        Ok(result.rows_affected() == 1)
    }

    // —— certificate authority hierarchy ————————————————————————————

    /// Link a child authority to a same-organization parent.
    ///
    /// # Errors
    ///
    /// Returns an error when the parent is absent, belongs to another
    /// organization, or would link the authority to itself.
    pub async fn insert_ca_link(
        &self,
        organization_id: &str,
        child_id: &str,
        parent_id: &str,
    ) -> anyhow::Result<bool> {
        if child_id == parent_id {
            anyhow::bail!("a certificate authority cannot be its own parent");
        }
        let parent = sqlx::query(
            "SELECT 1 AS present FROM certificate_authorities WHERE organization_id = ? AND id = ?",
        )
        .bind(organization_id)
        .bind(parent_id)
        .fetch_optional(&self.pool)
        .await?;
        if parent.is_none() {
            anyhow::bail!("parent certificate authority is not in this organization");
        }
        let result = sqlx::query(
            "UPDATE certificate_authorities SET parent_id = ?, kind = 'intermediate', version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ?",
        )
        .bind(parent_id)
        .bind(now_rfc3339())
        .bind(organization_id)
        .bind(child_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn get_ca_children(
        &self,
        organization_id: &str,
        authority_id: &str,
    ) -> anyhow::Result<Vec<StoredCertificateAuthority>> {
        let rows = sqlx::query(
            "SELECT * FROM certificate_authorities WHERE organization_id = ? AND parent_id = ? ORDER BY created_at, id",
        )
        .bind(organization_id)
        .bind(authority_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_certificate_authority).collect())
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn get_ca_parent(
        &self,
        organization_id: &str,
        authority_id: &str,
    ) -> anyhow::Result<Option<StoredCertificateAuthority>> {
        let row = sqlx::query(
            "SELECT parent.* FROM certificate_authorities AS child \
             JOIN certificate_authorities AS parent \
               ON parent.organization_id = child.organization_id AND parent.id = child.parent_id \
             WHERE child.organization_id = ? AND child.id = ?",
        )
        .bind(organization_id)
        .bind(authority_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(stored_certificate_authority))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn get_signing_config(
        &self,
        organization_id: &str,
        authority_id: &str,
    ) -> anyhow::Result<Option<StoredCaSigningConfig>> {
        let row = sqlx::query(
            "SELECT * FROM certificate_authorities WHERE organization_id = ? AND id = ?",
        )
        .bind(organization_id)
        .bind(authority_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(stored_ca_signing_config))
    }

    /// Compare-and-swap the per-authority signing configuration.
    ///
    /// # Errors
    ///
    /// Returns an error when the update fails.
    pub async fn update_signing_config(
        &self,
        config: &StoredCaSigningConfig,
    ) -> anyhow::Result<bool> {
        if let Some(mirrors) = &config.crl_mirrors_json {
            validate_json_document(mirrors, "certificate authority CRL mirrors")?;
        }
        let result = sqlx::query(
            "UPDATE certificate_authorities SET key_algorithm = ?, key_source = ?, hsm_connector_id = ?, hsm_key_label = ?, path_len = ?, crl_enabled = ?, crl_mirrors_json = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ?",
        )
        .bind(&config.key_algorithm)
        .bind(&config.key_source)
        .bind(&config.hsm_connector_id)
        .bind(&config.hsm_key_label)
        .bind(config.path_len)
        .bind(i64::from(config.crl_enabled))
        .bind(&config.crl_mirrors_json)
        .bind(now_rfc3339())
        .bind(&config.organization_id)
        .bind(&config.certificate_authority_id)
        .bind(config.version)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Record the CSR an externally signed intermediate is waiting on.
    ///
    /// # Errors
    ///
    /// Returns an error when the update fails.
    pub async fn set_ca_pending_csr(
        &self,
        organization_id: &str,
        authority_id: &str,
        csr_pem: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query(
            "UPDATE certificate_authorities SET pending_csr_pem = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ?",
        )
        .bind(csr_pem)
        .bind(now_rfc3339())
        .bind(organization_id)
        .bind(authority_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Clear the pending CSR and publish the signed chain metadata.
    ///
    /// # Errors
    ///
    /// Returns an error when the metadata is not JSON or the update fails.
    pub async fn complete_ca_import(
        &self,
        organization_id: &str,
        authority_id: &str,
        expected_version: i64,
        public_metadata_json: &str,
    ) -> anyhow::Result<bool> {
        validate_json_document(public_metadata_json, "certificate authority metadata")?;
        let result = sqlx::query(
            "UPDATE certificate_authorities SET public_metadata_json = ?, pending_csr_pem = NULL, status = 'active', version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ?",
        )
        .bind(public_metadata_json)
        .bind(now_rfc3339())
        .bind(organization_id)
        .bind(authority_id)
        .bind(expected_version)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    // —— PKI applications and membership ————————————————————————————

    /// # Errors
    ///
    /// Returns an error when the insert violates a database constraint.
    pub async fn insert_pki_application(
        &self,
        application: &StoredPkiApplication,
    ) -> anyhow::Result<()> {
        self.ensure_organization_row(&application.organization_id, &application.created_at)
            .await?;
        sqlx::query(
            "INSERT INTO pki_applications (id, organization_id, slug, display_name, description, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&application.id)
        .bind(&application.organization_id)
        .bind(&application.slug)
        .bind(&application.display_name)
        .bind(&application.description)
        .bind(application.version)
        .bind(&application.created_at)
        .bind(&application.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_pki_application(
        &self,
        organization_id: &str,
        application_id: &str,
    ) -> anyhow::Result<Option<StoredPkiApplication>> {
        let row =
            sqlx::query("SELECT * FROM pki_applications WHERE organization_id = ? AND id = ?")
                .bind(organization_id)
                .bind(application_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.as_ref().map(stored_pki_application))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_pki_applications(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Vec<StoredPkiApplication>> {
        let rows = sqlx::query(
            "SELECT * FROM pki_applications WHERE organization_id = ? ORDER BY slug, id",
        )
        .bind(organization_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_pki_application).collect())
    }

    /// # Errors
    ///
    /// Returns an error when the update fails.
    pub async fn update_pki_application(
        &self,
        application: &StoredPkiApplication,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query(
            "UPDATE pki_applications SET slug = ?, display_name = ?, description = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ?",
        )
        .bind(&application.slug)
        .bind(&application.display_name)
        .bind(&application.description)
        .bind(now_rfc3339())
        .bind(&application.organization_id)
        .bind(&application.id)
        .bind(application.version)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the deletion fails.
    pub async fn delete_pki_application(
        &self,
        organization_id: &str,
        application_id: &str,
    ) -> anyhow::Result<bool> {
        let result =
            sqlx::query("DELETE FROM pki_applications WHERE organization_id = ? AND id = ?")
                .bind(organization_id)
                .bind(application_id)
                .execute(&self.pool)
                .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Insert or re-grade one application membership.
    ///
    /// # Errors
    ///
    /// Returns an error when the application is absent from the organization or
    /// the upsert fails.
    pub async fn upsert_application_member(
        &self,
        member: &StoredPkiApplicationMember,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO pki_application_members (id, organization_id, application_id, subject, role, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(organization_id, application_id, subject) \
             DO UPDATE SET role = excluded.role, version = pki_application_members.version + 1, updated_at = excluded.updated_at",
        )
        .bind(&member.id)
        .bind(&member.organization_id)
        .bind(&member.application_id)
        .bind(&member.subject)
        .bind(&member.role)
        .bind(member.version)
        .bind(&member.created_at)
        .bind(&member.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_application_members(
        &self,
        organization_id: &str,
        application_id: &str,
    ) -> anyhow::Result<Vec<StoredPkiApplicationMember>> {
        let rows = sqlx::query(
            "SELECT * FROM pki_application_members WHERE organization_id = ? AND application_id = ? ORDER BY subject",
        )
        .bind(organization_id)
        .bind(application_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_pki_application_member).collect())
    }

    /// # Errors
    ///
    /// Returns an error when the deletion fails.
    pub async fn remove_application_member(
        &self,
        organization_id: &str,
        application_id: &str,
        subject: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query(
            "DELETE FROM pki_application_members WHERE organization_id = ? AND application_id = ? AND subject = ?",
        )
        .bind(organization_id)
        .bind(application_id)
        .bind(subject)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Resolve a subject's effective role on an application.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn effective_app_role(
        &self,
        organization_id: &str,
        application_id: &str,
        subject: &str,
    ) -> anyhow::Result<Option<Role>> {
        let row = sqlx::query(
            "SELECT role FROM pki_application_members WHERE organization_id = ? AND application_id = ? AND subject = ?",
        )
        .bind(organization_id)
        .bind(application_id)
        .bind(subject)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.and_then(|row| Role::from_application_str(&row.get::<String, _>("role"))))
    }

    // —— enrollment configuration ——————————————————————————————————

    /// # Errors
    ///
    /// Returns an error when `config_json` is not JSON, the sealed secret is
    /// partially populated, or the insert fails.
    pub async fn insert_enrollment_config(
        &self,
        config: &StoredEnrollmentConfig,
    ) -> anyhow::Result<()> {
        validate_json_document(&config.config_json, "enrollment configuration")?;
        validate_optional_sealed_material(config.sealed_secret.as_ref())?;
        let (key_id, ciphertext, nonce, aad_digest) = sealed_parts(config.sealed_secret.as_ref());
        sqlx::query(
            "INSERT INTO enrollment_configs (id, organization_id, application_id, profile_id, method, enabled, config_json, auto_renew_enabled, renew_before_seconds, sealed_secret_key_id, sealed_secret_ciphertext, sealed_secret_nonce, sealed_secret_aad_digest, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&config.id)
        .bind(&config.organization_id)
        .bind(&config.application_id)
        .bind(&config.profile_id)
        .bind(&config.method)
        .bind(i64::from(config.enabled))
        .bind(&config.config_json)
        .bind(i64::from(config.auto_renew_enabled))
        .bind(config.renew_before_seconds)
        .bind(key_id)
        .bind(ciphertext)
        .bind(nonce)
        .bind(aad_digest)
        .bind(config.version)
        .bind(&config.created_at)
        .bind(&config.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_enrollment_config(
        &self,
        organization_id: &str,
        enrollment_id: &str,
    ) -> anyhow::Result<Option<StoredEnrollmentConfig>> {
        let row =
            sqlx::query("SELECT * FROM enrollment_configs WHERE organization_id = ? AND id = ?")
                .bind(organization_id)
                .bind(enrollment_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.as_ref().map(stored_enrollment_config))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_enrollment_configs(
        &self,
        organization_id: &str,
        application_id: &str,
    ) -> anyhow::Result<Vec<StoredEnrollmentConfig>> {
        let rows = sqlx::query(
            "SELECT * FROM enrollment_configs WHERE organization_id = ? AND application_id = ? ORDER BY method, id",
        )
        .bind(organization_id)
        .bind(application_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_enrollment_config).collect())
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn get_enrollment_by_profile_method(
        &self,
        organization_id: &str,
        profile_id: &str,
        method: &str,
    ) -> anyhow::Result<Option<StoredEnrollmentConfig>> {
        let row = sqlx::query(
            "SELECT * FROM enrollment_configs WHERE organization_id = ? AND profile_id = ? AND method = ? AND enabled = 1",
        )
        .bind(organization_id)
        .bind(profile_id)
        .bind(method)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(stored_enrollment_config))
    }

    /// # Errors
    ///
    /// Returns an error when validation or the update fails.
    pub async fn update_enrollment_config(
        &self,
        config: &StoredEnrollmentConfig,
    ) -> anyhow::Result<bool> {
        validate_json_document(&config.config_json, "enrollment configuration")?;
        validate_optional_sealed_material(config.sealed_secret.as_ref())?;
        let (key_id, ciphertext, nonce, aad_digest) = sealed_parts(config.sealed_secret.as_ref());
        let result = sqlx::query(
            "UPDATE enrollment_configs SET enabled = ?, config_json = ?, auto_renew_enabled = ?, renew_before_seconds = ?, sealed_secret_key_id = ?, sealed_secret_ciphertext = ?, sealed_secret_nonce = ?, sealed_secret_aad_digest = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ?",
        )
        .bind(i64::from(config.enabled))
        .bind(&config.config_json)
        .bind(i64::from(config.auto_renew_enabled))
        .bind(config.renew_before_seconds)
        .bind(key_id)
        .bind(ciphertext)
        .bind(nonce)
        .bind(aad_digest)
        .bind(now_rfc3339())
        .bind(&config.organization_id)
        .bind(&config.id)
        .bind(config.version)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the deletion fails.
    pub async fn delete_enrollment_config(
        &self,
        organization_id: &str,
        enrollment_id: &str,
    ) -> anyhow::Result<bool> {
        let result =
            sqlx::query("DELETE FROM enrollment_configs WHERE organization_id = ? AND id = ?")
                .bind(organization_id)
                .bind(enrollment_id)
                .execute(&self.pool)
                .await?;
        Ok(result.rows_affected() == 1)
    }

    // —— managed certificate inventory ——————————————————————————————

    /// Record a certificate in the managed inventory.
    ///
    /// The 0013 schema makes `authority_id` and `request_id` NOT NULL foreign
    /// keys, so the caller records the issuance request first; migration 0016
    /// deliberately does not rewrite those applied constraints.
    ///
    /// # Errors
    ///
    /// Returns an error when the SAN or metadata documents are malformed, the
    /// status is not a known value, or the insert violates a database
    /// constraint.
    pub async fn insert_managed_certificate(
        &self,
        certificate: &StoredManagedCertificate,
    ) -> anyhow::Result<()> {
        validate_san_json(&certificate.san_json)?;
        validate_json_document(&certificate.metadata_json, "certificate metadata")?;
        validate_certificate_status(&certificate.status)?;
        sqlx::query(
            "INSERT INTO issued_certificates (id, organization_id, authority_id, request_id, certificate_digest, serial_number, common_name, san_json, not_before, expires_at, status, application_id, profile_id, source, enrollment_method, metadata_json, key_algorithm, signature_algorithm, fingerprint_sha256, chain_pem, renewed_from_id, renewed_by_id, auto_renew_enabled, renew_before_seconds, revocation_reason, revoked_at, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&certificate.id)
        .bind(&certificate.organization_id)
        .bind(&certificate.authority_id)
        .bind(&certificate.request_id)
        .bind(&certificate.certificate_digest)
        .bind(&certificate.serial_number)
        .bind(&certificate.common_name)
        .bind(&certificate.san_json)
        .bind(&certificate.not_before)
        .bind(&certificate.expires_at)
        .bind(&certificate.status)
        .bind(&certificate.application_id)
        .bind(&certificate.profile_id)
        .bind(&certificate.source)
        .bind(&certificate.enrollment_method)
        .bind(&certificate.metadata_json)
        .bind(&certificate.key_algorithm)
        .bind(&certificate.signature_algorithm)
        .bind(&certificate.fingerprint_sha256)
        .bind(&certificate.chain_pem)
        .bind(&certificate.renewed_from_id)
        .bind(&certificate.renewed_by_id)
        .bind(i64::from(certificate.auto_renew_enabled))
        .bind(certificate.renew_before_seconds)
        .bind(certificate.revocation_reason)
        .bind(&certificate.revoked_at)
        .bind(certificate.version)
        .bind(&certificate.created_at)
        .bind(&certificate.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Place a certificate's managed private key into sealed custody.
    ///
    /// Only the renewal and sync paths call this; no inventory read joins the
    /// table it writes.
    ///
    /// # Errors
    ///
    /// Returns an error when the sealed material is incomplete, the
    /// certificate is absent from the organization, or the upsert fails.
    pub async fn insert_managed_certificate_key(
        &self,
        key: &StoredManagedCertificateKey,
    ) -> anyhow::Result<()> {
        validate_sealed_material(&key.sealed_key)?;
        sqlx::query(
            "INSERT INTO managed_certificate_keys (id, organization_id, certificate_id, sealed_key_key_id, sealed_key_ciphertext, sealed_key_nonce, sealed_key_aad_digest, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(organization_id, certificate_id) DO UPDATE SET \
               sealed_key_key_id = excluded.sealed_key_key_id, sealed_key_ciphertext = excluded.sealed_key_ciphertext, \
               sealed_key_nonce = excluded.sealed_key_nonce, sealed_key_aad_digest = excluded.sealed_key_aad_digest, \
               version = managed_certificate_keys.version + 1, updated_at = excluded.updated_at",
        )
        .bind(&key.id)
        .bind(&key.organization_id)
        .bind(&key.certificate_id)
        .bind(&key.sealed_key.key_id)
        .bind(&key.sealed_key.ciphertext)
        .bind(&key.sealed_key.nonce)
        .bind(&key.sealed_key.aad_digest)
        .bind(key.version)
        .bind(&key.created_at)
        .bind(&key.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Read a certificate's sealed managed key.
    ///
    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_managed_certificate_key(
        &self,
        organization_id: &str,
        certificate_id: &str,
    ) -> anyhow::Result<Option<StoredManagedCertificateKey>> {
        let row = sqlx::query(
            "SELECT * FROM managed_certificate_keys WHERE organization_id = ? AND certificate_id = ?",
        )
        .bind(organization_id)
        .bind(certificate_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(stored_managed_certificate_key))
    }

    /// Drop the sealed managed key once it has been delivered or rotated away.
    ///
    /// # Errors
    ///
    /// Returns an error when the deletion fails.
    pub async fn delete_managed_certificate_key(
        &self,
        organization_id: &str,
        certificate_id: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query(
            "DELETE FROM managed_certificate_keys WHERE organization_id = ? AND certificate_id = ?",
        )
        .bind(organization_id)
        .bind(certificate_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_certificate(
        &self,
        organization_id: &str,
        certificate_id: &str,
    ) -> anyhow::Result<Option<StoredManagedCertificate>> {
        let row =
            sqlx::query("SELECT * FROM issued_certificates WHERE organization_id = ? AND id = ?")
                .bind(organization_id)
                .bind(certificate_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.as_ref().map(stored_managed_certificate))
    }

    /// Inventory search. Every predicate is a bound parameter; no caller value
    /// is ever interpolated into the SQL text.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_certificates(
        &self,
        organization_id: &str,
        filter: &CertificateFilter,
    ) -> anyhow::Result<Vec<StoredManagedCertificate>> {
        let query = filter.to_query();
        let mut statement = sqlx::query(&query.sql).bind(organization_id);
        for value in &query.text_binds {
            statement = statement.bind(value);
        }
        if let Some(limit) = query.limit {
            statement = statement.bind(limit);
        }
        let rows = statement.fetch_all(&self.pool).await?;
        Ok(rows.iter().map(stored_managed_certificate).collect())
    }

    /// # Errors
    ///
    /// Returns an error when the deletion fails.
    pub async fn delete_certificate(
        &self,
        organization_id: &str,
        certificate_id: &str,
    ) -> anyhow::Result<bool> {
        let result =
            sqlx::query("DELETE FROM issued_certificates WHERE organization_id = ? AND id = ?")
                .bind(organization_id)
                .bind(certificate_id)
                .execute(&self.pool)
                .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Replace a certificate's non-secret metadata document.
    ///
    /// # Errors
    ///
    /// Returns an error when the document is not a JSON object or the update
    /// fails.
    pub async fn set_certificate_metadata(
        &self,
        organization_id: &str,
        certificate_id: &str,
        metadata_json: &str,
    ) -> anyhow::Result<bool> {
        validate_metadata_document(metadata_json)?;
        let result = sqlx::query(
            "UPDATE issued_certificates SET metadata_json = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ?",
        )
        .bind(metadata_json)
        .bind(now_rfc3339())
        .bind(organization_id)
        .bind(certificate_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_certificate_metadata(
        &self,
        organization_id: &str,
        certificate_id: &str,
    ) -> anyhow::Result<Option<String>> {
        let row = sqlx::query(
            "SELECT metadata_json FROM issued_certificates WHERE organization_id = ? AND id = ?",
        )
        .bind(organization_id)
        .bind(certificate_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|row| row.get::<String, _>("metadata_json")))
    }

    /// Certificates expiring at or before `cutoff`, mirroring the 0013 helper.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_certificates_expiring_before(
        &self,
        organization_id: &str,
        cutoff: &str,
    ) -> anyhow::Result<Vec<StoredManagedCertificate>> {
        let rows = sqlx::query(
            "SELECT * FROM issued_certificates WHERE organization_id = ? AND status = 'active' AND julianday(expires_at) <= julianday(?) ORDER BY expires_at, id",
        )
        .bind(organization_id)
        .bind(cutoff)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_managed_certificate).collect())
    }

    /// Link a renewed certificate to its predecessor in both directions.
    ///
    /// # Errors
    ///
    /// Returns an error when either certificate is missing from the
    /// organization or the transaction fails.
    pub async fn insert_renewal_link(
        &self,
        organization_id: &str,
        predecessor_id: &str,
        successor_id: &str,
    ) -> anyhow::Result<()> {
        if predecessor_id == successor_id {
            anyhow::bail!("a certificate cannot renew itself");
        }
        let now = now_rfc3339();
        let mut transaction = self.pool.begin().await?;
        let forward = sqlx::query(
            "UPDATE issued_certificates SET renewed_by_id = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ?",
        )
        .bind(successor_id)
        .bind(&now)
        .bind(organization_id)
        .bind(predecessor_id)
        .execute(&mut *transaction)
        .await?;
        let backward = sqlx::query(
            "UPDATE issued_certificates SET renewed_from_id = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ?",
        )
        .bind(predecessor_id)
        .bind(&now)
        .bind(organization_id)
        .bind(successor_id)
        .execute(&mut *transaction)
        .await?;
        if forward.rows_affected() != 1 || backward.rows_affected() != 1 {
            transaction.rollback().await?;
            anyhow::bail!("renewal link requires both certificates in this organization");
        }
        transaction.commit().await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn get_renewed_by(
        &self,
        organization_id: &str,
        certificate_id: &str,
    ) -> anyhow::Result<Option<StoredManagedCertificate>> {
        let row = sqlx::query(
            "SELECT successor.* FROM issued_certificates AS predecessor \
             JOIN issued_certificates AS successor \
               ON successor.organization_id = predecessor.organization_id \
              AND successor.id = predecessor.renewed_by_id \
             WHERE predecessor.organization_id = ? AND predecessor.id = ?",
        )
        .bind(organization_id)
        .bind(certificate_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(stored_managed_certificate))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn get_renewed_from(
        &self,
        organization_id: &str,
        certificate_id: &str,
    ) -> anyhow::Result<Option<StoredManagedCertificate>> {
        let row = sqlx::query(
            "SELECT predecessor.* FROM issued_certificates AS successor \
             JOIN issued_certificates AS predecessor \
               ON predecessor.organization_id = successor.organization_id \
              AND predecessor.id = successor.renewed_from_id \
             WHERE successor.organization_id = ? AND successor.id = ?",
        )
        .bind(organization_id)
        .bind(certificate_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(stored_managed_certificate))
    }

    /// Non-secret counts backing the Certificates dashboard.
    ///
    /// # Errors
    ///
    /// Returns an error when any rollup query fails.
    pub async fn dashboard_rollup(&self, organization_id: &str) -> anyhow::Result<DashboardRollup> {
        let mut rollup = DashboardRollup {
            total: sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM issued_certificates WHERE organization_id = ?",
            )
            .bind(organization_id)
            .fetch_one(&self.pool)
            .await?,
            ..DashboardRollup::default()
        };
        rollup.by_status = self
            .count_certificates_by(organization_id, "status")
            .await?;
        rollup.by_key_algorithm = self
            .count_certificates_by(organization_id, "key_algorithm")
            .await?;
        rollup.by_issuing_ca = self
            .count_certificates_by(organization_id, "authority_id")
            .await?;
        rollup.by_enrollment_method = self
            .count_certificates_by(organization_id, "enrollment_method")
            .await?;
        let now = Utc::now();
        rollup.expiring_within_7_days = self.count_expiring_within(organization_id, now, 7).await?;
        rollup.expiring_within_30_days =
            self.count_expiring_within(organization_id, now, 30).await?;
        rollup.expiring_within_90_days =
            self.count_expiring_within(organization_id, now, 90).await?;
        Ok(rollup)
    }

    /// Group certificate counts by one of a fixed, non-caller-supplied set of
    /// columns. `column` is matched against a literal allowlist so the grouping
    /// expression is never assembled from caller input.
    async fn count_certificates_by(
        &self,
        organization_id: &str,
        column: &str,
    ) -> anyhow::Result<std::collections::BTreeMap<String, i64>> {
        let sql = match column {
            "status" => {
                "SELECT status AS bucket, COUNT(*) AS total FROM issued_certificates WHERE organization_id = ? GROUP BY status"
            }
            "key_algorithm" => {
                "SELECT key_algorithm AS bucket, COUNT(*) AS total FROM issued_certificates WHERE organization_id = ? GROUP BY key_algorithm"
            }
            "authority_id" => {
                "SELECT authority_id AS bucket, COUNT(*) AS total FROM issued_certificates WHERE organization_id = ? GROUP BY authority_id"
            }
            "enrollment_method" => {
                "SELECT enrollment_method AS bucket, COUNT(*) AS total FROM issued_certificates WHERE organization_id = ? GROUP BY enrollment_method"
            }
            _ => anyhow::bail!("unsupported dashboard grouping"),
        };
        let rows = sqlx::query(sql)
            .bind(organization_id)
            .fetch_all(&self.pool)
            .await?;
        Ok(rows
            .into_iter()
            .map(|row| {
                (
                    row.get::<Option<String>, _>("bucket")
                        .unwrap_or_else(|| "unknown".to_string()),
                    row.get::<i64, _>("total"),
                )
            })
            .collect())
    }

    async fn count_expiring_within(
        &self,
        organization_id: &str,
        now: chrono::DateTime<Utc>,
        days: i64,
    ) -> anyhow::Result<i64> {
        let cutoff = (now + chrono::Duration::days(days)).to_rfc3339();
        Ok(sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM issued_certificates WHERE organization_id = ? AND status = 'active' AND julianday(expires_at) <= julianday(?)",
        )
        .bind(organization_id)
        .bind(cutoff)
        .fetch_one(&self.pool)
        .await?)
    }

    // —— revocation and CRL state ——————————————————————————————————

    /// Record a revocation and flip the certificate in the same transaction.
    ///
    /// # Errors
    ///
    /// Returns an error when the certificate is absent from the organization or
    /// the transaction fails.
    pub async fn insert_certificate_revocation(
        &self,
        revocation: &StoredCertificateRevocation,
    ) -> anyhow::Result<()> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO certificate_revocations (id, organization_id, certificate_id, ca_id, serial, reason_code, revoked_at, crl_number, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&revocation.id)
        .bind(&revocation.organization_id)
        .bind(&revocation.certificate_id)
        .bind(&revocation.ca_id)
        .bind(&revocation.serial)
        .bind(revocation.reason_code)
        .bind(&revocation.revoked_at)
        .bind(revocation.crl_number)
        .bind(revocation.version)
        .bind(&revocation.created_at)
        .bind(&revocation.updated_at)
        .execute(&mut *transaction)
        .await?;
        let updated = sqlx::query(
            "UPDATE issued_certificates SET status = 'revoked', revocation_reason = ?, revoked_at = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ?",
        )
        .bind(revocation.reason_code)
        .bind(&revocation.revoked_at)
        .bind(now_rfc3339())
        .bind(&revocation.organization_id)
        .bind(&revocation.certificate_id)
        .execute(&mut *transaction)
        .await?;
        if updated.rows_affected() != 1 {
            transaction.rollback().await?;
            anyhow::bail!("revocation target is not in this organization");
        }
        transaction.commit().await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_revocations_for_ca(
        &self,
        organization_id: &str,
        ca_id: &str,
    ) -> anyhow::Result<Vec<StoredCertificateRevocation>> {
        let rows = sqlx::query(
            "SELECT * FROM certificate_revocations WHERE organization_id = ? AND ca_id = ? ORDER BY revoked_at, serial",
        )
        .bind(organization_id)
        .bind(ca_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_certificate_revocation).collect())
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn get_crl_state(
        &self,
        organization_id: &str,
        ca_id: &str,
    ) -> anyhow::Result<Option<StoredCrlState>> {
        let row = sqlx::query("SELECT * FROM crl_state WHERE organization_id = ? AND ca_id = ?")
            .bind(organization_id)
            .bind(ca_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.as_ref().map(stored_crl_state))
    }

    /// Publish the newest signed CRL for an authority.
    ///
    /// # Errors
    ///
    /// Returns an error when the sealed DER group is partially populated or the
    /// upsert fails.
    pub async fn upsert_crl_state(&self, state: &StoredCrlState) -> anyhow::Result<()> {
        validate_optional_sealed_material(state.sealed_der.as_ref())?;
        if let Some(mirrors) = &state.mirror_urls_json {
            validate_json_document(mirrors, "CRL mirror list")?;
        }
        let (key_id, ciphertext, nonce, aad_digest) = sealed_parts(state.sealed_der.as_ref());
        sqlx::query(
            "INSERT INTO crl_state (id, organization_id, ca_id, crl_number, this_update, next_update, sealed_der_key_id, sealed_der_ciphertext, sealed_der_nonce, sealed_der_aad_digest, mirror_urls_json, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(organization_id, ca_id) DO UPDATE SET \
               crl_number = excluded.crl_number, this_update = excluded.this_update, next_update = excluded.next_update, \
               sealed_der_key_id = excluded.sealed_der_key_id, sealed_der_ciphertext = excluded.sealed_der_ciphertext, \
               sealed_der_nonce = excluded.sealed_der_nonce, sealed_der_aad_digest = excluded.sealed_der_aad_digest, \
               mirror_urls_json = excluded.mirror_urls_json, version = crl_state.version + 1, updated_at = excluded.updated_at",
        )
        .bind(&state.id)
        .bind(&state.organization_id)
        .bind(&state.ca_id)
        .bind(state.crl_number)
        .bind(&state.this_update)
        .bind(&state.next_update)
        .bind(key_id)
        .bind(ciphertext)
        .bind(nonce)
        .bind(aad_digest)
        .bind(&state.mirror_urls_json)
        .bind(state.version)
        .bind(&state.created_at)
        .bind(&state.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    // —— network discovery ————————————————————————————————————————

    /// # Errors
    ///
    /// Returns an error when the target documents are malformed or the insert
    /// fails.
    pub async fn insert_discovery_job(&self, job: &StoredDiscoveryJob) -> anyhow::Result<()> {
        validate_json_document(&job.targets_json, "discovery targets")?;
        validate_json_document(&job.ports_json, "discovery ports")?;
        self.ensure_organization_row(&job.organization_id, &job.created_at)
            .await?;
        sqlx::query(
            "INSERT INTO discovery_jobs (id, organization_id, name, description, targets_json, ports_json, auto_scan, scan_interval_days, gateway_ref, allow_internal, last_scan_at, status, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&job.id)
        .bind(&job.organization_id)
        .bind(&job.name)
        .bind(&job.description)
        .bind(&job.targets_json)
        .bind(&job.ports_json)
        .bind(i64::from(job.auto_scan))
        .bind(job.scan_interval_days)
        .bind(&job.gateway_ref)
        .bind(i64::from(job.allow_internal))
        .bind(&job.last_scan_at)
        .bind(&job.status)
        .bind(job.version)
        .bind(&job.created_at)
        .bind(&job.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_discovery_job(
        &self,
        organization_id: &str,
        job_id: &str,
    ) -> anyhow::Result<Option<StoredDiscoveryJob>> {
        let row = sqlx::query("SELECT * FROM discovery_jobs WHERE organization_id = ? AND id = ?")
            .bind(organization_id)
            .bind(job_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.as_ref().map(stored_discovery_job))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_discovery_jobs(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Vec<StoredDiscoveryJob>> {
        let rows =
            sqlx::query("SELECT * FROM discovery_jobs WHERE organization_id = ? ORDER BY name, id")
                .bind(organization_id)
                .fetch_all(&self.pool)
                .await?;
        Ok(rows.iter().map(stored_discovery_job).collect())
    }

    /// # Errors
    ///
    /// Returns an error when validation or the update fails.
    pub async fn update_discovery_job(&self, job: &StoredDiscoveryJob) -> anyhow::Result<bool> {
        validate_json_document(&job.targets_json, "discovery targets")?;
        validate_json_document(&job.ports_json, "discovery ports")?;
        let result = sqlx::query(
            "UPDATE discovery_jobs SET name = ?, description = ?, targets_json = ?, ports_json = ?, auto_scan = ?, scan_interval_days = ?, gateway_ref = ?, allow_internal = ?, last_scan_at = ?, status = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ?",
        )
        .bind(&job.name)
        .bind(&job.description)
        .bind(&job.targets_json)
        .bind(&job.ports_json)
        .bind(i64::from(job.auto_scan))
        .bind(job.scan_interval_days)
        .bind(&job.gateway_ref)
        .bind(i64::from(job.allow_internal))
        .bind(&job.last_scan_at)
        .bind(&job.status)
        .bind(now_rfc3339())
        .bind(&job.organization_id)
        .bind(&job.id)
        .bind(job.version)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the deletion fails.
    pub async fn delete_discovery_job(
        &self,
        organization_id: &str,
        job_id: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query("DELETE FROM discovery_jobs WHERE organization_id = ? AND id = ?")
            .bind(organization_id)
            .bind(job_id)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Insert or refresh one observed TLS installation.
    ///
    /// # Errors
    ///
    /// Returns an error when the change log is malformed or the upsert fails.
    pub async fn record_installation(
        &self,
        installation: &StoredDiscoveryInstallation,
    ) -> anyhow::Result<()> {
        validate_json_document(&installation.change_log_json, "discovery change log")?;
        sqlx::query(
            "INSERT INTO discovery_installations (id, organization_id, job_id, host, port, fingerprint_sha256, cn, issuer, not_after, first_seen_at, last_seen_at, change_log_json, matched_certificate_id, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(organization_id, job_id, host, port) DO UPDATE SET \
               fingerprint_sha256 = excluded.fingerprint_sha256, cn = excluded.cn, issuer = excluded.issuer, \
               not_after = excluded.not_after, last_seen_at = excluded.last_seen_at, \
               change_log_json = excluded.change_log_json, matched_certificate_id = excluded.matched_certificate_id, \
               version = discovery_installations.version + 1, updated_at = excluded.updated_at",
        )
        .bind(&installation.id)
        .bind(&installation.organization_id)
        .bind(&installation.job_id)
        .bind(&installation.host)
        .bind(installation.port)
        .bind(&installation.fingerprint_sha256)
        .bind(&installation.cn)
        .bind(&installation.issuer)
        .bind(&installation.not_after)
        .bind(&installation.first_seen_at)
        .bind(&installation.last_seen_at)
        .bind(&installation.change_log_json)
        .bind(&installation.matched_certificate_id)
        .bind(installation.version)
        .bind(&installation.created_at)
        .bind(&installation.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_installations(
        &self,
        organization_id: &str,
        job_id: Option<&str>,
    ) -> anyhow::Result<Vec<StoredDiscoveryInstallation>> {
        let rows = match job_id {
            Some(job_id) => {
                sqlx::query(
                    "SELECT * FROM discovery_installations WHERE organization_id = ? AND job_id = ? ORDER BY host, port",
                )
                .bind(organization_id)
                .bind(job_id)
                .fetch_all(&self.pool)
                .await?
            }
            None => {
                sqlx::query(
                    "SELECT * FROM discovery_installations WHERE organization_id = ? ORDER BY host, port",
                )
                .bind(organization_id)
                .fetch_all(&self.pool)
                .await?
            }
        };
        Ok(rows.iter().map(stored_discovery_installation).collect())
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn match_installation_by_fingerprint(
        &self,
        organization_id: &str,
        fingerprint_sha256: &str,
    ) -> anyhow::Result<Vec<StoredDiscoveryInstallation>> {
        let rows = sqlx::query(
            "SELECT * FROM discovery_installations WHERE organization_id = ? AND fingerprint_sha256 = ? ORDER BY host, port",
        )
        .bind(organization_id)
        .bind(fingerprint_sha256)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_discovery_installation).collect())
    }

    // —— approvals ——————————————————————————————————————————————————

    /// # Errors
    ///
    /// Returns an error when `covers_json` is malformed or the insert fails.
    pub async fn insert_approval_policy(
        &self,
        policy: &StoredApprovalPolicy,
    ) -> anyhow::Result<()> {
        validate_json_document(&policy.covers_json, "approval policy coverage")?;
        self.ensure_organization_row(&policy.organization_id, &policy.created_at)
            .await?;
        sqlx::query(
            "INSERT INTO approval_policies (id, organization_id, scope, application_id, signer_id, name, max_request_ttl_seconds, machine_bypass, covers_json, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&policy.id)
        .bind(&policy.organization_id)
        .bind(&policy.scope)
        .bind(&policy.application_id)
        .bind(&policy.signer_id)
        .bind(&policy.name)
        .bind(policy.max_request_ttl_seconds)
        .bind(i64::from(policy.machine_bypass))
        .bind(&policy.covers_json)
        .bind(policy.version)
        .bind(&policy.created_at)
        .bind(&policy.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_approval_policy(
        &self,
        organization_id: &str,
        policy_id: &str,
    ) -> anyhow::Result<Option<StoredApprovalPolicy>> {
        let row =
            sqlx::query("SELECT * FROM approval_policies WHERE organization_id = ? AND id = ?")
                .bind(organization_id)
                .bind(policy_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.as_ref().map(stored_approval_policy))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_approval_policies(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Vec<StoredApprovalPolicy>> {
        let rows = sqlx::query(
            "SELECT * FROM approval_policies WHERE organization_id = ? ORDER BY name, id",
        )
        .bind(organization_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_approval_policy).collect())
    }

    /// # Errors
    ///
    /// Returns an error when validation or the update fails.
    pub async fn update_approval_policy(
        &self,
        policy: &StoredApprovalPolicy,
    ) -> anyhow::Result<bool> {
        validate_json_document(&policy.covers_json, "approval policy coverage")?;
        let result = sqlx::query(
            "UPDATE approval_policies SET name = ?, max_request_ttl_seconds = ?, machine_bypass = ?, covers_json = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ?",
        )
        .bind(&policy.name)
        .bind(policy.max_request_ttl_seconds)
        .bind(i64::from(policy.machine_bypass))
        .bind(&policy.covers_json)
        .bind(now_rfc3339())
        .bind(&policy.organization_id)
        .bind(&policy.id)
        .bind(policy.version)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the deletion fails.
    pub async fn delete_approval_policy(
        &self,
        organization_id: &str,
        policy_id: &str,
    ) -> anyhow::Result<bool> {
        let result =
            sqlx::query("DELETE FROM approval_policies WHERE organization_id = ? AND id = ?")
                .bind(organization_id)
                .bind(policy_id)
                .execute(&self.pool)
                .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when `approvers_json` is malformed or the insert fails.
    pub async fn insert_approval_step(&self, step: &StoredApprovalStep) -> anyhow::Result<()> {
        validate_json_document(&step.approvers_json, "approval step approvers")?;
        sqlx::query(
            "INSERT INTO approval_steps (id, organization_id, policy_id, seq, name, approvers_json, required_count, notify, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&step.id)
        .bind(&step.organization_id)
        .bind(&step.policy_id)
        .bind(step.seq)
        .bind(&step.name)
        .bind(&step.approvers_json)
        .bind(step.required_count)
        .bind(i64::from(step.notify))
        .bind(step.version)
        .bind(&step.created_at)
        .bind(&step.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_steps_for_policy(
        &self,
        organization_id: &str,
        policy_id: &str,
    ) -> anyhow::Result<Vec<StoredApprovalStep>> {
        let rows = sqlx::query(
            "SELECT * FROM approval_steps WHERE organization_id = ? AND policy_id = ? ORDER BY seq",
        )
        .bind(organization_id)
        .bind(policy_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_approval_step).collect())
    }

    /// # Errors
    ///
    /// Returns an error when the deletion fails.
    pub async fn delete_approval_step(
        &self,
        organization_id: &str,
        step_id: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query("DELETE FROM approval_steps WHERE organization_id = ? AND id = ?")
            .bind(organization_id)
            .bind(step_id)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when `scope_json` is malformed or the insert fails.
    pub async fn insert_approval_request(
        &self,
        request: &StoredApprovalRequest,
    ) -> anyhow::Result<()> {
        validate_json_document(&request.scope_json, "approval request scope")?;
        sqlx::query(
            "INSERT INTO approval_requests (id, organization_id, policy_id, kind, requester, status, current_step, expires_at, payload_digest, scope_json, result_id, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&request.id)
        .bind(&request.organization_id)
        .bind(&request.policy_id)
        .bind(&request.kind)
        .bind(&request.requester)
        .bind(&request.status)
        .bind(request.current_step)
        .bind(&request.expires_at)
        .bind(&request.payload_digest)
        .bind(&request.scope_json)
        .bind(&request.result_id)
        .bind(request.version)
        .bind(&request.created_at)
        .bind(&request.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_approval_request(
        &self,
        organization_id: &str,
        request_id: &str,
    ) -> anyhow::Result<Option<StoredApprovalRequest>> {
        let row =
            sqlx::query("SELECT * FROM approval_requests WHERE organization_id = ? AND id = ?")
                .bind(organization_id)
                .bind(request_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.as_ref().map(stored_approval_request))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_approval_requests(
        &self,
        organization_id: &str,
        status: Option<&str>,
    ) -> anyhow::Result<Vec<StoredApprovalRequest>> {
        let rows = match status {
            Some(status) => {
                sqlx::query(
                    "SELECT * FROM approval_requests WHERE organization_id = ? AND status = ? ORDER BY created_at, id",
                )
                .bind(organization_id)
                .bind(status)
                .fetch_all(&self.pool)
                .await?
            }
            None => {
                sqlx::query(
                    "SELECT * FROM approval_requests WHERE organization_id = ? ORDER BY created_at, id",
                )
                .bind(organization_id)
                .fetch_all(&self.pool)
                .await?
            }
        };
        Ok(rows.iter().map(stored_approval_request).collect())
    }

    /// Compare-and-set the request status, optionally advancing the step and
    /// recording the produced artifact.
    ///
    /// # Errors
    ///
    /// Returns an error when the request is absent from the organization or is
    /// not currently in `from_status`.
    pub async fn transition_approval_request(
        &self,
        organization_id: &str,
        request_id: &str,
        from_status: &str,
        to_status: &str,
    ) -> anyhow::Result<()> {
        let result = sqlx::query(
            "UPDATE approval_requests SET status = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND status = ?",
        )
        .bind(to_status)
        .bind(now_rfc3339())
        .bind(organization_id)
        .bind(request_id)
        .bind(from_status)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() != 1 {
            anyhow::bail!("approval request is not in the expected state");
        }
        Ok(())
    }

    /// Advance an open request to the next approval step.
    ///
    /// # Errors
    ///
    /// Returns an error when the request is absent, closed, or not on
    /// `from_step`.
    pub async fn advance_approval_step(
        &self,
        organization_id: &str,
        request_id: &str,
        from_step: i64,
    ) -> anyhow::Result<i64> {
        let result = sqlx::query(
            "UPDATE approval_requests SET current_step = current_step + 1, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND status = 'open' AND current_step = ?",
        )
        .bind(now_rfc3339())
        .bind(organization_id)
        .bind(request_id)
        .bind(from_step)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() != 1 {
            anyhow::bail!("approval request is not open on the expected step");
        }
        Ok(from_step + 1)
    }

    /// Attach the artifact an approved request produced.
    ///
    /// # Errors
    ///
    /// Returns an error when the update fails.
    pub async fn set_approval_result(
        &self,
        organization_id: &str,
        request_id: &str,
        result_id: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query(
            "UPDATE approval_requests SET result_id = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ?",
        )
        .bind(result_id)
        .bind(now_rfc3339())
        .bind(organization_id)
        .bind(request_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the insert fails, including a replayed decision
    /// from the same approver on the same step.
    pub async fn insert_approval_decision(
        &self,
        decision: &StoredApprovalDecision,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO approval_decisions (id, organization_id, request_id, step_seq, approver, decision, comment, decided_at, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&decision.id)
        .bind(&decision.organization_id)
        .bind(&decision.request_id)
        .bind(decision.step_seq)
        .bind(&decision.approver)
        .bind(&decision.decision)
        .bind(&decision.comment)
        .bind(&decision.decided_at)
        .bind(decision.version)
        .bind(&decision.created_at)
        .bind(&decision.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_decisions_for_request(
        &self,
        organization_id: &str,
        request_id: &str,
    ) -> anyhow::Result<Vec<StoredApprovalDecision>> {
        let rows = sqlx::query(
            "SELECT * FROM approval_decisions WHERE organization_id = ? AND request_id = ? ORDER BY step_seq, approver",
        )
        .bind(organization_id)
        .bind(request_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_approval_decision).collect())
    }

    /// Evaluate the request's current step against the decisions recorded for
    /// it. A single rejection is terminal; otherwise the step is satisfied once
    /// distinct approvers reach the step's `required_count`.
    ///
    /// # Errors
    ///
    /// Returns an error when the request or its current step is absent from the
    /// organization, or when a query fails.
    pub async fn approval_step_outcome(
        &self,
        organization_id: &str,
        request_id: &str,
    ) -> anyhow::Result<ApprovalStepOutcome> {
        let request = self
            .get_approval_request(organization_id, request_id)
            .await?
            .context("approval request is not in this organization")?;
        let required = sqlx::query_scalar::<_, i64>(
            "SELECT required_count FROM approval_steps WHERE organization_id = ? AND policy_id = ? AND seq = ?",
        )
        .bind(organization_id)
        .bind(&request.policy_id)
        .bind(request.current_step)
        .fetch_optional(&self.pool)
        .await?
        .context("approval policy has no step at the request's position")?;
        let rejected = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM approval_decisions WHERE organization_id = ? AND request_id = ? AND step_seq = ? AND decision = 'reject'",
        )
        .bind(organization_id)
        .bind(request_id)
        .bind(request.current_step)
        .fetch_one(&self.pool)
        .await?;
        if rejected > 0 {
            return Ok(ApprovalStepOutcome::Rejected);
        }
        let approvals = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(DISTINCT approver) FROM approval_decisions WHERE organization_id = ? AND request_id = ? AND step_seq = ? AND decision = 'approve'",
        )
        .bind(organization_id)
        .bind(request_id)
        .bind(request.current_step)
        .fetch_one(&self.pool)
        .await?;
        if approvals >= required {
            return Ok(ApprovalStepOutcome::StepSatisfied);
        }
        Ok(ApprovalStepOutcome::Pending)
    }

    // —— code signing ——————————————————————————————————————————————

    /// # Errors
    ///
    /// Returns an error when the sealed key group is partially populated or the
    /// insert fails.
    pub async fn insert_signer(&self, signer: &StoredSigner) -> anyhow::Result<()> {
        validate_optional_sealed_material(signer.sealed_key.as_ref())?;
        self.ensure_organization_row(&signer.organization_id, &signer.created_at)
            .await?;
        let (key_id, ciphertext, nonce, aad_digest) = sealed_parts(signer.sealed_key.as_ref());
        sqlx::query(
            "INSERT INTO signers (id, organization_id, name, certificate_id, key_source, hsm_connector_id, hsm_key_label, status, auto_renew, renew_before_seconds, sealed_key_key_id, sealed_key_ciphertext, sealed_key_nonce, sealed_key_aad_digest, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&signer.id)
        .bind(&signer.organization_id)
        .bind(&signer.name)
        .bind(&signer.certificate_id)
        .bind(&signer.key_source)
        .bind(&signer.hsm_connector_id)
        .bind(&signer.hsm_key_label)
        .bind(&signer.status)
        .bind(i64::from(signer.auto_renew))
        .bind(signer.renew_before_seconds)
        .bind(key_id)
        .bind(ciphertext)
        .bind(nonce)
        .bind(aad_digest)
        .bind(signer.version)
        .bind(&signer.created_at)
        .bind(&signer.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_signer(
        &self,
        organization_id: &str,
        signer_id: &str,
    ) -> anyhow::Result<Option<StoredSigner>> {
        let row = sqlx::query("SELECT * FROM signers WHERE organization_id = ? AND id = ?")
            .bind(organization_id)
            .bind(signer_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.as_ref().map(stored_signer))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_signers(&self, organization_id: &str) -> anyhow::Result<Vec<StoredSigner>> {
        let rows = sqlx::query("SELECT * FROM signers WHERE organization_id = ? ORDER BY name, id")
            .bind(organization_id)
            .fetch_all(&self.pool)
            .await?;
        Ok(rows.iter().map(stored_signer).collect())
    }

    /// # Errors
    ///
    /// Returns an error when validation or the update fails.
    pub async fn update_signer(&self, signer: &StoredSigner) -> anyhow::Result<bool> {
        validate_optional_sealed_material(signer.sealed_key.as_ref())?;
        let (key_id, ciphertext, nonce, aad_digest) = sealed_parts(signer.sealed_key.as_ref());
        let result = sqlx::query(
            "UPDATE signers SET name = ?, certificate_id = ?, key_source = ?, hsm_connector_id = ?, hsm_key_label = ?, status = ?, auto_renew = ?, renew_before_seconds = ?, sealed_key_key_id = ?, sealed_key_ciphertext = ?, sealed_key_nonce = ?, sealed_key_aad_digest = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ?",
        )
        .bind(&signer.name)
        .bind(&signer.certificate_id)
        .bind(&signer.key_source)
        .bind(&signer.hsm_connector_id)
        .bind(&signer.hsm_key_label)
        .bind(&signer.status)
        .bind(i64::from(signer.auto_renew))
        .bind(signer.renew_before_seconds)
        .bind(key_id)
        .bind(ciphertext)
        .bind(nonce)
        .bind(aad_digest)
        .bind(now_rfc3339())
        .bind(&signer.organization_id)
        .bind(&signer.id)
        .bind(signer.version)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the deletion fails.
    pub async fn delete_signer(
        &self,
        organization_id: &str,
        signer_id: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query("DELETE FROM signers WHERE organization_id = ? AND id = ?")
            .bind(organization_id)
            .bind(signer_id)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the upsert fails.
    pub async fn upsert_signer_member(&self, member: &StoredSignerMember) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO signer_members (id, organization_id, signer_id, subject, role, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(organization_id, signer_id, subject) \
             DO UPDATE SET role = excluded.role, version = signer_members.version + 1, updated_at = excluded.updated_at",
        )
        .bind(&member.id)
        .bind(&member.organization_id)
        .bind(&member.signer_id)
        .bind(&member.subject)
        .bind(&member.role)
        .bind(member.version)
        .bind(&member.created_at)
        .bind(&member.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_signer_members(
        &self,
        organization_id: &str,
        signer_id: &str,
    ) -> anyhow::Result<Vec<StoredSignerMember>> {
        let rows = sqlx::query(
            "SELECT * FROM signer_members WHERE organization_id = ? AND signer_id = ? ORDER BY subject",
        )
        .bind(organization_id)
        .bind(signer_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_signer_member).collect())
    }

    /// # Errors
    ///
    /// Returns an error when the deletion fails.
    pub async fn remove_signer_member(
        &self,
        organization_id: &str,
        signer_id: &str,
        subject: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query(
            "DELETE FROM signer_members WHERE organization_id = ? AND signer_id = ? AND subject = ?",
        )
        .bind(organization_id)
        .bind(signer_id)
        .bind(subject)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Resolve a subject's effective role on a signer.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn effective_signer_role(
        &self,
        organization_id: &str,
        signer_id: &str,
        subject: &str,
    ) -> anyhow::Result<Option<Role>> {
        let row = sqlx::query(
            "SELECT role FROM signer_members WHERE organization_id = ? AND signer_id = ? AND subject = ?",
        )
        .bind(organization_id)
        .bind(signer_id)
        .bind(subject)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.and_then(|row| Role::from_signer_str(&row.get::<String, _>("role"))))
    }

    /// # Errors
    ///
    /// Returns an error when `scope_json` is malformed or the insert fails.
    pub async fn insert_signing_access_record(
        &self,
        record: &StoredSigningAccessRecord,
    ) -> anyhow::Result<()> {
        validate_json_document(&record.scope_json, "signing access scope")?;
        sqlx::query(
            "INSERT INTO signing_access_records (id, organization_id, signer_id, approval_request_id, status, signatures_allowed, signatures_used, window_expires_at, scope_json, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&record.id)
        .bind(&record.organization_id)
        .bind(&record.signer_id)
        .bind(&record.approval_request_id)
        .bind(&record.status)
        .bind(record.signatures_allowed)
        .bind(record.signatures_used)
        .bind(&record.window_expires_at)
        .bind(&record.scope_json)
        .bind(record.version)
        .bind(&record.created_at)
        .bind(&record.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_signing_access_record(
        &self,
        organization_id: &str,
        record_id: &str,
    ) -> anyhow::Result<Option<StoredSigningAccessRecord>> {
        let row = sqlx::query(
            "SELECT * FROM signing_access_records WHERE organization_id = ? AND id = ?",
        )
        .bind(organization_id)
        .bind(record_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(stored_signing_access_record))
    }

    /// Access records that are still usable for a signer right now.
    ///
    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_active_records(
        &self,
        organization_id: &str,
        signer_id: &str,
    ) -> anyhow::Result<Vec<StoredSigningAccessRecord>> {
        let rows = sqlx::query(
            "SELECT * FROM signing_access_records \
             WHERE organization_id = ? AND signer_id = ? AND status = 'active' \
               AND (window_expires_at IS NULL OR julianday(window_expires_at) > julianday(?)) \
             ORDER BY created_at, id",
        )
        .bind(organization_id)
        .bind(signer_id)
        .bind(now_rfc3339())
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_signing_access_record).collect())
    }

    /// Consume one signature against an access record.
    ///
    /// The increment is a single conditional statement, so racing signers
    /// cannot together exceed the cap.
    ///
    /// # Errors
    ///
    /// Returns an error when the record is absent, inactive, past its window,
    /// or already at its signature cap.
    pub async fn increment_signature_count(
        &self,
        organization_id: &str,
        record_id: &str,
    ) -> anyhow::Result<u32> {
        let now = now_rfc3339();
        let mut transaction = self.pool.begin().await?;
        let updated = sqlx::query(
            "UPDATE signing_access_records SET signatures_used = signatures_used + 1, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND status = 'active' \
               AND (signatures_allowed IS NULL OR signatures_used < signatures_allowed) \
               AND (window_expires_at IS NULL OR julianday(window_expires_at) > julianday(?))",
        )
        .bind(&now)
        .bind(organization_id)
        .bind(record_id)
        .bind(&now)
        .execute(&mut *transaction)
        .await?;
        if updated.rows_affected() != 1 {
            transaction.rollback().await?;
            anyhow::bail!("signing access record is exhausted, expired, or inactive");
        }
        let used = sqlx::query_scalar::<_, i64>(
            "SELECT signatures_used FROM signing_access_records WHERE organization_id = ? AND id = ?",
        )
        .bind(organization_id)
        .bind(record_id)
        .fetch_one(&mut *transaction)
        .await?;
        transaction.commit().await?;
        u32::try_from(used).context("signature count exceeds the supported range")
    }

    /// # Errors
    ///
    /// Returns an error when the update fails.
    pub async fn revoke_access_record(
        &self,
        organization_id: &str,
        record_id: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query(
            "UPDATE signing_access_records SET status = 'revoked', version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND status <> 'revoked'",
        )
        .bind(now_rfc3339())
        .bind(organization_id)
        .bind(record_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Append one entry to the code-signing activity ledger. Callers redact
    /// credential arguments from `command` before writing.
    ///
    /// # Errors
    ///
    /// Returns an error when the insert fails.
    pub async fn append_signing_event(&self, event: &StoredSigningEvent) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO signing_events (id, organization_id, signer_id, access_record_id, outcome, command, application_name, application_sha256, hostname, os_username, ip, data_hash, occurred_at, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&event.id)
        .bind(&event.organization_id)
        .bind(&event.signer_id)
        .bind(&event.access_record_id)
        .bind(&event.outcome)
        .bind(&event.command)
        .bind(&event.application_name)
        .bind(&event.application_sha256)
        .bind(&event.hostname)
        .bind(&event.os_username)
        .bind(&event.ip)
        .bind(&event.data_hash)
        .bind(&event.occurred_at)
        .bind(event.version)
        .bind(&event.created_at)
        .bind(&event.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_signing_events(
        &self,
        organization_id: &str,
        signer_id: &str,
    ) -> anyhow::Result<Vec<StoredSigningEvent>> {
        let rows = sqlx::query(
            "SELECT * FROM signing_events WHERE organization_id = ? AND signer_id = ? ORDER BY occurred_at, id",
        )
        .bind(organization_id)
        .bind(signer_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_signing_event).collect())
    }

    // —— lifecycle alerting ————————————————————————————————————————

    /// # Errors
    ///
    /// Returns an error when `channels_json` is malformed or the insert fails.
    pub async fn insert_cert_alert(&self, alert: &StoredCertAlert) -> anyhow::Result<()> {
        validate_json_document(&alert.channels_json, "alert channels")?;
        sqlx::query(
            "INSERT INTO cert_alerts (id, organization_id, application_id, type, before_window_seconds, daily_reminder, channels_json, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&alert.id)
        .bind(&alert.organization_id)
        .bind(&alert.application_id)
        .bind(&alert.alert_type)
        .bind(alert.before_window_seconds)
        .bind(i64::from(alert.daily_reminder))
        .bind(&alert.channels_json)
        .bind(alert.version)
        .bind(&alert.created_at)
        .bind(&alert.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_cert_alert(
        &self,
        organization_id: &str,
        alert_id: &str,
    ) -> anyhow::Result<Option<StoredCertAlert>> {
        let row = sqlx::query("SELECT * FROM cert_alerts WHERE organization_id = ? AND id = ?")
            .bind(organization_id)
            .bind(alert_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.as_ref().map(stored_cert_alert))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_cert_alerts(
        &self,
        organization_id: &str,
        application_id: &str,
    ) -> anyhow::Result<Vec<StoredCertAlert>> {
        let rows = sqlx::query(
            "SELECT * FROM cert_alerts WHERE organization_id = ? AND application_id = ? ORDER BY type, id",
        )
        .bind(organization_id)
        .bind(application_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_cert_alert).collect())
    }

    /// # Errors
    ///
    /// Returns an error when validation or the update fails.
    pub async fn update_cert_alert(&self, alert: &StoredCertAlert) -> anyhow::Result<bool> {
        validate_json_document(&alert.channels_json, "alert channels")?;
        let result = sqlx::query(
            "UPDATE cert_alerts SET type = ?, before_window_seconds = ?, daily_reminder = ?, channels_json = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ?",
        )
        .bind(&alert.alert_type)
        .bind(alert.before_window_seconds)
        .bind(i64::from(alert.daily_reminder))
        .bind(&alert.channels_json)
        .bind(now_rfc3339())
        .bind(&alert.organization_id)
        .bind(&alert.id)
        .bind(alert.version)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the deletion fails.
    pub async fn delete_cert_alert(
        &self,
        organization_id: &str,
        alert_id: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query("DELETE FROM cert_alerts WHERE organization_id = ? AND id = ?")
            .bind(organization_id)
            .bind(alert_id)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the insert fails.
    pub async fn record_alert_delivery(
        &self,
        delivery: &StoredAlertDelivery,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO alert_deliveries (id, organization_id, alert_id, channel, outcome, attempts, last_attempt_at, payload_digest, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&delivery.id)
        .bind(&delivery.organization_id)
        .bind(&delivery.alert_id)
        .bind(&delivery.channel)
        .bind(&delivery.outcome)
        .bind(delivery.attempts)
        .bind(&delivery.last_attempt_at)
        .bind(&delivery.payload_digest)
        .bind(delivery.version)
        .bind(&delivery.created_at)
        .bind(&delivery.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_alert_deliveries(
        &self,
        organization_id: &str,
        alert_id: &str,
    ) -> anyhow::Result<Vec<StoredAlertDelivery>> {
        let rows = sqlx::query(
            "SELECT * FROM alert_deliveries WHERE organization_id = ? AND alert_id = ? ORDER BY created_at, id",
        )
        .bind(organization_id)
        .bind(alert_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_alert_delivery).collect())
    }

    // —— certificate syncs ————————————————————————————————————————

    /// # Errors
    ///
    /// Returns an error when `options_json` is malformed or the insert fails.
    pub async fn insert_cert_sync(&self, sync: &StoredCertSync) -> anyhow::Result<()> {
        validate_json_document(&sync.options_json, "certificate sync options")?;
        sqlx::query(
            "INSERT INTO cert_syncs (id, organization_id, certificate_id, destination_kind, connection_id, name_schema, remove_on_expiry, include_root, options_json, enabled, last_run_at, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&sync.id)
        .bind(&sync.organization_id)
        .bind(&sync.certificate_id)
        .bind(&sync.destination_kind)
        .bind(&sync.connection_id)
        .bind(&sync.name_schema)
        .bind(i64::from(sync.remove_on_expiry))
        .bind(i64::from(sync.include_root))
        .bind(&sync.options_json)
        .bind(i64::from(sync.enabled))
        .bind(&sync.last_run_at)
        .bind(sync.version)
        .bind(&sync.created_at)
        .bind(&sync.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_cert_sync(
        &self,
        organization_id: &str,
        sync_id: &str,
    ) -> anyhow::Result<Option<StoredCertSync>> {
        let row = sqlx::query("SELECT * FROM cert_syncs WHERE organization_id = ? AND id = ?")
            .bind(organization_id)
            .bind(sync_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.as_ref().map(stored_cert_sync))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_cert_syncs(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Vec<StoredCertSync>> {
        let rows = sqlx::query(
            "SELECT * FROM cert_syncs WHERE organization_id = ? ORDER BY certificate_id, id",
        )
        .bind(organization_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_cert_sync).collect())
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_active_syncs_for_certificate(
        &self,
        organization_id: &str,
        certificate_id: &str,
    ) -> anyhow::Result<Vec<StoredCertSync>> {
        let rows = sqlx::query(
            "SELECT * FROM cert_syncs WHERE organization_id = ? AND certificate_id = ? AND enabled = 1 ORDER BY destination_kind, id",
        )
        .bind(organization_id)
        .bind(certificate_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_cert_sync).collect())
    }

    /// # Errors
    ///
    /// Returns an error when validation or the update fails.
    pub async fn update_cert_sync(&self, sync: &StoredCertSync) -> anyhow::Result<bool> {
        validate_json_document(&sync.options_json, "certificate sync options")?;
        let result = sqlx::query(
            "UPDATE cert_syncs SET destination_kind = ?, connection_id = ?, name_schema = ?, remove_on_expiry = ?, include_root = ?, options_json = ?, enabled = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ?",
        )
        .bind(&sync.destination_kind)
        .bind(&sync.connection_id)
        .bind(&sync.name_schema)
        .bind(i64::from(sync.remove_on_expiry))
        .bind(i64::from(sync.include_root))
        .bind(&sync.options_json)
        .bind(i64::from(sync.enabled))
        .bind(now_rfc3339())
        .bind(&sync.organization_id)
        .bind(&sync.id)
        .bind(sync.version)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the deletion fails.
    pub async fn delete_cert_sync(
        &self,
        organization_id: &str,
        sync_id: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query("DELETE FROM cert_syncs WHERE organization_id = ? AND id = ?")
            .bind(organization_id)
            .bind(sync_id)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Append a sync run and stamp the parent sync in the same transaction.
    ///
    /// # Errors
    ///
    /// Returns an error when the sync is absent from the organization or the
    /// transaction fails.
    pub async fn record_sync_run(&self, run: &StoredSyncRun) -> anyhow::Result<()> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO sync_runs (id, organization_id, sync_id, outcome, detail, ran_at, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&run.id)
        .bind(&run.organization_id)
        .bind(&run.sync_id)
        .bind(&run.outcome)
        .bind(&run.detail)
        .bind(&run.ran_at)
        .bind(run.version)
        .bind(&run.created_at)
        .bind(&run.updated_at)
        .execute(&mut *transaction)
        .await?;
        let updated = sqlx::query(
            "UPDATE cert_syncs SET last_run_at = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ?",
        )
        .bind(&run.ran_at)
        .bind(now_rfc3339())
        .bind(&run.organization_id)
        .bind(&run.sync_id)
        .execute(&mut *transaction)
        .await?;
        if updated.rows_affected() != 1 {
            transaction.rollback().await?;
            anyhow::bail!("sync run target is not in this organization");
        }
        transaction.commit().await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_sync_runs(
        &self,
        organization_id: &str,
        sync_id: &str,
    ) -> anyhow::Result<Vec<StoredSyncRun>> {
        let rows = sqlx::query(
            "SELECT * FROM sync_runs WHERE organization_id = ? AND sync_id = ? ORDER BY ran_at, id",
        )
        .bind(organization_id)
        .bind(sync_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_sync_run).collect())
    }

    // —— HSM connectors ————————————————————————————————————————————

    /// # Errors
    ///
    /// Returns an error when the sealed PIN group is partially populated or the
    /// insert fails.
    pub async fn insert_hsm_connector(&self, connector: &StoredHsmConnector) -> anyhow::Result<()> {
        validate_optional_sealed_material(connector.sealed_pin.as_ref())?;
        self.ensure_organization_row(&connector.organization_id, &connector.created_at)
            .await?;
        let (key_id, ciphertext, nonce, aad_digest) = sealed_parts(connector.sealed_pin.as_ref());
        sqlx::query(
            "INSERT INTO hsm_connectors (id, organization_id, label, sealed_pin_key_id, sealed_pin_ciphertext, sealed_pin_nonce, sealed_pin_aad_digest, module_hint, key_label_prefix, gateway_ref, status, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&connector.id)
        .bind(&connector.organization_id)
        .bind(&connector.label)
        .bind(key_id)
        .bind(ciphertext)
        .bind(nonce)
        .bind(aad_digest)
        .bind(&connector.module_hint)
        .bind(&connector.key_label_prefix)
        .bind(&connector.gateway_ref)
        .bind(&connector.status)
        .bind(connector.version)
        .bind(&connector.created_at)
        .bind(&connector.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_hsm_connector(
        &self,
        organization_id: &str,
        connector_id: &str,
    ) -> anyhow::Result<Option<StoredHsmConnector>> {
        let row = sqlx::query("SELECT * FROM hsm_connectors WHERE organization_id = ? AND id = ?")
            .bind(organization_id)
            .bind(connector_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.as_ref().map(stored_hsm_connector))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_hsm_connectors(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Vec<StoredHsmConnector>> {
        let rows = sqlx::query(
            "SELECT * FROM hsm_connectors WHERE organization_id = ? ORDER BY label, id",
        )
        .bind(organization_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_hsm_connector).collect())
    }

    /// # Errors
    ///
    /// Returns an error when validation or the update fails.
    pub async fn update_hsm_connector(
        &self,
        connector: &StoredHsmConnector,
    ) -> anyhow::Result<bool> {
        validate_optional_sealed_material(connector.sealed_pin.as_ref())?;
        let (key_id, ciphertext, nonce, aad_digest) = sealed_parts(connector.sealed_pin.as_ref());
        let result = sqlx::query(
            "UPDATE hsm_connectors SET label = ?, sealed_pin_key_id = ?, sealed_pin_ciphertext = ?, sealed_pin_nonce = ?, sealed_pin_aad_digest = ?, module_hint = ?, key_label_prefix = ?, gateway_ref = ?, status = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ?",
        )
        .bind(&connector.label)
        .bind(key_id)
        .bind(ciphertext)
        .bind(nonce)
        .bind(aad_digest)
        .bind(&connector.module_hint)
        .bind(&connector.key_label_prefix)
        .bind(&connector.gateway_ref)
        .bind(&connector.status)
        .bind(now_rfc3339())
        .bind(&connector.organization_id)
        .bind(&connector.id)
        .bind(connector.version)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the deletion fails.
    pub async fn delete_hsm_connector(
        &self,
        organization_id: &str,
        connector_id: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query("DELETE FROM hsm_connectors WHERE organization_id = ? AND id = ?")
            .bind(organization_id)
            .bind(connector_id)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() == 1)
    }

    // —— external certificate authorities ——————————————————————————

    /// # Errors
    ///
    /// Returns an error when `config_json` is malformed or the insert fails.
    pub async fn insert_external_ca_config(
        &self,
        config: &StoredExternalCaConfig,
    ) -> anyhow::Result<()> {
        validate_json_document(&config.config_json, "external CA configuration")?;
        self.ensure_organization_row(&config.organization_id, &config.created_at)
            .await?;
        sqlx::query(
            "INSERT INTO external_ca_configs (id, organization_id, kind, connection_id, config_json, trust_class, auto_renew, renew_before_seconds, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&config.id)
        .bind(&config.organization_id)
        .bind(&config.kind)
        .bind(&config.connection_id)
        .bind(&config.config_json)
        .bind(&config.trust_class)
        .bind(i64::from(config.auto_renew))
        .bind(config.renew_before_seconds)
        .bind(config.version)
        .bind(&config.created_at)
        .bind(&config.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_external_ca_config(
        &self,
        organization_id: &str,
        config_id: &str,
    ) -> anyhow::Result<Option<StoredExternalCaConfig>> {
        let row =
            sqlx::query("SELECT * FROM external_ca_configs WHERE organization_id = ? AND id = ?")
                .bind(organization_id)
                .bind(config_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.as_ref().map(stored_external_ca_config))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_external_ca_configs(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Vec<StoredExternalCaConfig>> {
        let rows = sqlx::query(
            "SELECT * FROM external_ca_configs WHERE organization_id = ? ORDER BY kind, id",
        )
        .bind(organization_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_external_ca_config).collect())
    }

    /// # Errors
    ///
    /// Returns an error when validation or the update fails.
    pub async fn update_external_ca_config(
        &self,
        config: &StoredExternalCaConfig,
    ) -> anyhow::Result<bool> {
        validate_json_document(&config.config_json, "external CA configuration")?;
        let result = sqlx::query(
            "UPDATE external_ca_configs SET connection_id = ?, config_json = ?, trust_class = ?, auto_renew = ?, renew_before_seconds = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ?",
        )
        .bind(&config.connection_id)
        .bind(&config.config_json)
        .bind(&config.trust_class)
        .bind(i64::from(config.auto_renew))
        .bind(config.renew_before_seconds)
        .bind(now_rfc3339())
        .bind(&config.organization_id)
        .bind(&config.id)
        .bind(config.version)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the deletion fails.
    pub async fn delete_external_ca_config(
        &self,
        organization_id: &str,
        config_id: &str,
    ) -> anyhow::Result<bool> {
        let result =
            sqlx::query("DELETE FROM external_ca_configs WHERE organization_id = ? AND id = ?")
                .bind(organization_id)
                .bind(config_id)
                .execute(&self.pool)
                .await?;
        Ok(result.rows_affected() == 1)
    }

    // —— ACME server state ————————————————————————————————————————

    /// # Errors
    ///
    /// Returns an error when `contacts_json` is malformed or the insert fails.
    pub async fn insert_acme_account(&self, account: &StoredAcmeAccount) -> anyhow::Result<()> {
        validate_json_document(&account.contacts_json, "ACME account contacts")?;
        sqlx::query(
            "INSERT INTO acme_server_accounts (id, organization_id, profile_id, jwk_thumbprint, eab_kid, status, contacts_json, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&account.id)
        .bind(&account.organization_id)
        .bind(&account.profile_id)
        .bind(&account.jwk_thumbprint)
        .bind(&account.eab_kid)
        .bind(&account.status)
        .bind(&account.contacts_json)
        .bind(account.version)
        .bind(&account.created_at)
        .bind(&account.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_acme_account(
        &self,
        organization_id: &str,
        account_id: &str,
    ) -> anyhow::Result<Option<StoredAcmeAccount>> {
        let row =
            sqlx::query("SELECT * FROM acme_server_accounts WHERE organization_id = ? AND id = ?")
                .bind(organization_id)
                .bind(account_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.as_ref().map(stored_acme_account))
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_acme_account_by_thumbprint(
        &self,
        organization_id: &str,
        profile_id: &str,
        jwk_thumbprint: &str,
    ) -> anyhow::Result<Option<StoredAcmeAccount>> {
        let row = sqlx::query(
            "SELECT * FROM acme_server_accounts WHERE organization_id = ? AND profile_id = ? AND jwk_thumbprint = ?",
        )
        .bind(organization_id)
        .bind(profile_id)
        .bind(jwk_thumbprint)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(stored_acme_account))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_acme_accounts(
        &self,
        organization_id: &str,
        profile_id: &str,
    ) -> anyhow::Result<Vec<StoredAcmeAccount>> {
        let rows = sqlx::query(
            "SELECT * FROM acme_server_accounts WHERE organization_id = ? AND profile_id = ? ORDER BY created_at, id",
        )
        .bind(organization_id)
        .bind(profile_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_acme_account).collect())
    }

    /// # Errors
    ///
    /// Returns an error when the update fails.
    pub async fn update_acme_account_status(
        &self,
        organization_id: &str,
        account_id: &str,
        status: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query(
            "UPDATE acme_server_accounts SET status = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ?",
        )
        .bind(status)
        .bind(now_rfc3339())
        .bind(organization_id)
        .bind(account_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when `identifiers_json` is malformed or the insert
    /// fails.
    pub async fn insert_acme_order(&self, order: &StoredAcmeOrder) -> anyhow::Result<()> {
        validate_json_document(&order.identifiers_json, "ACME order identifiers")?;
        sqlx::query(
            "INSERT INTO acme_orders (id, organization_id, account_id, status, identifiers_json, expires_at, finalize_csr_pem, certificate_id, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&order.id)
        .bind(&order.organization_id)
        .bind(&order.account_id)
        .bind(&order.status)
        .bind(&order.identifiers_json)
        .bind(&order.expires_at)
        .bind(&order.finalize_csr_pem)
        .bind(&order.certificate_id)
        .bind(order.version)
        .bind(&order.created_at)
        .bind(&order.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_acme_order(
        &self,
        organization_id: &str,
        order_id: &str,
    ) -> anyhow::Result<Option<StoredAcmeOrder>> {
        let row = sqlx::query("SELECT * FROM acme_orders WHERE organization_id = ? AND id = ?")
            .bind(organization_id)
            .bind(order_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.as_ref().map(stored_acme_order))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_acme_orders(
        &self,
        organization_id: &str,
        account_id: &str,
    ) -> anyhow::Result<Vec<StoredAcmeOrder>> {
        let rows = sqlx::query(
            "SELECT * FROM acme_orders WHERE organization_id = ? AND account_id = ? ORDER BY created_at, id",
        )
        .bind(organization_id)
        .bind(account_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_acme_order).collect())
    }

    /// Compare-and-set an order's RFC 8555 state.
    ///
    /// # Errors
    ///
    /// Returns an error when the order is absent or not in `from_status`.
    pub async fn transition_acme_order(
        &self,
        organization_id: &str,
        order_id: &str,
        from_status: &str,
        to_status: &str,
    ) -> anyhow::Result<()> {
        let result = sqlx::query(
            "UPDATE acme_orders SET status = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND status = ?",
        )
        .bind(to_status)
        .bind(now_rfc3339())
        .bind(organization_id)
        .bind(order_id)
        .bind(from_status)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() != 1 {
            anyhow::bail!("ACME order is not in the expected state");
        }
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the insert fails.
    pub async fn insert_acme_challenge(
        &self,
        challenge: &StoredAcmeChallenge,
    ) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO acme_challenges (id, organization_id, order_id, authz_id, type, token, status, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&challenge.id)
        .bind(&challenge.organization_id)
        .bind(&challenge.order_id)
        .bind(&challenge.authz_id)
        .bind(&challenge.challenge_type)
        .bind(&challenge.token)
        .bind(&challenge.status)
        .bind(challenge.version)
        .bind(&challenge.created_at)
        .bind(&challenge.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_acme_challenge(
        &self,
        organization_id: &str,
        challenge_id: &str,
    ) -> anyhow::Result<Option<StoredAcmeChallenge>> {
        let row = sqlx::query("SELECT * FROM acme_challenges WHERE organization_id = ? AND id = ?")
            .bind(organization_id)
            .bind(challenge_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.as_ref().map(stored_acme_challenge))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_acme_challenges(
        &self,
        organization_id: &str,
        order_id: &str,
    ) -> anyhow::Result<Vec<StoredAcmeChallenge>> {
        let rows = sqlx::query(
            "SELECT * FROM acme_challenges WHERE organization_id = ? AND order_id = ? ORDER BY authz_id, type",
        )
        .bind(organization_id)
        .bind(order_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_acme_challenge).collect())
    }

    /// # Errors
    ///
    /// Returns an error when the update fails.
    pub async fn update_acme_challenge_status(
        &self,
        organization_id: &str,
        challenge_id: &str,
        status: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query(
            "UPDATE acme_challenges SET status = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ?",
        )
        .bind(status)
        .bind(now_rfc3339())
        .bind(organization_id)
        .bind(challenge_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Mint a fresh single-use ACME replay nonce.
    ///
    /// # Errors
    ///
    /// Returns an error when the insert fails.
    pub async fn mint_acme_nonce(&self, organization_id: &str) -> anyhow::Result<String> {
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        let now = now_rfc3339();
        self.ensure_organization_row(organization_id, &now).await?;
        sqlx::query(
            "INSERT INTO acme_nonces (id, organization_id, nonce, issued_at, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, 1, ?, ?)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(organization_id)
        .bind(&nonce)
        .bind(&now)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        Ok(nonce)
    }

    /// Burn a nonce. The delete is the claim, so exactly one racing caller wins.
    ///
    /// # Errors
    ///
    /// Returns an error when the nonce is unknown or was already consumed.
    pub async fn consume_acme_nonce(
        &self,
        organization_id: &str,
        nonce: &str,
    ) -> anyhow::Result<()> {
        let result = sqlx::query("DELETE FROM acme_nonces WHERE organization_id = ? AND nonce = ?")
            .bind(organization_id)
            .bind(nonce)
            .execute(&self.pool)
            .await?;
        if result.rows_affected() != 1 {
            anyhow::bail!("ACME nonce is unknown or already consumed");
        }
        Ok(())
    }

    // —— EST and SCEP configuration ————————————————————————————————

    /// # Errors
    ///
    /// Returns an error when the sealed passphrase group is partially populated
    /// or the insert fails.
    pub async fn insert_est_config(&self, config: &StoredEstConfig) -> anyhow::Result<()> {
        validate_optional_sealed_material(config.sealed_passphrase.as_ref())?;
        let (key_id, ciphertext, nonce, aad_digest) =
            sealed_parts(config.sealed_passphrase.as_ref());
        sqlx::query(
            "INSERT INTO est_configs (id, organization_id, profile_id, sealed_passphrase_key_id, sealed_passphrase_ciphertext, sealed_passphrase_nonce, sealed_passphrase_aad_digest, bootstrap_chain_pem, require_bootstrap, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&config.id)
        .bind(&config.organization_id)
        .bind(&config.profile_id)
        .bind(key_id)
        .bind(ciphertext)
        .bind(nonce)
        .bind(aad_digest)
        .bind(&config.bootstrap_chain_pem)
        .bind(i64::from(config.require_bootstrap))
        .bind(config.version)
        .bind(&config.created_at)
        .bind(&config.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_est_config(
        &self,
        organization_id: &str,
        profile_id: &str,
    ) -> anyhow::Result<Option<StoredEstConfig>> {
        let row =
            sqlx::query("SELECT * FROM est_configs WHERE organization_id = ? AND profile_id = ?")
                .bind(organization_id)
                .bind(profile_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.as_ref().map(stored_est_config))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_est_configs(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Vec<StoredEstConfig>> {
        let rows = sqlx::query(
            "SELECT * FROM est_configs WHERE organization_id = ? ORDER BY profile_id, id",
        )
        .bind(organization_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_est_config).collect())
    }

    /// # Errors
    ///
    /// Returns an error when validation or the update fails.
    pub async fn update_est_config(&self, config: &StoredEstConfig) -> anyhow::Result<bool> {
        validate_optional_sealed_material(config.sealed_passphrase.as_ref())?;
        let (key_id, ciphertext, nonce, aad_digest) =
            sealed_parts(config.sealed_passphrase.as_ref());
        let result = sqlx::query(
            "UPDATE est_configs SET sealed_passphrase_key_id = ?, sealed_passphrase_ciphertext = ?, sealed_passphrase_nonce = ?, sealed_passphrase_aad_digest = ?, bootstrap_chain_pem = ?, require_bootstrap = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ?",
        )
        .bind(key_id)
        .bind(ciphertext)
        .bind(nonce)
        .bind(aad_digest)
        .bind(&config.bootstrap_chain_pem)
        .bind(i64::from(config.require_bootstrap))
        .bind(now_rfc3339())
        .bind(&config.organization_id)
        .bind(&config.id)
        .bind(config.version)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the deletion fails.
    pub async fn delete_est_config(
        &self,
        organization_id: &str,
        config_id: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query("DELETE FROM est_configs WHERE organization_id = ? AND id = ?")
            .bind(organization_id)
            .bind(config_id)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the sealed challenge group is partially populated
    /// or the insert fails.
    pub async fn insert_scep_config(&self, config: &StoredScepConfig) -> anyhow::Result<()> {
        validate_optional_sealed_material(config.sealed_static_secret.as_ref())?;
        let (key_id, ciphertext, nonce, aad_digest) =
            sealed_parts(config.sealed_static_secret.as_ref());
        sqlx::query(
            "INSERT INTO scep_configs (id, organization_id, profile_id, challenge_mode, sealed_static_secret_key_id, sealed_static_secret_ciphertext, sealed_static_secret_nonce, sealed_static_secret_aad_digest, ra_signs_with_ca, include_ca_cert, allow_cert_renewal, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&config.id)
        .bind(&config.organization_id)
        .bind(&config.profile_id)
        .bind(&config.challenge_mode)
        .bind(key_id)
        .bind(ciphertext)
        .bind(nonce)
        .bind(aad_digest)
        .bind(i64::from(config.ra_signs_with_ca))
        .bind(i64::from(config.include_ca_cert))
        .bind(i64::from(config.allow_cert_renewal))
        .bind(config.version)
        .bind(&config.created_at)
        .bind(&config.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_scep_config(
        &self,
        organization_id: &str,
        profile_id: &str,
    ) -> anyhow::Result<Option<StoredScepConfig>> {
        let row =
            sqlx::query("SELECT * FROM scep_configs WHERE organization_id = ? AND profile_id = ?")
                .bind(organization_id)
                .bind(profile_id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.as_ref().map(stored_scep_config))
    }

    /// # Errors
    ///
    /// Returns an error when the query fails.
    pub async fn list_scep_configs(
        &self,
        organization_id: &str,
    ) -> anyhow::Result<Vec<StoredScepConfig>> {
        let rows = sqlx::query(
            "SELECT * FROM scep_configs WHERE organization_id = ? ORDER BY profile_id, id",
        )
        .bind(organization_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(stored_scep_config).collect())
    }

    /// # Errors
    ///
    /// Returns an error when validation or the update fails.
    pub async fn update_scep_config(&self, config: &StoredScepConfig) -> anyhow::Result<bool> {
        validate_optional_sealed_material(config.sealed_static_secret.as_ref())?;
        let (key_id, ciphertext, nonce, aad_digest) =
            sealed_parts(config.sealed_static_secret.as_ref());
        let result = sqlx::query(
            "UPDATE scep_configs SET challenge_mode = ?, sealed_static_secret_key_id = ?, sealed_static_secret_ciphertext = ?, sealed_static_secret_nonce = ?, sealed_static_secret_aad_digest = ?, ra_signs_with_ca = ?, include_ca_cert = ?, allow_cert_renewal = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND version = ?",
        )
        .bind(&config.challenge_mode)
        .bind(key_id)
        .bind(ciphertext)
        .bind(nonce)
        .bind(aad_digest)
        .bind(i64::from(config.ra_signs_with_ca))
        .bind(i64::from(config.include_ca_cert))
        .bind(i64::from(config.allow_cert_renewal))
        .bind(now_rfc3339())
        .bind(&config.organization_id)
        .bind(&config.id)
        .bind(config.version)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// # Errors
    ///
    /// Returns an error when the deletion fails.
    pub async fn delete_scep_config(
        &self,
        organization_id: &str,
        config_id: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query("DELETE FROM scep_configs WHERE organization_id = ? AND id = ?")
            .bind(organization_id)
            .bind(config_id)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Record a one-time SCEP challenge by hash and return its row id. The
    /// plaintext challenge is never persisted.
    ///
    /// # Errors
    ///
    /// Returns an error when the insert fails.
    pub async fn mint_scep_challenge(
        &self,
        organization_id: &str,
        config_id: &str,
        challenge_hash: &str,
        expires_at: &str,
    ) -> anyhow::Result<String> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_rfc3339();
        sqlx::query(
            "INSERT INTO scep_challenges (id, organization_id, config_id, challenge_hash, expires_at, consumed_at, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?)",
        )
        .bind(&id)
        .bind(organization_id)
        .bind(config_id)
        .bind(challenge_hash)
        .bind(expires_at)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        Ok(id)
    }

    /// Burn a SCEP challenge. The conditional update is the claim, so exactly
    /// one racing enrollment wins and a replay is rejected.
    ///
    /// # Errors
    ///
    /// Returns an error when the challenge is unknown, expired, or already
    /// consumed.
    pub async fn consume_scep_challenge(
        &self,
        organization_id: &str,
        config_id: &str,
        challenge_hash: &str,
    ) -> anyhow::Result<()> {
        let now = now_rfc3339();
        let result = sqlx::query(
            "UPDATE scep_challenges SET consumed_at = ?, version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND config_id = ? AND challenge_hash = ? \
               AND consumed_at IS NULL AND julianday(expires_at) > julianday(?)",
        )
        .bind(&now)
        .bind(&now)
        .bind(organization_id)
        .bind(config_id)
        .bind(challenge_hash)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() != 1 {
            anyhow::bail!("SCEP challenge is unknown, expired, or already consumed");
        }
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when the lookup fails.
    pub async fn get_scep_challenge(
        &self,
        organization_id: &str,
        challenge_id: &str,
    ) -> anyhow::Result<Option<StoredScepChallenge>> {
        let row = sqlx::query("SELECT * FROM scep_challenges WHERE organization_id = ? AND id = ?")
            .bind(organization_id)
            .bind(challenge_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.as_ref().map(stored_scep_challenge))
    }
}

fn validate_sealed_material(material: &SealedCertificateMaterial) -> anyhow::Result<()> {
    if material.key_id.is_empty()
        || material.ciphertext.is_empty()
        || material.nonce.is_empty()
        || material.aad_digest.is_empty()
    {
        anyhow::bail!("sealed certificate material must be complete");
    }
    Ok(())
}

fn validate_san_json(san_json: &str) -> anyhow::Result<()> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Sans {
        dns_names: Vec<String>,
        ip_addrs: Vec<String>,
    }
    let sans: Sans = serde_json::from_str(san_json)
        .context("certificate SAN metadata must contain DNS names and IP addresses")?;
    if sans.dns_names.len() > 100
        || sans.ip_addrs.len() > 16
        || sans
            .dns_names
            .iter()
            .chain(&sans.ip_addrs)
            .any(|value| value.is_empty() || value.len() > 253)
    {
        anyhow::bail!("certificate SAN metadata exceeds bounds");
    }
    Ok(())
}

fn stored_certificate_authority(row: &SqliteRow) -> StoredCertificateAuthority {
    StoredCertificateAuthority {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        issuer_kind: row.get("issuer_kind"),
        issuer_connection_id: row.get("issuer_connection_id"),
        display_name: row.get("display_name"),
        public_metadata_json: row.get("public_metadata_json"),
        sealed_material: SealedCertificateMaterial {
            key_id: row.get("sealed_key_id"),
            ciphertext: row.get("sealed_ciphertext"),
            nonce: row.get("sealed_nonce"),
            aad_digest: row.get("sealed_aad_digest"),
        },
        is_default: row.get::<i64, _>("is_default") != 0,
        status: row.get("status"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn stored_certificate_issuance_request(
    row: &SqliteRow,
) -> anyhow::Result<StoredCertificateIssuanceRequest> {
    let delivery = match row.get::<Option<String>, _>("delivery_key_id") {
        Some(key_id) => Some(SealedCertificateDelivery {
            material: SealedCertificateMaterial {
                key_id,
                ciphertext: row
                    .get::<Option<Vec<u8>>, _>("delivery_ciphertext")
                    .context("certificate delivery ciphertext is missing")?,
                nonce: row
                    .get::<Option<Vec<u8>>, _>("delivery_nonce")
                    .context("certificate delivery nonce is missing")?,
                aad_digest: row
                    .get::<Option<String>, _>("delivery_aad_digest")
                    .context("certificate delivery AAD digest is missing")?,
            },
            expires_at: row
                .get::<Option<String>, _>("delivery_expires_at")
                .context("certificate delivery expiry is missing")?,
        }),
        None => None,
    };
    Ok(StoredCertificateIssuanceRequest {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        authority_id: row.get("authority_id"),
        request_digest: row.get("request_digest"),
        idempotency_key: row.get("idempotency_key"),
        created_by: row.get("created_by"),
        state: row.get("state"),
        common_name: row.get("common_name"),
        san_json: row.get("san_json"),
        delivery,
        expires_at: row.get("expires_at"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
}

fn stored_issued_certificate(row: &SqliteRow) -> StoredIssuedCertificate {
    StoredIssuedCertificate {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        authority_id: row.get("authority_id"),
        request_id: row.get("request_id"),
        certificate_digest: row.get("certificate_digest"),
        serial_number: row.get("serial_number"),
        common_name: row.get("common_name"),
        san_json: row.get("san_json"),
        not_before: row.get("not_before"),
        expires_at: row.get("expires_at"),
        status: row.get("status"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn sealed_certificate_delivery(row: &SqliteRow) -> anyhow::Result<SealedCertificateDelivery> {
    Ok(SealedCertificateDelivery {
        material: SealedCertificateMaterial {
            key_id: row
                .get::<Option<String>, _>("delivery_key_id")
                .context("certificate delivery key ID is missing")?,
            ciphertext: row
                .get::<Option<Vec<u8>>, _>("delivery_ciphertext")
                .context("certificate delivery ciphertext is missing")?,
            nonce: row
                .get::<Option<Vec<u8>>, _>("delivery_nonce")
                .context("certificate delivery nonce is missing")?,
            aad_digest: row
                .get::<Option<String>, _>("delivery_aad_digest")
                .context("certificate delivery AAD digest is missing")?,
        },
        expires_at: row
            .get::<Option<String>, _>("delivery_expires_at")
            .context("certificate delivery expiry is missing")?,
    })
}

async fn clear_certificate_delivery(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    request_id: &str,
    expected_version: i64,
) -> anyhow::Result<bool> {
    let result = sqlx::query(
        "UPDATE certificate_issuance_requests SET delivery_key_id = NULL, delivery_ciphertext = NULL, delivery_nonce = NULL, delivery_aad_digest = NULL, delivery_expires_at = NULL, version = version + 1, updated_at = ? \
         WHERE id = ? AND version = ? AND delivery_ciphertext IS NOT NULL",
    )
    .bind(Utc::now().to_rfc3339())
    .bind(request_id)
    .bind(expected_version)
    .execute(&mut **transaction)
    .await?;
    Ok(result.rows_affected() == 1)
}

fn certificate_issuance_state_is_terminal(state: &str) -> bool {
    matches!(state, "completed" | "failed" | "expired" | "revoked")
}

fn certificate_time_is_expired(expires_at: &str, now: &str) -> anyhow::Result<bool> {
    let expires_at = chrono::DateTime::parse_from_rfc3339(expires_at)
        .context("certificate delivery expiry is not RFC 3339")?;
    let now = chrono::DateTime::parse_from_rfc3339(now)
        .context("certificate delivery comparison time is not RFC 3339")?;
    Ok(expires_at <= now)
}

#[derive(Clone, Debug)]
pub struct OutboxEvent {
    pub id: String,
    pub event_type: String,
    pub payload_json: String,
    pub created_at: String,
    pub attempts: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BackupTarget {
    pub organization_id: String,
    pub integration_id: String,
    pub installation_id: String,
    pub owner: String,
    pub repo: String,
    pub branch: String,
    pub enabled: bool,
    pub status: String,
    pub last_commit_sha: Option<String>,
    pub last_synced_at: Option<String>,
    pub last_error: Option<String>,
    /// `github_app` (historical default) or `connector` (ADR 0065 §6).
    pub kind: String,
    /// Connector-kind routing: the provider and Host connection that carry
    /// the ciphertext. Empty for `github_app` rows.
    pub provider_id: Option<String>,
    pub connection_id: Option<String>,
    /// Non-secret shape only (validated at the route); JSON text.
    pub config: Option<String>,
}

/// Where an organization's sealed attachment ciphertext is replicated
/// (ADR 0054). Configuration and status only: the gateway never holds chunks,
/// so there is nothing here to leak but a folder name.
#[derive(Clone, Debug)]
pub struct AttachmentTarget {
    pub organization_id: String,
    pub connection_id: String,
    pub provider_id: String,
    pub folder_path: String,
    pub enabled: bool,
    pub status: String,
    pub last_error: Option<String>,
    pub updated_at_unix_ms: i64,
}

#[derive(Clone, Debug)]
pub struct EncryptedItemRevision {
    pub vault_id: String,
    pub item_id: String,
    pub revision: i64,
    pub ciphertext: Vec<u8>,
    pub wrapping_json: String,
    pub ad_digest: String,
}

/// Append a change event inside an open transaction — the transactional-outbox
/// write that makes "every secret mutation broadcasts an event" crash-safe.
/// Shared with `connection-broker`, which writes the same pool.
///
/// # Errors
///
/// Returns an error when the outbox row cannot be inserted.
pub async fn append_outbox_tx(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    event_type: &str,
    payload_json: &str,
) -> anyhow::Result<String> {
    let id = uuid::Uuid::now_v7().to_string();
    sqlx::query(
        "INSERT INTO outbox_events (id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(event_type)
    .bind(payload_json)
    .bind(Utc::now().to_rfc3339())
    .execute(&mut **transaction)
    .await?;
    Ok(id)
}

async fn append_sync_blob_outbox(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    owner_id: &str,
    blob_id: &str,
    epoch: i64,
) -> anyhow::Result<()> {
    append_outbox_tx(
        transaction,
        "sync.blob.written",
        &serde_json::json!({"owner_id": owner_id, "blob_id": blob_id, "epoch": epoch}).to_string(),
    )
    .await?;
    Ok(())
}

#[async_trait]
pub trait Store: Send + Sync {
    async fn quorum_ok(&self) -> anyhow::Result<bool>;
}

#[async_trait]
impl Store for Db {
    async fn quorum_ok(&self) -> anyhow::Result<bool> {
        self.authority_quorum_ok().await
    }
}

#[must_use]
pub fn sqlite_file_url(path: &Path) -> String {
    format!("sqlite://{}?mode=rwc", path.display())
}

/// Embedded migrations are hand-written and contain no semicolon inside a string
/// literal. Trigger bodies are kept intact through their final `END;`.
/// The parameterized statement a [`CertificateFilter`] expands into.
///
/// The SQL text is assembled only from compile-time literals; every caller
/// value travels in `text_binds`/`limit` as a bound parameter. Nothing a caller
/// supplies can reach the statement text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CertificateQuery {
    pub sql: String,
    pub text_binds: Vec<String>,
    pub limit: Option<i64>,
}

/// Largest page [`CertificateFilter::to_query`] will ever ask the database for.
pub const CERTIFICATE_LIST_MAX_LIMIT: i64 = 1_000;

/// Maximum length of a substring filter. `SQLite` refuses `LIKE` patterns past
/// its complexity limit, and no legitimate CN, SAN or metadata field approaches
/// this, so a longer pattern is clamped rather than allowed to fail the query.
/// A filter is a convenience input: it must never turn a list request into an
/// error, and it must never let a cheap caller request a maximally expensive
/// pattern match.
pub const MAX_FILTER_PATTERN_LEN: usize = 256;

/// Clamp a caller-supplied pattern at a character boundary. Taking characters
/// rather than bytes means multi-byte input can never split a code point.
fn clamp_pattern(value: &str) -> String {
    value.chars().take(MAX_FILTER_PATTERN_LEN).collect()
}

/// Escape a caller substring for a `LIKE` pattern so `%` and `_` match
/// literally instead of turning the predicate into a full scan. Paired with an
/// explicit `ESCAPE '\'` clause in the statement.
fn like_pattern(value: &str) -> String {
    let value = clamp_pattern(value);
    let mut escaped = String::with_capacity(value.len() + 2);
    escaped.push('%');
    for character in value.chars() {
        if matches!(character, '\\' | '%' | '_') {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped.push('%');
    escaped
}

impl CertificateFilter {
    /// Expand the filter into a parameterized statement.
    ///
    /// The first bind is always the organization; `text_binds` follow in order,
    /// then `limit` when present.
    #[must_use]
    pub fn to_query(&self) -> CertificateQuery {
        let mut sql = String::from("SELECT * FROM issued_certificates WHERE organization_id = ?");
        let mut text_binds = Vec::new();
        if let Some(status) = &self.status {
            sql.push_str(" AND status = ?");
            text_binds.push(status.clone());
        }
        if let Some(common_name) = &self.common_name_contains {
            sql.push_str(" AND common_name LIKE ? ESCAPE '\\'");
            text_binds.push(like_pattern(common_name));
        }
        if let Some(san) = &self.san_contains {
            sql.push_str(" AND san_json LIKE ? ESCAPE '\\'");
            text_binds.push(like_pattern(san));
        }
        if let Some(profile_id) = &self.profile_id {
            sql.push_str(" AND profile_id = ?");
            text_binds.push(profile_id.clone());
        }
        if let Some(application_id) = &self.application_id {
            sql.push_str(" AND application_id = ?");
            text_binds.push(application_id.clone());
        }
        if let Some(expiring_before) = &self.expiring_before {
            sql.push_str(" AND julianday(expires_at) <= julianday(?)");
            text_binds.push(expiring_before.clone());
        }
        match (&self.metadata_key, &self.metadata_value) {
            (Some(key), Some(value)) => {
                sql.push_str(
                    " AND EXISTS (SELECT 1 FROM json_each(issued_certificates.metadata_json) WHERE json_each.key = ? AND json_each.value = ?)",
                );
                text_binds.push(clamp_pattern(key));
                text_binds.push(clamp_pattern(value));
            }
            (Some(key), None) => {
                sql.push_str(
                    " AND EXISTS (SELECT 1 FROM json_each(issued_certificates.metadata_json) WHERE json_each.key = ?)",
                );
                text_binds.push(clamp_pattern(key));
            }
            (None, Some(value)) => {
                sql.push_str(
                    " AND EXISTS (SELECT 1 FROM json_each(issued_certificates.metadata_json) WHERE json_each.value = ?)",
                );
                text_binds.push(clamp_pattern(value));
            }
            (None, None) => {}
        }
        sql.push_str(" ORDER BY expires_at, id");
        let limit = self
            .limit
            .map(|limit| limit.clamp(0, CERTIFICATE_LIST_MAX_LIMIT));
        if limit.is_some() {
            sql.push_str(" LIMIT ?");
        }
        CertificateQuery {
            sql,
            text_binds,
            limit,
        }
    }
}

fn now_rfc3339() -> String {
    Utc::now().to_rfc3339()
}

/// Reject a partially populated sealed column group before the database does,
/// so callers get a stable message instead of a constraint string.
fn validate_optional_sealed_material(
    material: Option<&SealedCertificateMaterial>,
) -> anyhow::Result<()> {
    match material {
        Some(material) => validate_sealed_material(material),
        None => Ok(()),
    }
}

/// The four bind values one sealed column group expands into: key id,
/// ciphertext, nonce, AAD digest — all `None` when the group is absent.
type SealedBinds<'a> = (
    Option<&'a str>,
    Option<&'a [u8]>,
    Option<&'a [u8]>,
    Option<&'a str>,
);

fn sealed_parts(material: Option<&SealedCertificateMaterial>) -> SealedBinds<'_> {
    match material {
        Some(material) => (
            Some(material.key_id.as_str()),
            Some(material.ciphertext.as_slice()),
            Some(material.nonce.as_slice()),
            Some(material.aad_digest.as_str()),
        ),
        None => (None, None, None, None),
    }
}

fn validate_json_document(document: &str, label: &str) -> anyhow::Result<()> {
    serde_json::from_str::<serde_json::Value>(document)
        .with_context(|| format!("{label} is not valid JSON"))?;
    Ok(())
}

/// Certificate metadata is a flat, bounded JSON object: the inventory filters
/// key/value pairs, and unbounded documents would make that scan unbounded too.
fn validate_metadata_document(document: &str) -> anyhow::Result<()> {
    if document.len() > CERTIFICATE_METADATA_MAX_BYTES {
        anyhow::bail!("certificate metadata exceeds the supported size");
    }
    let value: serde_json::Value =
        serde_json::from_str(document).context("certificate metadata is not valid JSON")?;
    let serde_json::Value::Object(fields) = value else {
        anyhow::bail!("certificate metadata must be a JSON object");
    };
    if fields.len() > CERTIFICATE_METADATA_MAX_KEYS {
        anyhow::bail!("certificate metadata exceeds the supported key count");
    }
    for (key, field) in &fields {
        if key.is_empty() || key.len() > CERTIFICATE_METADATA_MAX_FIELD_BYTES {
            anyhow::bail!("certificate metadata key exceeds bounds");
        }
        let too_long = match field {
            serde_json::Value::String(text) => text.len() > CERTIFICATE_METADATA_MAX_FIELD_BYTES,
            serde_json::Value::Null | serde_json::Value::Bool(_) | serde_json::Value::Number(_) => {
                false
            }
            serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
                anyhow::bail!("certificate metadata values must be scalars")
            }
        };
        if too_long {
            anyhow::bail!("certificate metadata value exceeds bounds");
        }
    }
    Ok(())
}

/// Largest metadata document the inventory accepts.
const CERTIFICATE_METADATA_MAX_BYTES: usize = 16 * 1024;
/// Largest number of metadata keys on one certificate.
const CERTIFICATE_METADATA_MAX_KEYS: usize = 64;
/// Largest metadata key or scalar value, in bytes. Held at the filter clamp so
/// a stored value can never be longer than the pattern that searches for it.
const CERTIFICATE_METADATA_MAX_FIELD_BYTES: usize = MAX_FILTER_PATTERN_LEN;

/// Statuses the Certificate Manager writes. The applied 0013 `CHECK` is never
/// rewritten, so the widened value set is enforced here instead.
pub const CERTIFICATE_STATUSES: &[&str] = &["active", "renewed", "revoked", "expired", "pending"];

fn validate_certificate_status(status: &str) -> anyhow::Result<()> {
    if CERTIFICATE_STATUSES.contains(&status) {
        return Ok(());
    }
    anyhow::bail!("unsupported certificate status");
}

macro_rules! optional_sealed_material {
    ($row:expr, $prefix:literal) => {{
        let key_id: Option<String> = $row.get(concat!($prefix, "_key_id"));
        key_id.map(|key_id| SealedCertificateMaterial {
            key_id,
            ciphertext: $row
                .get::<Option<Vec<u8>>, _>(concat!($prefix, "_ciphertext"))
                .unwrap_or_default(),
            nonce: $row
                .get::<Option<Vec<u8>>, _>(concat!($prefix, "_nonce"))
                .unwrap_or_default(),
            aad_digest: $row
                .get::<Option<String>, _>(concat!($prefix, "_aad_digest"))
                .unwrap_or_default(),
        })
    }};
}

// Declared here rather than at the top of the file because
// `optional_sealed_material!` is a textually scoped `macro_rules!` macro: a
// module declared above its definition cannot see it.
mod managed_certs;

mod lifecycle;
pub use lifecycle::{
    StoredLifecycleDelivery, StoredLifecycleHook, StoredLifecycleWatermark, DELIVERY_BATCH_LIMIT,
    LIFECYCLE_HOOK_SECRET_SCOPE,
};

fn stored_certificate_policy(row: &SqliteRow) -> StoredCertificatePolicy {
    StoredCertificatePolicy {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        name: row.get("name"),
        description: row.get("description"),
        preset: row.get("preset"),
        max_validity_seconds: row.get("max_validity_seconds"),
        rules_json: row.get("rules_json"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn stored_certificate_profile(row: &SqliteRow) -> StoredCertificateProfile {
    StoredCertificateProfile {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        name: row.get("name"),
        issuer_type: row.get("issuer_type"),
        certificate_authority_id: row.get("certificate_authority_id"),
        policy_id: row.get("policy_id"),
        defaults_json: row.get("defaults_json"),
        external_template: row.get("external_template"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn stored_ca_signing_config(row: &SqliteRow) -> StoredCaSigningConfig {
    StoredCaSigningConfig {
        certificate_authority_id: row.get("id"),
        organization_id: row.get("organization_id"),
        kind: row.get("kind"),
        key_algorithm: row.get("key_algorithm"),
        key_source: row.get("key_source"),
        hsm_connector_id: row.get("hsm_connector_id"),
        hsm_key_label: row.get("hsm_key_label"),
        path_len: row.get("path_len"),
        crl_enabled: row.get::<i64, _>("crl_enabled") != 0,
        crl_mirrors_json: row.get("crl_mirrors_json"),
        parent_id: row.get("parent_id"),
        pending_csr_pem: row.get("pending_csr_pem"),
        version: row.get("version"),
    }
}

fn stored_pki_application(row: &SqliteRow) -> StoredPkiApplication {
    StoredPkiApplication {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        slug: row.get("slug"),
        display_name: row.get("display_name"),
        description: row.get("description"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn stored_pki_application_member(row: &SqliteRow) -> StoredPkiApplicationMember {
    StoredPkiApplicationMember {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        application_id: row.get("application_id"),
        subject: row.get("subject"),
        role: row.get("role"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn stored_enrollment_config(row: &SqliteRow) -> StoredEnrollmentConfig {
    StoredEnrollmentConfig {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        application_id: row.get("application_id"),
        profile_id: row.get("profile_id"),
        method: row.get("method"),
        enabled: row.get::<i64, _>("enabled") != 0,
        config_json: row.get("config_json"),
        auto_renew_enabled: row.get::<i64, _>("auto_renew_enabled") != 0,
        renew_before_seconds: row.get("renew_before_seconds"),
        sealed_secret: optional_sealed_material!(row, "sealed_secret"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn stored_managed_certificate(row: &SqliteRow) -> StoredManagedCertificate {
    StoredManagedCertificate {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        authority_id: row.get("authority_id"),
        request_id: row.get("request_id"),
        certificate_digest: row.get("certificate_digest"),
        serial_number: row.get("serial_number"),
        common_name: row.get("common_name"),
        san_json: row.get("san_json"),
        not_before: row.get("not_before"),
        expires_at: row.get("expires_at"),
        status: row.get("status"),
        application_id: row.get("application_id"),
        profile_id: row.get("profile_id"),
        source: row.get("source"),
        enrollment_method: row.get("enrollment_method"),
        metadata_json: row.get("metadata_json"),
        key_algorithm: row.get("key_algorithm"),
        signature_algorithm: row.get("signature_algorithm"),
        fingerprint_sha256: row.get("fingerprint_sha256"),
        chain_pem: row.get("chain_pem"),
        renewed_from_id: row.get("renewed_from_id"),
        renewed_by_id: row.get("renewed_by_id"),
        auto_renew_enabled: row.get::<i64, _>("auto_renew_enabled") != 0,
        renew_before_seconds: row.get("renew_before_seconds"),
        revocation_reason: row.get("revocation_reason"),
        revoked_at: row.get("revoked_at"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn stored_managed_certificate_key(row: &SqliteRow) -> StoredManagedCertificateKey {
    StoredManagedCertificateKey {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        certificate_id: row.get("certificate_id"),
        sealed_key: SealedCertificateMaterial {
            key_id: row.get("sealed_key_key_id"),
            ciphertext: row.get("sealed_key_ciphertext"),
            nonce: row.get("sealed_key_nonce"),
            aad_digest: row.get("sealed_key_aad_digest"),
        },
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn stored_certificate_revocation(row: &SqliteRow) -> StoredCertificateRevocation {
    StoredCertificateRevocation {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        certificate_id: row.get("certificate_id"),
        ca_id: row.get("ca_id"),
        serial: row.get("serial"),
        reason_code: row.get("reason_code"),
        revoked_at: row.get("revoked_at"),
        crl_number: row.get("crl_number"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn stored_crl_state(row: &SqliteRow) -> StoredCrlState {
    StoredCrlState {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        ca_id: row.get("ca_id"),
        crl_number: row.get("crl_number"),
        this_update: row.get("this_update"),
        next_update: row.get("next_update"),
        sealed_der: optional_sealed_material!(row, "sealed_der"),
        mirror_urls_json: row.get("mirror_urls_json"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn stored_discovery_job(row: &SqliteRow) -> StoredDiscoveryJob {
    StoredDiscoveryJob {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        name: row.get("name"),
        description: row.get("description"),
        targets_json: row.get("targets_json"),
        ports_json: row.get("ports_json"),
        auto_scan: row.get::<i64, _>("auto_scan") != 0,
        scan_interval_days: row.get("scan_interval_days"),
        gateway_ref: row.get("gateway_ref"),
        allow_internal: row.get::<i64, _>("allow_internal") != 0,
        last_scan_at: row.get("last_scan_at"),
        status: row.get("status"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn stored_discovery_installation(row: &SqliteRow) -> StoredDiscoveryInstallation {
    StoredDiscoveryInstallation {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        job_id: row.get("job_id"),
        host: row.get("host"),
        port: row.get("port"),
        fingerprint_sha256: row.get("fingerprint_sha256"),
        cn: row.get("cn"),
        issuer: row.get("issuer"),
        not_after: row.get("not_after"),
        first_seen_at: row.get("first_seen_at"),
        last_seen_at: row.get("last_seen_at"),
        change_log_json: row.get("change_log_json"),
        matched_certificate_id: row.get("matched_certificate_id"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn stored_approval_policy(row: &SqliteRow) -> StoredApprovalPolicy {
    StoredApprovalPolicy {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        scope: row.get("scope"),
        application_id: row.get("application_id"),
        signer_id: row.get("signer_id"),
        name: row.get("name"),
        max_request_ttl_seconds: row.get("max_request_ttl_seconds"),
        machine_bypass: row.get::<i64, _>("machine_bypass") != 0,
        covers_json: row.get("covers_json"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn stored_approval_step(row: &SqliteRow) -> StoredApprovalStep {
    StoredApprovalStep {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        policy_id: row.get("policy_id"),
        seq: row.get("seq"),
        name: row.get("name"),
        approvers_json: row.get("approvers_json"),
        required_count: row.get("required_count"),
        notify: row.get::<i64, _>("notify") != 0,
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn stored_approval_request(row: &SqliteRow) -> StoredApprovalRequest {
    StoredApprovalRequest {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        policy_id: row.get("policy_id"),
        kind: row.get("kind"),
        requester: row.get("requester"),
        status: row.get("status"),
        current_step: row.get("current_step"),
        expires_at: row.get("expires_at"),
        payload_digest: row.get("payload_digest"),
        scope_json: row.get("scope_json"),
        result_id: row.get("result_id"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn stored_approval_decision(row: &SqliteRow) -> StoredApprovalDecision {
    StoredApprovalDecision {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        request_id: row.get("request_id"),
        step_seq: row.get("step_seq"),
        approver: row.get("approver"),
        decision: row.get("decision"),
        comment: row.get("comment"),
        decided_at: row.get("decided_at"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn stored_signer(row: &SqliteRow) -> StoredSigner {
    StoredSigner {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        name: row.get("name"),
        certificate_id: row.get("certificate_id"),
        key_source: row.get("key_source"),
        hsm_connector_id: row.get("hsm_connector_id"),
        hsm_key_label: row.get("hsm_key_label"),
        status: row.get("status"),
        auto_renew: row.get::<i64, _>("auto_renew") != 0,
        renew_before_seconds: row.get("renew_before_seconds"),
        sealed_key: optional_sealed_material!(row, "sealed_key"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn stored_signer_member(row: &SqliteRow) -> StoredSignerMember {
    StoredSignerMember {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        signer_id: row.get("signer_id"),
        subject: row.get("subject"),
        role: row.get("role"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn stored_signing_access_record(row: &SqliteRow) -> StoredSigningAccessRecord {
    StoredSigningAccessRecord {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        signer_id: row.get("signer_id"),
        approval_request_id: row.get("approval_request_id"),
        status: row.get("status"),
        signatures_allowed: row.get("signatures_allowed"),
        signatures_used: row.get("signatures_used"),
        window_expires_at: row.get("window_expires_at"),
        scope_json: row.get("scope_json"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn stored_signing_event(row: &SqliteRow) -> StoredSigningEvent {
    StoredSigningEvent {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        signer_id: row.get("signer_id"),
        access_record_id: row.get("access_record_id"),
        outcome: row.get("outcome"),
        command: row.get("command"),
        application_name: row.get("application_name"),
        application_sha256: row.get("application_sha256"),
        hostname: row.get("hostname"),
        os_username: row.get("os_username"),
        ip: row.get("ip"),
        data_hash: row.get("data_hash"),
        occurred_at: row.get("occurred_at"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn stored_cert_alert(row: &SqliteRow) -> StoredCertAlert {
    StoredCertAlert {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        application_id: row.get("application_id"),
        alert_type: row.get("type"),
        before_window_seconds: row.get("before_window_seconds"),
        daily_reminder: row.get::<i64, _>("daily_reminder") != 0,
        channels_json: row.get("channels_json"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn stored_alert_delivery(row: &SqliteRow) -> StoredAlertDelivery {
    StoredAlertDelivery {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        alert_id: row.get("alert_id"),
        channel: row.get("channel"),
        outcome: row.get("outcome"),
        attempts: row.get("attempts"),
        last_attempt_at: row.get("last_attempt_at"),
        payload_digest: row.get("payload_digest"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn stored_cert_sync(row: &SqliteRow) -> StoredCertSync {
    StoredCertSync {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        certificate_id: row.get("certificate_id"),
        destination_kind: row.get("destination_kind"),
        connection_id: row.get("connection_id"),
        name_schema: row.get("name_schema"),
        remove_on_expiry: row.get::<i64, _>("remove_on_expiry") != 0,
        include_root: row.get::<i64, _>("include_root") != 0,
        options_json: row.get("options_json"),
        enabled: row.get::<i64, _>("enabled") != 0,
        last_run_at: row.get("last_run_at"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn stored_sync_run(row: &SqliteRow) -> StoredSyncRun {
    StoredSyncRun {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        sync_id: row.get("sync_id"),
        outcome: row.get("outcome"),
        detail: row.get("detail"),
        ran_at: row.get("ran_at"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn stored_hsm_connector(row: &SqliteRow) -> StoredHsmConnector {
    StoredHsmConnector {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        label: row.get("label"),
        sealed_pin: optional_sealed_material!(row, "sealed_pin"),
        module_hint: row.get("module_hint"),
        key_label_prefix: row.get("key_label_prefix"),
        gateway_ref: row.get("gateway_ref"),
        status: row.get("status"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn stored_external_ca_config(row: &SqliteRow) -> StoredExternalCaConfig {
    StoredExternalCaConfig {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        kind: row.get("kind"),
        connection_id: row.get("connection_id"),
        config_json: row.get("config_json"),
        trust_class: row.get("trust_class"),
        auto_renew: row.get::<i64, _>("auto_renew") != 0,
        renew_before_seconds: row.get("renew_before_seconds"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn stored_acme_account(row: &SqliteRow) -> StoredAcmeAccount {
    StoredAcmeAccount {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        profile_id: row.get("profile_id"),
        jwk_thumbprint: row.get("jwk_thumbprint"),
        eab_kid: row.get("eab_kid"),
        status: row.get("status"),
        contacts_json: row.get("contacts_json"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn stored_acme_order(row: &SqliteRow) -> StoredAcmeOrder {
    StoredAcmeOrder {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        account_id: row.get("account_id"),
        status: row.get("status"),
        identifiers_json: row.get("identifiers_json"),
        expires_at: row.get("expires_at"),
        finalize_csr_pem: row.get("finalize_csr_pem"),
        certificate_id: row.get("certificate_id"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn stored_acme_challenge(row: &SqliteRow) -> StoredAcmeChallenge {
    StoredAcmeChallenge {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        order_id: row.get("order_id"),
        authz_id: row.get("authz_id"),
        challenge_type: row.get("type"),
        token: row.get("token"),
        status: row.get("status"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn stored_est_config(row: &SqliteRow) -> StoredEstConfig {
    StoredEstConfig {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        profile_id: row.get("profile_id"),
        sealed_passphrase: optional_sealed_material!(row, "sealed_passphrase"),
        bootstrap_chain_pem: row.get("bootstrap_chain_pem"),
        require_bootstrap: row.get::<i64, _>("require_bootstrap") != 0,
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn stored_scep_config(row: &SqliteRow) -> StoredScepConfig {
    StoredScepConfig {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        profile_id: row.get("profile_id"),
        challenge_mode: row.get("challenge_mode"),
        sealed_static_secret: optional_sealed_material!(row, "sealed_static_secret"),
        ra_signs_with_ca: row.get::<i64, _>("ra_signs_with_ca") != 0,
        include_ca_cert: row.get::<i64, _>("include_ca_cert") != 0,
        allow_cert_renewal: row.get::<i64, _>("allow_cert_renewal") != 0,
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn stored_scep_challenge(row: &SqliteRow) -> StoredScepChallenge {
    StoredScepChallenge {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        config_id: row.get("config_id"),
        challenge_hash: row.get("challenge_hash"),
        expires_at: row.get("expires_at"),
        consumed_at: row.get("consumed_at"),
        version: row.get("version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn split_statements(sql: &str) -> Vec<String> {
    let stripped: String = sql
        .lines()
        .map(|line| match line.find("--") {
            Some(i) => &line[..i],
            None => line,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mut statements = Vec::new();
    let mut current = String::new();
    for ch in stripped.chars() {
        if ch != ';' {
            current.push(ch);
            continue;
        }
        let trimmed = current.trim();
        let trigger_body = trimmed.starts_with("CREATE TRIGGER") && !trimmed.ends_with("END");
        if trigger_body {
            current.push(';');
            continue;
        }
        if !trimmed.is_empty() {
            statements.push(trimmed.to_string());
        }
        current.clear();
    }
    if !current.trim().is_empty() {
        statements.push(current.trim().to_string());
    }
    statements
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, Utc};
    use opensesame_domain::*;
    use serde_json::json;

    async fn apply_migration(pool: &SqlitePool, migration: &str) {
        for statement in split_statements(migration) {
            sqlx::query(&statement).execute(pool).await.unwrap();
        }
    }

    async fn apply_migrations(pool: &SqlitePool, migrations: &[(&str, &str)]) {
        for (_, migration) in migrations {
            apply_migration(pool, migration).await;
        }
    }

    async fn claim_host_kv(db: std::sync::Arc<Db>, worker: usize) -> bool {
        db.try_claim_host_kv("github.delivery.race", &format!("w{worker}"))
            .await
            .unwrap()
    }

    fn evidence(
        organization_id: OrganizationId,
        claimed_organization_id: Option<OrganizationId>,
        idempotency_key: &str,
    ) -> (Intent, Invocation, InvocationReceipt) {
        let now = Utc::now();
        let intent = Intent {
            id: IntentId::new(),
            organization_id,
            project_id: None,
            principal_id: PrincipalId::new(),
            actor_id: ActorId::new(),
            actor_instance_id: None,
            client_id: None,
            operator_id: None,
            connection_id: None,
            operation: "read".into(),
            resource: "doc:1".into(),
            audience: "https://resource.example".into(),
            normalized_parameters_hash: Intent::parameters_hash(&json!({})).unwrap(),
            body_hash: None,
            nonce: uuid::Uuid::new_v4().to_string(),
            idempotency_key: idempotency_key.into(),
            issued_at: now,
            expires_at: now + Duration::minutes(5),
            parent_invocation_id: None,
            delegation_chain: vec![],
            proof: DetachedProof {
                algorithm: "test".into(),
                key_thumbprint: "test".into(),
                signature: "test".into(),
            },
        };
        let invocation = Invocation {
            id: InvocationId::new(),
            intent_id: intent.id,
            state: InvocationState::Succeeded,
            attempt: 1,
            lease_owner: None,
            lease_expires_at: None,
            created_at: now,
            updated_at: now,
        };
        let receipt = InvocationReceipt {
            id: ReceiptId::new(),
            invocation_id: invocation.id,
            intent_digest: "sha256:intent".into(),
            principal_id: intent.principal_id,
            organization_id: claimed_organization_id,
            actor_id: intent.actor_id,
            actor_instance_id: None,
            client_id: None,
            operator_id: None,
            delegation_chain: vec![],
            connection_id: None,
            operation: intent.operation.clone(),
            resource: intent.resource.clone(),
            policy_decision_id: "decision".into(),
            policy_version_digest: "sha256:policy".into(),
            approval_id: None,
            credential_handle_id: None,
            connector_component_digest: None,
            external_request_digest: None,
            external_response_digest: None,
            started_at: now,
            completed_at: now,
            outcome: ReceiptOutcome::Succeeded,
            safe_result_summary: Some(json!({"ok": true})),
            authority_key_id: "test".into(),
            signature: "test".into(),
            receipt_schema_version: if claimed_organization_id.is_some() {
                3
            } else {
                1
            },
            task_run_id: None,
            task_state_version: None,
            task_state_digest: None,
        };
        (intent, invocation, receipt)
    }

    fn certificate_authority(
        organization_id: &str,
        id: &str,
        is_default: bool,
    ) -> StoredCertificateAuthority {
        StoredCertificateAuthority {
            id: id.into(),
            organization_id: organization_id.into(),
            issuer_kind: "opensesame_private_ca".into(),
            issuer_connection_id: None,
            display_name: "OpenSesame Private CA".into(),
            public_metadata_json: r#"{"algorithm":"ES256"}"#.into(),
            sealed_material: SealedCertificateMaterial {
                key_id: "seal:v1".into(),
                ciphertext: vec![1, 2, 3],
                nonce: vec![4, 5, 6],
                aad_digest: "sha256:authority".into(),
            },
            is_default,
            status: "active".into(),
            version: 1,
            created_at: "2026-08-21T00:00:00+00:00".into(),
            updated_at: "2026-08-21T00:00:00+00:00".into(),
        }
    }

    fn certificate_request(
        organization_id: &str,
        authority_id: &str,
        id: &str,
        idempotency_key: &str,
    ) -> StoredCertificateIssuanceRequest {
        StoredCertificateIssuanceRequest {
            id: id.into(),
            organization_id: organization_id.into(),
            authority_id: authority_id.into(),
            request_digest: format!("sha256:{id}"),
            idempotency_key: idempotency_key.into(),
            created_by: "principal:owner".into(),
            state: "created".into(),
            common_name: "localhost".into(),
            san_json: r#"{"dns_names":["localhost"],"ip_addrs":["127.0.0.1"]}"#.into(),
            delivery: None,
            expires_at: "2099-01-01T00:00:00+00:00".into(),
            version: 1,
            created_at: "2026-08-21T00:00:00+00:00".into(),
            updated_at: "2026-08-21T00:00:00+00:00".into(),
        }
    }

    fn issued_certificate(
        organization_id: &str,
        authority_id: &str,
        request_id: &str,
        id: &str,
    ) -> StoredIssuedCertificate {
        StoredIssuedCertificate {
            id: id.into(),
            organization_id: organization_id.into(),
            authority_id: authority_id.into(),
            request_id: request_id.into(),
            certificate_digest: format!("sha256:{id}"),
            serial_number: id.into(),
            common_name: "localhost".into(),
            san_json: r#"{"dns_names":["localhost"],"ip_addrs":["127.0.0.1"]}"#.into(),
            not_before: "2026-08-21T00:00:00+00:00".into(),
            expires_at: "2026-08-22T00:00:00+00:00".into(),
            status: "active".into(),
            version: 1,
            created_at: "2026-08-21T00:00:00+00:00".into(),
            updated_at: "2026-08-21T00:00:00+00:00".into(),
        }
    }

    fn certificate_delivery(expires_at: &str) -> SealedCertificateDelivery {
        SealedCertificateDelivery {
            material: SealedCertificateMaterial {
                key_id: "seal:v1".into(),
                ciphertext: vec![9, 8, 7],
                nonce: vec![6, 5, 4],
                aad_digest: "sha256:delivery".into(),
            },
            expires_at: expires_at.into(),
        }
    }

    #[tokio::test]
    async fn migrate_and_org_boundary() {
        let db = Db::connect_memory().await.unwrap();
        let org = OrganizationId::new();
        db.create_organization(&org, "acme").await.unwrap();
        assert!(db.authority_quorum_ok().await.unwrap());
        db.set_authority_quorum(false).await.unwrap();
        assert!(!db.authority_quorum_ok().await.unwrap());
    }

    #[tokio::test]
    async fn connection_crud_is_org_scoped_and_rejects_inline_secrets() {
        let db = Db::connect_memory().await.unwrap();
        let org = OrganizationId::new();
        let now = Utc::now();
        let mut connection = ConnectionRecord {
            id: ConnectionId::new(),
            organization_id: org,
            project_id: None,
            provider_id: "aws-secrets-manager".into(),
            display_name: "production".into(),
            public_config: serde_json::json!({"region": "us-east-1"}),
            credential_ref: None,
            created_at: now,
            updated_at: now,
        };
        db.insert_connection(&connection).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM organizations WHERE id = ?")
                .bind(org.to_string())
                .fetch_one(db.pool())
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            db.list_connections(&org).await.unwrap(),
            vec![connection.clone()]
        );
        connection.public_config = serde_json::json!({"api_token": "plaintext"});
        assert!(db.update_connection(&connection).await.is_err());
        assert!(db.delete_connection(&org, &connection.id).await.unwrap());
    }

    #[tokio::test]
    async fn encrypted_sync_survives_new_db_handles_and_is_owner_scoped() {
        let db = Db::connect_memory().await.unwrap();
        let blob = StoredSyncBlob {
            id: "vault-1".into(),
            epoch: 7,
            ciphertext: vec![1, 2, 3],
        };
        assert_eq!(
            db.write_sync_blob("principal:alice", &blob, 10, 5)
                .await
                .unwrap(),
            SyncWriteOutcome::Accepted
        );
        assert_eq!(
            db.write_sync_blob("principal:bob", &blob, 10, 5)
                .await
                .unwrap(),
            SyncWriteOutcome::ForeignOwner
        );
        assert_eq!(
            db.write_sync_blob("principal:alice", &blob, 10, 5)
                .await
                .unwrap(),
            SyncWriteOutcome::StaleEpoch
        );
        assert_eq!(
            db.list_sync_blobs("principal:alice", 0).await.unwrap(),
            vec![blob]
        );
        assert!(db
            .list_sync_blobs("principal:bob", 0)
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            db.advance_sync_cursor("principal:alice", "device", 7, 1)
                .await
                .unwrap(),
            Some(7)
        );
        assert_eq!(
            db.advance_sync_cursor("principal:alice", "another-device", 7, 1)
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            db.advance_sync_cursor("principal:alice", "device", 9, 1)
                .await
                .unwrap(),
            Some(9)
        );
    }

    #[tokio::test]
    async fn encrypted_sync_batch_is_atomic_on_equal_epoch_conflict() {
        let db = Db::connect_memory().await.unwrap();
        let header = StoredSyncBlob {
            id: "vault:header".into(),
            epoch: 1,
            ciphertext: vec![1],
        };
        let body = StoredSyncBlob {
            id: "vault:body".into(),
            epoch: 1,
            ciphertext: vec![2],
        };
        assert_eq!(
            db.write_sync_blobs("owner", &[header.clone(), body.clone()], 10, 10)
                .await
                .unwrap(),
            vec![SyncWriteOutcome::Accepted, SyncWriteOutcome::Accepted]
        );

        let conflicting_header = StoredSyncBlob {
            ciphertext: vec![9],
            ..header
        };
        let newer_body = StoredSyncBlob {
            epoch: 2,
            ciphertext: vec![8],
            ..body
        };
        assert_eq!(
            db.write_sync_blobs("owner", &[conflicting_header, newer_body], 10, 10)
                .await
                .unwrap(),
            vec![SyncWriteOutcome::StaleEpoch, SyncWriteOutcome::BatchAborted]
        );
        let stored = db.list_sync_blobs("owner", 0).await.unwrap();
        assert_eq!(stored.len(), 2);
        assert!(stored.iter().all(|blob| blob.epoch == 1));
        assert!(stored
            .iter()
            .any(|blob| blob.id == "vault:body" && blob.ciphertext == vec![2]));
    }

    #[test]
    fn database_unsigned_values_reject_negative_storage() {
        assert_eq!(db_u64(0, "epoch").unwrap(), 0);
        assert_eq!(
            db_u64(i64::MAX, "epoch").unwrap(),
            u64::try_from(i64::MAX).unwrap()
        );
        assert!(db_u64(-1, "epoch").is_err());
    }

    #[tokio::test]
    async fn sync_epoch_boundaries_fail_closed() {
        let db = Db::connect_memory().await.unwrap();
        let too_large = StoredSyncBlob {
            id: "too-large".into(),
            epoch: u64::try_from(i64::MAX).unwrap() + 1,
            ciphertext: vec![1],
        };
        assert!(db
            .write_sync_blob("owner", &too_large, 10, 10)
            .await
            .is_err());

        sqlx::query(
            "INSERT INTO encrypted_sync_blobs (id, owner_id, epoch, ciphertext, updated_at) \
             VALUES ('corrupt', 'owner', -1, X'01', 't')",
        )
        .execute(db.pool())
        .await
        .unwrap();
        assert!(db.list_all_sync_blobs().await.is_err());
    }

    #[tokio::test]
    async fn receipt_reads_resolve_legacy_org_and_reject_claim_mismatch() {
        let db = Db::connect_memory().await.unwrap();
        let organization_id = OrganizationId::new();
        db.create_organization(&organization_id, "acme")
            .await
            .unwrap();

        let (intent, invocation, legacy) = evidence(organization_id, None, "legacy");
        db.insert_intent(&intent).await.unwrap();
        db.insert_invocation(&invocation).await.unwrap();
        db.insert_receipt(&legacy).await.unwrap();
        let stored = db.get_receipt(&legacy.id).await.unwrap().unwrap();
        assert_eq!(stored.organization_id, organization_id);
        assert_eq!(stored.receipt.organization_id, None);
        assert_eq!(
            db.find_receipt_by_idempotency(&organization_id, "legacy")
                .await
                .unwrap()
                .unwrap()
                .organization_id,
            None
        );

        let (intent, invocation, mismatched) =
            evidence(organization_id, Some(OrganizationId::new()), "mismatch");
        db.insert_intent(&intent).await.unwrap();
        db.insert_invocation(&invocation).await.unwrap();
        db.insert_receipt(&mismatched).await.unwrap();
        assert!(db.get_receipt(&mismatched.id).await.is_err());
        assert!(db
            .find_receipt_by_idempotency(&organization_id, "mismatch")
            .await
            .is_err());
    }

    #[tokio::test]
    async fn in_memory_database_keeps_one_migrated_schema() {
        let db = Db::connect_memory().await.unwrap();
        assert_eq!(db.pool().options().get_max_connections(), 1);
        sqlx::query("SELECT 1 FROM provider_connections LIMIT 0")
            .execute(db.pool())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn every_migration_is_recorded_once() {
        let db = Db::connect_memory().await.unwrap();
        let applied = db.applied_migrations().await.unwrap();
        assert_eq!(
            applied,
            MIGRATIONS
                .iter()
                .map(|(v, _)| (*v).to_string())
                .collect::<Vec<_>>()
        );

        // A second boot must be a no-op rather than replaying schema changes.
        db.migrate().await.unwrap();
        assert_eq!(db.applied_migrations().await.unwrap(), applied);
    }

    #[tokio::test]
    async fn migration_preserves_legacy_certificate_host_kv() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        apply_migrations(&pool, &MIGRATIONS[..10]).await;
        sqlx::query(
            "INSERT INTO host_kv (key, value, updated_at) VALUES ('certs.dev_ca', 'legacy-unsealed-value', 't')",
        )
        .execute(&pool)
        .await
        .unwrap();
        apply_migration(
            &pool,
            include_str!("../../../migrations/0013_certificate_issuance.sql"),
        )
        .await;
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT value FROM host_kv WHERE key = 'certs.dev_ca'")
                .fetch_one(&pool)
                .await
                .unwrap(),
            "legacy-unsealed-value"
        );
    }

    #[tokio::test]
    async fn atomic_certificate_authority_default_is_org_scoped_and_cas_guarded() {
        let db = Db::connect_memory().await.unwrap();
        let internal = certificate_authority("org:one", "ca:internal", true);
        let external = certificate_authority("org:one", "ca:external", false);
        db.insert_certificate_authority(&internal).await.unwrap();
        db.insert_certificate_authority(&external).await.unwrap();

        assert!(!db
            .set_default_certificate_authority("org:two", "ca:external", 1)
            .await
            .unwrap());
        assert!(db
            .set_default_certificate_authority("org:one", "ca:external", 1)
            .await
            .unwrap());
        assert_eq!(
            db.get_default_certificate_authority("org:one")
                .await
                .unwrap()
                .unwrap()
                .id,
            "ca:external"
        );
        assert!(!db
            .set_default_certificate_authority("org:one", "ca:internal", 1)
            .await
            .unwrap());

        let duplicate_default = certificate_authority("org:one", "ca:duplicate", true);
        assert!(db
            .insert_certificate_authority(&duplicate_default)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn adversarial_certificate_completion_rejects_substitution_and_replay() {
        let db = Db::connect_memory().await.unwrap();
        let authority = certificate_authority("org:one", "ca:one", true);
        db.insert_certificate_authority(&authority).await.unwrap();
        let request = certificate_request("org:one", "ca:one", "request:one", "idem:one");
        assert!(db
            .insert_certificate_issuance_request(&request)
            .await
            .unwrap());

        let mut duplicate = certificate_request("org:one", "ca:one", "request:two", "idem:one");
        duplicate.request_digest = "sha256:other".into();
        assert!(db
            .insert_certificate_issuance_request(&duplicate)
            .await
            .is_err());

        let delivery = certificate_delivery("2099-01-01T00:00:00+00:00");
        let mut substituted =
            issued_certificate("org:one", "ca:one", "request:one", "certificate:one");
        substituted.common_name = "attacker.example".into();
        assert!(!db
            .complete_certificate_issuance(
                "org:one",
                "request:one",
                1,
                "created",
                &delivery,
                &substituted,
            )
            .await
            .unwrap());

        let issued = issued_certificate("org:one", "ca:one", "request:one", "certificate:one");
        assert!(db
            .complete_certificate_issuance(
                "org:one",
                "request:one",
                1,
                "created",
                &delivery,
                &issued,
            )
            .await
            .unwrap());
        assert!(!db
            .complete_certificate_issuance(
                "org:one",
                "request:one",
                1,
                "created",
                &delivery,
                &issued,
            )
            .await
            .unwrap());
        assert_eq!(
            db.get_issued_certificate("org:one", "certificate:one")
                .await
                .unwrap(),
            Some(issued)
        );
        assert!(db
            .get_issued_certificate("org:two", "certificate:one")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn atomic_certificate_delivery_is_encrypted_expiring_and_single_use() {
        let db = Db::connect_memory().await.unwrap();
        let authority = certificate_authority("org:one", "ca:one", true);
        db.insert_certificate_authority(&authority).await.unwrap();
        let request = certificate_request("org:one", "ca:one", "request:one", "idem:one");
        db.insert_certificate_issuance_request(&request)
            .await
            .unwrap();
        let delivery = certificate_delivery("2099-01-01T00:00:00+00:00");
        let debug = format!("{delivery:?}");
        assert!(!debug.contains("[9, 8, 7]"));
        assert!(!debug.contains("[6, 5, 4]"));
        let issued = issued_certificate("org:one", "ca:one", "request:one", "certificate:one");
        db.complete_certificate_issuance(
            "org:one",
            "request:one",
            1,
            "created",
            &delivery,
            &issued,
        )
        .await
        .unwrap();

        assert!(db
            .take_certificate_delivery("org:two", "request:one", "2026-08-21T00:00:00+00:00")
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            db.take_certificate_delivery("org:one", "request:one", "2026-08-21T00:00:00+00:00")
                .await
                .unwrap(),
            Some(delivery)
        );
        assert!(db
            .take_certificate_delivery("org:one", "request:one", "2026-08-21T00:00:00+00:00")
            .await
            .unwrap()
            .is_none());

        let expired_request =
            certificate_request("org:one", "ca:one", "request:expired", "idem:expired");
        db.insert_certificate_issuance_request(&expired_request)
            .await
            .unwrap();
        let expired_issued = issued_certificate(
            "org:one",
            "ca:one",
            "request:expired",
            "certificate:expired",
        );
        db.complete_certificate_issuance(
            "org:one",
            "request:expired",
            1,
            "created",
            &certificate_delivery("2026-08-20T00:00:00+00:00"),
            &expired_issued,
        )
        .await
        .unwrap();
        assert!(db
            .take_certificate_delivery("org:one", "request:expired", "2026-08-21T00:00:00+00:00")
            .await
            .unwrap()
            .is_none());
        assert!(sqlx::query_scalar::<_, Option<Vec<u8>>>(
            "SELECT delivery_ciphertext FROM certificate_issuance_requests WHERE id = 'request:expired'",
        )
        .fetch_one(db.pool())
        .await
        .unwrap()
        .is_none());

        let columns = sqlx::query("PRAGMA table_info(issued_certificates)")
            .fetch_all(db.pool())
            .await
            .unwrap()
            .into_iter()
            .map(|row| row.get::<String, _>("name"))
            .collect::<Vec<_>>();
        assert!(columns.iter().all(|column| {
            !column.contains("private")
                && !column.contains("ciphertext")
                && !column.contains("nonce")
        }));
    }

    #[tokio::test]
    async fn contract_certificate_delivery_retries_until_holder_acknowledges() {
        let db = Db::connect_memory().await.unwrap();
        db.insert_certificate_authority(&certificate_authority("org:one", "ca:one", true))
            .await
            .unwrap();
        let request = certificate_request("org:one", "ca:one", "request:one", "idem:one");
        db.insert_certificate_issuance_request(&request)
            .await
            .unwrap();
        let delivery = certificate_delivery("2099-01-01T00:00:00+00:00");
        db.complete_certificate_issuance(
            "org:one",
            "request:one",
            1,
            "created",
            &delivery,
            &issued_certificate("org:one", "ca:one", "request:one", "certificate:one"),
        )
        .await
        .unwrap();

        assert!(db
            .get_certificate_delivery(
                "org:one",
                "request:one",
                "principal:attacker",
                "2026-08-21T00:00:00+00:00",
            )
            .await
            .unwrap()
            .is_none());
        for _ in 0..2 {
            assert_eq!(
                db.get_certificate_delivery(
                    "org:one",
                    "request:one",
                    "principal:owner",
                    "2026-08-21T00:00:00+00:00",
                )
                .await
                .unwrap(),
                Some(delivery.clone())
            );
        }
        assert!(db
            .acknowledge_certificate_delivery("org:one", "request:one", "principal:owner")
            .await
            .unwrap());
        assert!(db
            .get_certificate_delivery(
                "org:one",
                "request:one",
                "principal:owner",
                "2026-08-21T00:00:00+00:00",
            )
            .await
            .unwrap()
            .is_none());
        assert!(!db
            .acknowledge_certificate_delivery("org:one", "request:one", "principal:owner")
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn migrating_an_existing_database_records_without_destroying() {
        let db = Db::connect_memory().await.unwrap();
        sqlx::query(
            "INSERT INTO connections (id, organization_id, project_id, provider_id, logical_name, display_name, status, status_detail, requested_scopes, granted_scopes, account_label, owner_kind, shareability, max_invoke_level, egress_json, created_at, updated_at) \
             VALUES ('c1','org:1',NULL,'github','github/main','GitHub','pending',NULL,'[]','[]',NULL,'organization','private',2,'{}','t','t')",
        )
        .execute(db.pool())
        .await
        .unwrap();

        db.migrate().await.unwrap();

        let row = sqlx::query("SELECT COUNT(*) AS c FROM connections")
            .fetch_one(db.pool())
            .await
            .unwrap();
        assert_eq!(row.get::<i64, _>("c"), 1);
    }

    #[tokio::test]
    async fn legacy_connection_rows_survive_the_broker_migration() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        for statement in split_statements(include_str!("../../../migrations/0001_init.sql")) {
            sqlx::query(&statement).execute(&pool).await.unwrap();
        }
        sqlx::query(
            "INSERT INTO organizations (id, name, created_at) VALUES ('org:1', 'Legacy', 't')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO connections (id, organization_id, project_id, connector_id, connector_version, component_digest, display_name, policy_json, created_at) VALUES ('legacy-1', 'org:1', NULL, 'github', '1', 'sha256:x', 'Legacy', '{}', 't')")
            .execute(&pool)
            .await
            .unwrap();

        let db = Db { pool };
        db.migrate().await.unwrap();
        let legacy = sqlx::query("SELECT id FROM legacy_connections WHERE id = 'legacy-1'")
            .fetch_one(db.pool())
            .await
            .unwrap();
        assert_eq!(legacy.get::<String, _>("id"), "legacy-1");
        let broker_rows = sqlx::query("SELECT COUNT(*) AS n FROM connections")
            .fetch_one(db.pool())
            .await
            .unwrap();
        assert_eq!(broker_rows.get::<i64, _>("n"), 0);
    }

    #[tokio::test]
    async fn credential_generation_migration_backfills_baseline_rows() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        apply_migrations(&pool, &MIGRATIONS[..4]).await;
        sqlx::query("INSERT INTO connections (id, organization_id, project_id, provider_id, logical_name, display_name, status, status_detail, requested_scopes, granted_scopes, account_label, owner_kind, owner_subject, shareability, max_invoke_level, egress_json, created_at, updated_at, integration_id) VALUES ('connection:legacy', 'org:legacy', NULL, 'stripe', 'stripe/main', 'Stripe', 'active', NULL, '[]', '[]', NULL, 'organization', NULL, 'private', 2, '{}', 't', 't', 'deployment:stripe')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO connection_credentials (connection_id, ciphertext, nonce, aad_digest, token_type, expires_at, refreshable, last_refreshed_at, created_at, updated_at) VALUES ('connection:legacy', X'01', X'02', 'aad', 'api_key', NULL, 0, NULL, 't', 't')")
            .execute(&pool)
            .await
            .unwrap();
        for statement in split_statements(include_str!(
            "../../../migrations/0005_credential_generation.sql"
        )) {
            sqlx::query(&statement).execute(&pool).await.unwrap();
        }
        let version = sqlx::query("SELECT version FROM connection_credentials")
            .fetch_one(&pool)
            .await
            .unwrap()
            .get::<String, _>("version");
        assert!(!version.is_empty());
    }

    #[tokio::test]
    async fn provider_configuration_migration_indexes_legacy_fields_without_rewriting_secrets() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        apply_migrations(&pool, &MIGRATIONS[..5]).await;
        sqlx::query("INSERT INTO integrations (id, organization_id, key, provider_id, display_name, enabled, scopes, client_id, client_secret_ciphertext, client_secret_nonce, client_secret_aad_digest, created_by, created_at, updated_at) VALUES ('integration:legacy', 'org:legacy', 'legacy', 'github', 'Legacy', 1, '[]', 'client', X'01', X'02', 'aad', 'principal:admin', 't', 't')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO connections (id, organization_id, project_id, provider_id, logical_name, display_name, status, status_detail, requested_scopes, granted_scopes, account_label, owner_kind, owner_subject, shareability, max_invoke_level, egress_json, created_at, updated_at, integration_id) VALUES ('connection:legacy', 'org:legacy', NULL, 'stripe', 'stripe/main', 'Stripe', 'active', NULL, '[]', '[]', NULL, 'organization', NULL, 'private', 2, '{}', 't', 't', 'integration:legacy')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO connection_credentials (connection_id, version, ciphertext, nonce, aad_digest, token_type, expires_at, refreshable, last_refreshed_at, created_at, updated_at) VALUES ('connection:legacy', 'v1', X'03', X'04', 'aad', 'api_key', NULL, 0, NULL, 't', 't')")
            .execute(&pool)
            .await
            .unwrap();

        for statement in split_statements(include_str!(
            "../../../migrations/0006_provider_configuration.sql"
        )) {
            sqlx::query(&statement).execute(&pool).await.unwrap();
        }

        let integration_fields = sqlx::query(
            "SELECT configured_fields FROM integrations WHERE id = 'integration:legacy'",
        )
        .fetch_one(&pool)
        .await
        .unwrap()
        .get::<String, _>("configured_fields");
        let connection_fields = sqlx::query(
            "SELECT configured_fields FROM connection_credentials WHERE connection_id = 'connection:legacy'",
        )
        .fetch_one(&pool)
        .await
        .unwrap()
        .get::<String, _>("configured_fields");
        assert_eq!(integration_fields, r#"["client_id","client_secret"]"#);
        assert_eq!(connection_fields, r#"["api_key"]"#);
    }

    #[tokio::test]
    async fn provider_connections_are_added_to_an_already_migrated_database() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        apply_migrations(&pool, &MIGRATIONS[..6]).await;
        assert!(sqlx::query("SELECT 1 FROM provider_connections LIMIT 0")
            .execute(&pool)
            .await
            .is_err());
        for statement in split_statements(include_str!(
            "../../../migrations/0007_provider_connections.sql"
        )) {
            sqlx::query(&statement).execute(&pool).await.unwrap();
        }
        sqlx::query("SELECT 1 FROM provider_connections LIMIT 0")
            .execute(&pool)
            .await
            .unwrap();
    }

    #[test]
    fn statements_split_cleanly() {
        for (version, sql) in MIGRATIONS {
            let stmts = split_statements(sql);
            assert!(!stmts.is_empty(), "{version} produced no statements");
            assert!(
                stmts.iter().all(|s| !s.contains("--")),
                "{version} left a line comment inside a statement"
            );
        }
    }

    #[tokio::test]
    async fn outbox_claim_publish_park_dead_letter_lifecycle() {
        let db = Db::connect_memory().await.unwrap();
        let first = db
            .append_outbox("sync.blob.written", r#"{"blob_id":"b1"}"#)
            .await
            .unwrap();
        let second = db
            .append_outbox("connection.credential.stored", r#"{"connection_id":"c1"}"#)
            .await
            .unwrap();
        assert_eq!(db.count_unpublished_outbox().await.unwrap(), 2);

        // Claiming leases the rows: a second immediate claim sees nothing.
        let claimed = db.claim_outbox_batch(10, 60).await.unwrap();
        assert_eq!(claimed.len(), 2);
        assert_eq!(claimed[0].id, first);
        assert!(db.claim_outbox_batch(10, 60).await.unwrap().is_empty());

        // Success path.
        db.mark_outbox_published(&[first.clone()]).await.unwrap();
        assert_eq!(db.count_unpublished_outbox().await.unwrap(), 1);

        // Compensation path: park releases the claim after the backoff.
        db.park_outbox(&[second.clone()], "github 502", 0)
            .await
            .unwrap();
        let retried = db.claim_outbox_batch(10, 60).await.unwrap();
        assert_eq!(retried.len(), 1);
        assert_eq!(retried[0].id, second);
        assert_eq!(retried[0].attempts, 1);

        // Terminal compensation: dead-letter records the error and stops retries.
        db.dead_letter_outbox(&[second.clone()], "poison payload")
            .await
            .unwrap();
        assert_eq!(db.count_unpublished_outbox().await.unwrap(), 0);
    }

    #[tokio::test]
    async fn sync_blob_writes_broadcast_an_outbox_event_atomically() {
        let db = Db::connect_memory().await.unwrap();
        let blob = StoredSyncBlob {
            id: "blob-1".into(),
            epoch: 1,
            ciphertext: vec![1, 2, 3],
        };
        assert_eq!(
            db.write_sync_blob("owner-1", &blob, 10, 10).await.unwrap(),
            SyncWriteOutcome::Accepted
        );
        let events = db.claim_outbox_batch(10, 60).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "sync.blob.written");
        assert!(events[0].payload_json.contains("blob-1"));
    }

    #[tokio::test]
    async fn backup_target_round_trip_and_outcome_recording() {
        let db = Db::connect_memory().await.unwrap();
        let organization = OrganizationId::new();
        sqlx::query("INSERT INTO organizations (id, name, created_at) VALUES (?, 'Org', ?)")
            .bind(organization.to_string())
            .bind(Utc::now().to_rfc3339())
            .execute(db.pool())
            .await
            .unwrap();
        let target = BackupTarget {
            organization_id: organization.to_string(),
            integration_id: "github-app-1".into(),
            installation_id: "12345678".into(),
            owner: "acme".into(),
            repo: "opensesame-passwords".into(),
            branch: "main".into(),
            enabled: true,
            status: "pending".into(),
            last_commit_sha: None,
            last_synced_at: None,
            last_error: None,
            kind: "github_app".into(),
            provider_id: None,
            connection_id: None,
            config: None,
        };
        db.upsert_backup_target(&target).await.unwrap();
        let loaded = db
            .get_backup_target(&organization.to_string())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(loaded.repo, "opensesame-passwords");
        assert!(loaded.enabled);

        db.record_backup_outcome(&organization.to_string(), "ok", Some("abc123"), None)
            .await
            .unwrap();
        let synced = db
            .get_backup_target(&organization.to_string())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(synced.status, "ok");
        assert_eq!(synced.last_commit_sha.as_deref(), Some("abc123"));
        assert!(synced.last_synced_at.is_some());

        // A failed pass keeps the last good commit but records the error.
        db.record_backup_outcome(&organization.to_string(), "suspended", None, Some("401"))
            .await
            .unwrap();
        let suspended = db
            .get_backup_target(&organization.to_string())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(suspended.status, "suspended");
        assert_eq!(suspended.last_commit_sha.as_deref(), Some("abc123"));
        assert_eq!(suspended.last_error.as_deref(), Some("401"));
    }

    #[tokio::test]
    async fn host_kv_round_trip_and_overwrite() {
        let db = Db::connect_memory().await.unwrap();
        assert!(db.get_host_kv("taskbus.backend").await.unwrap().is_none());
        db.set_host_kv("taskbus.backend", "memory").await.unwrap();
        db.set_host_kv("taskbus.nats_url", "nats://127.0.0.1:4222")
            .await
            .unwrap();
        assert_eq!(
            db.get_host_kv("taskbus.backend").await.unwrap().as_deref(),
            Some("memory")
        );
        db.set_host_kv("taskbus.backend", "nats").await.unwrap();
        assert_eq!(
            db.get_host_kv("taskbus.backend").await.unwrap().as_deref(),
            Some("nats")
        );
        db.delete_host_kv("taskbus.nats_url").await.unwrap();
        assert!(db.get_host_kv("taskbus.nats_url").await.unwrap().is_none());
        db.set_host_kv("github.delivery.abc", "outbox-1")
            .await
            .unwrap();
        assert_eq!(
            db.get_host_kv("github.delivery.abc")
                .await
                .unwrap()
                .as_deref(),
            Some("outbox-1")
        );
        assert!(!db
            .try_claim_host_kv("github.delivery.abc", "outbox-2")
            .await
            .unwrap());
        assert!(db
            .try_claim_host_kv("github.delivery.new", "outbox-3")
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn try_claim_host_kv_is_exclusive_under_concurrency() {
        let db = Db::connect_memory().await.unwrap();
        let db = std::sync::Arc::new(db);
        let mut handles = Vec::new();
        for i in 0..32 {
            handles.push(tokio::spawn(claim_host_kv(db.clone(), i)));
        }
        let mut wins = 0usize;
        for handle in handles {
            wins += usize::from(handle.await.unwrap());
        }
        assert_eq!(wins, 1);
        assert!(db
            .get_host_kv("github.delivery.race")
            .await
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn backup_outbox_migration_applies_to_an_already_migrated_database() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        // 0015 alters backup_targets, so it must trail 0008 here just as it
        // does in the real ordered list.
        let except_backup: Vec<(&str, &str)> = MIGRATIONS
            .iter()
            .copied()
            .filter(|(version, _)| {
                *version != "0008_backup_outbox" && *version != "0015_backup_target_kinds"
            })
            .collect();
        apply_migrations(&pool, &except_backup).await;
        assert!(sqlx::query("SELECT 1 FROM backup_targets LIMIT 0")
            .execute(&pool)
            .await
            .is_err());
        for statement in
            split_statements(include_str!("../../../migrations/0008_backup_outbox.sql"))
        {
            sqlx::query(&statement).execute(&pool).await.unwrap();
        }
        for statement in split_statements(include_str!(
            "../../../migrations/0015_backup_target_kinds.sql"
        )) {
            sqlx::query(&statement).execute(&pool).await.unwrap();
        }
        sqlx::query("SELECT attempts FROM outbox_events LIMIT 0")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("SELECT 1 FROM backup_targets LIMIT 0")
            .execute(&pool)
            .await
            .unwrap();
    }

    // —— certificate manager fixtures ——————————————————————————————

    const CERTMGR_NOW: &str = "2026-08-30T00:00:00+00:00";

    fn certmgr_policy(organization_id: &str, id: &str, name: &str) -> StoredCertificatePolicy {
        StoredCertificatePolicy {
            id: id.into(),
            organization_id: organization_id.into(),
            name: name.into(),
            description: Some("TLS server issuance".into()),
            preset: "tls_server".into(),
            max_validity_seconds: Some(7_776_000),
            rules_json: r#"{"subject":{},"san":{}}"#.into(),
            version: 1,
            created_at: CERTMGR_NOW.into(),
            updated_at: CERTMGR_NOW.into(),
        }
    }

    fn certmgr_profile(
        organization_id: &str,
        id: &str,
        name: &str,
        authority_id: &str,
        policy_id: &str,
    ) -> StoredCertificateProfile {
        StoredCertificateProfile {
            id: id.into(),
            organization_id: organization_id.into(),
            name: name.into(),
            issuer_type: "ca".into(),
            certificate_authority_id: Some(authority_id.into()),
            policy_id: policy_id.into(),
            defaults_json: r#"{"ttl_seconds":86400}"#.into(),
            external_template: None,
            version: 1,
            created_at: CERTMGR_NOW.into(),
            updated_at: CERTMGR_NOW.into(),
        }
    }

    fn certmgr_application(organization_id: &str, id: &str, slug: &str) -> StoredPkiApplication {
        StoredPkiApplication {
            id: id.into(),
            organization_id: organization_id.into(),
            slug: slug.into(),
            display_name: "Edge fleet".into(),
            description: None,
            version: 1,
            created_at: CERTMGR_NOW.into(),
            updated_at: CERTMGR_NOW.into(),
        }
    }

    fn certmgr_sealed(tag: &str) -> SealedCertificateMaterial {
        SealedCertificateMaterial {
            key_id: format!("seal:{tag}"),
            ciphertext: vec![7, 7, 7],
            nonce: vec![3, 3, 3],
            aad_digest: format!("sha256:{tag}"),
        }
    }

    fn certmgr_managed_certificate(
        organization_id: &str,
        authority_id: &str,
        request_id: &str,
        id: &str,
    ) -> StoredManagedCertificate {
        StoredManagedCertificate {
            id: id.into(),
            organization_id: organization_id.into(),
            authority_id: authority_id.into(),
            request_id: request_id.into(),
            certificate_digest: format!("sha256:{id}"),
            serial_number: id.into(),
            common_name: "alpha.example".into(),
            san_json: r#"{"dns_names":["alpha.example"],"ip_addrs":[]}"#.into(),
            not_before: CERTMGR_NOW.into(),
            expires_at: "2026-12-01T00:00:00+00:00".into(),
            status: "active".into(),
            application_id: None,
            profile_id: None,
            source: "issued".into(),
            enrollment_method: Some("api".into()),
            metadata_json: "{}".into(),
            key_algorithm: Some("ecdsa-p256".into()),
            signature_algorithm: Some("ecdsa-with-sha256".into()),
            fingerprint_sha256: Some(format!("fp:{id}")),
            chain_pem: None,
            renewed_from_id: None,
            renewed_by_id: None,
            auto_renew_enabled: false,
            renew_before_seconds: None,
            revocation_reason: None,
            revoked_at: None,
            version: 1,
            created_at: CERTMGR_NOW.into(),
            updated_at: CERTMGR_NOW.into(),
        }
    }

    /// Seed one organization with a CA, a policy, a profile and an application.
    /// Returns `(authority_id, policy_id, profile_id, application_id)`.
    async fn seed_certmgr_org(
        db: &Db,
        organization_id: &str,
        suffix: &str,
    ) -> (String, String, String, String) {
        let authority_id = format!("ca:{suffix}");
        let policy_id = format!("policy:{suffix}");
        let profile_id = format!("profile:{suffix}");
        let application_id = format!("app:{suffix}");
        db.insert_certificate_authority(&certificate_authority(
            organization_id,
            &authority_id,
            true,
        ))
        .await
        .unwrap();
        db.insert_certificate_policy(&certmgr_policy(organization_id, &policy_id, "tls"))
            .await
            .unwrap();
        db.insert_certificate_profile(&certmgr_profile(
            organization_id,
            &profile_id,
            "edge",
            &authority_id,
            &policy_id,
        ))
        .await
        .unwrap();
        db.insert_pki_application(&certmgr_application(
            organization_id,
            &application_id,
            "edge",
        ))
        .await
        .unwrap();
        (authority_id, policy_id, profile_id, application_id)
    }

    /// Record an issuance request and its certificate. The 0013 schema keeps
    /// `request_id` a NOT NULL foreign key, so inventory rows always have one.
    async fn seed_certificate(
        db: &Db,
        organization_id: &str,
        authority_id: &str,
        suffix: &str,
    ) -> StoredManagedCertificate {
        let request_id = format!("request:{suffix}");
        db.insert_certificate_issuance_request(&certificate_request(
            organization_id,
            authority_id,
            &request_id,
            &format!("idem:{suffix}"),
        ))
        .await
        .unwrap();
        let certificate = certmgr_managed_certificate(
            organization_id,
            authority_id,
            &request_id,
            &format!("cert:{suffix}"),
        );
        db.insert_managed_certificate(&certificate).await.unwrap();
        certificate
    }

    fn certmgr_signer(organization_id: &str, id: &str, name: &str) -> StoredSigner {
        StoredSigner {
            id: id.into(),
            organization_id: organization_id.into(),
            name: name.into(),
            certificate_id: None,
            key_source: "sealed".into(),
            hsm_connector_id: None,
            hsm_key_label: None,
            status: "active".into(),
            auto_renew: false,
            renew_before_seconds: None,
            sealed_key: Some(certmgr_sealed("signer")),
            version: 1,
            created_at: CERTMGR_NOW.into(),
            updated_at: CERTMGR_NOW.into(),
        }
    }

    fn certmgr_approval_policy(
        organization_id: &str,
        id: &str,
        name: &str,
        application_id: &str,
    ) -> StoredApprovalPolicy {
        StoredApprovalPolicy {
            id: id.into(),
            organization_id: organization_id.into(),
            scope: "issuance".into(),
            application_id: Some(application_id.into()),
            signer_id: None,
            name: name.into(),
            max_request_ttl_seconds: Some(3600),
            machine_bypass: false,
            covers_json: "[]".into(),
            version: 1,
            created_at: CERTMGR_NOW.into(),
            updated_at: CERTMGR_NOW.into(),
        }
    }

    fn certmgr_approval_request(
        organization_id: &str,
        id: &str,
        policy_id: &str,
    ) -> StoredApprovalRequest {
        StoredApprovalRequest {
            id: id.into(),
            organization_id: organization_id.into(),
            policy_id: policy_id.into(),
            kind: "issuance".into(),
            requester: "principal:requester".into(),
            status: "open".into(),
            current_step: 0,
            expires_at: "2099-01-01T00:00:00+00:00".into(),
            payload_digest: "sha256:payload".into(),
            scope_json: "{}".into(),
            result_id: None,
            version: 1,
            created_at: CERTMGR_NOW.into(),
            updated_at: CERTMGR_NOW.into(),
        }
    }

    fn certmgr_installation(
        organization_id: &str,
        id: &str,
        job_id: &str,
        host: &str,
    ) -> StoredDiscoveryInstallation {
        StoredDiscoveryInstallation {
            id: id.into(),
            organization_id: organization_id.into(),
            job_id: job_id.into(),
            host: host.into(),
            port: 443,
            fingerprint_sha256: "fp:observed".into(),
            cn: Some(host.into()),
            issuer: Some("CN=Edge".into()),
            not_after: Some("2026-12-01T00:00:00+00:00".into()),
            first_seen_at: CERTMGR_NOW.into(),
            last_seen_at: CERTMGR_NOW.into(),
            change_log_json: "[]".into(),
            matched_certificate_id: None,
            version: 1,
            created_at: CERTMGR_NOW.into(),
            updated_at: CERTMGR_NOW.into(),
        }
    }

    fn certmgr_discovery_job(organization_id: &str, id: &str, name: &str) -> StoredDiscoveryJob {
        StoredDiscoveryJob {
            id: id.into(),
            organization_id: organization_id.into(),
            name: name.into(),
            description: None,
            targets_json: r#"{"domains":["example.com"],"ips":[],"cidrs":[]}"#.into(),
            ports_json: "[443]".into(),
            auto_scan: false,
            scan_interval_days: Some(7),
            gateway_ref: None,
            allow_internal: false,
            last_scan_at: None,
            status: "idle".into(),
            version: 1,
            created_at: CERTMGR_NOW.into(),
            updated_at: CERTMGR_NOW.into(),
        }
    }

    fn certmgr_access_record(
        organization_id: &str,
        id: &str,
        signer_id: &str,
        allowed: Option<i64>,
    ) -> StoredSigningAccessRecord {
        StoredSigningAccessRecord {
            id: id.into(),
            organization_id: organization_id.into(),
            signer_id: signer_id.into(),
            approval_request_id: None,
            status: "active".into(),
            signatures_allowed: allowed,
            signatures_used: 0,
            window_expires_at: Some("2099-01-01T00:00:00+00:00".into()),
            scope_json: "{}".into(),
            version: 1,
            created_at: CERTMGR_NOW.into(),
            updated_at: CERTMGR_NOW.into(),
        }
    }

    // —— certificate manager unit tests ————————————————————————————

    #[tokio::test]
    async fn certmgr_migration_applies_from_an_empty_database() {
        let db = Db::connect_memory().await.unwrap();
        assert!(db
            .applied_migrations()
            .await
            .unwrap()
            .contains(&"0016_certificate_manager".to_string()));
        for table in [
            "certificate_policies",
            "certificate_profiles",
            "pki_applications",
            "pki_application_members",
            "enrollment_configs",
            "managed_certificate_keys",
            "certificate_revocations",
            "crl_state",
            "discovery_jobs",
            "discovery_installations",
            "hsm_connectors",
            "external_ca_configs",
            "signers",
            "signer_members",
            "approval_policies",
            "approval_steps",
            "approval_requests",
            "approval_decisions",
            "signing_access_records",
            "signing_events",
            "cert_alerts",
            "alert_deliveries",
            "cert_syncs",
            "sync_runs",
            "acme_server_accounts",
            "acme_orders",
            "acme_challenges",
            "acme_nonces",
            "est_configs",
            "scep_configs",
            "scep_challenges",
        ] {
            sqlx::query(&format!("SELECT 1 FROM {table} LIMIT 0"))
                .execute(db.pool())
                .await
                .unwrap_or_else(|error| panic!("{table} is missing: {error}"));
        }
    }

    #[tokio::test]
    async fn certmgr_policies_and_profiles_round_trip() {
        let db = Db::connect_memory().await.unwrap();
        let (authority, policy_id, profile_id, _) = seed_certmgr_org(&db, "org:one", "one").await;
        let stored = db
            .get_certificate_policy("org:one", &policy_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.preset, "tls_server");
        assert_eq!(
            db.list_certificate_policies("org:one").await.unwrap().len(),
            1
        );

        let profile = db
            .get_certificate_profile("org:one", &profile_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            profile.certificate_authority_id.as_deref(),
            Some(&*authority)
        );
        assert_eq!(
            db.list_certificate_profiles("org:one").await.unwrap().len(),
            1
        );

        let mut renamed = profile.clone();
        renamed.name = "edge-renamed".into();
        assert!(db.update_certificate_profile(&renamed).await.unwrap());
        assert!(db
            .delete_certificate_profile("org:one", &profile_id)
            .await
            .unwrap());
        assert!(db
            .delete_certificate_policy("org:one", &policy_id)
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn certmgr_application_membership_resolves_effective_roles() {
        let db = Db::connect_memory().await.unwrap();
        let (_, _, _, application_id) = seed_certmgr_org(&db, "org:one", "one").await;
        let member = StoredPkiApplicationMember {
            id: "member:one".into(),
            organization_id: "org:one".into(),
            application_id: application_id.clone(),
            subject: "principal:ada".into(),
            role: "operator".into(),
            version: 1,
            created_at: CERTMGR_NOW.into(),
            updated_at: CERTMGR_NOW.into(),
        };
        db.upsert_application_member(&member).await.unwrap();
        assert_eq!(
            db.effective_app_role("org:one", &application_id, "principal:ada")
                .await
                .unwrap(),
            Some(Role::Operator)
        );

        let mut promoted = member.clone();
        promoted.role = "admin".into();
        db.upsert_application_member(&promoted).await.unwrap();
        assert_eq!(
            db.effective_app_role("org:one", &application_id, "principal:ada")
                .await
                .unwrap(),
            Some(Role::Admin)
        );
        assert_eq!(
            db.list_application_members("org:one", &application_id)
                .await
                .unwrap()
                .len(),
            1
        );
        assert!(db
            .remove_application_member("org:one", &application_id, "principal:ada")
            .await
            .unwrap());
        assert!(db
            .effective_app_role("org:one", &application_id, "principal:ada")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn certmgr_enrollment_configuration_round_trips_its_sealed_secret() {
        let db = Db::connect_memory().await.unwrap();
        let (_, _, profile_id, application_id) = seed_certmgr_org(&db, "org:one", "one").await;
        let config = StoredEnrollmentConfig {
            id: "enroll:one".into(),
            organization_id: "org:one".into(),
            application_id: application_id.clone(),
            profile_id: profile_id.clone(),
            method: "est".into(),
            enabled: true,
            config_json: r#"{"port":8443}"#.into(),
            auto_renew_enabled: true,
            renew_before_seconds: Some(86_400),
            sealed_secret: Some(certmgr_sealed("enrollment")),
            version: 1,
            created_at: CERTMGR_NOW.into(),
            updated_at: CERTMGR_NOW.into(),
        };
        db.insert_enrollment_config(&config).await.unwrap();
        let stored = db
            .get_enrollment_config("org:one", "enroll:one")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.sealed_secret, Some(certmgr_sealed("enrollment")));
        assert_eq!(
            db.get_enrollment_by_profile_method("org:one", &profile_id, "est")
                .await
                .unwrap()
                .map(|found| found.id),
            Some("enroll:one".to_string())
        );
        assert_eq!(
            db.list_enrollment_configs("org:one", &application_id)
                .await
                .unwrap()
                .len(),
            1
        );
        assert!(db.update_enrollment_config(&stored).await.unwrap());
        assert!(db
            .delete_enrollment_config("org:one", "enroll:one")
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn certmgr_inventory_round_trips_with_metadata_and_managed_key() {
        let db = Db::connect_memory().await.unwrap();
        let (authority, ..) = seed_certmgr_org(&db, "org:one", "one").await;
        let certificate = seed_certificate(&db, "org:one", &authority, "alpha").await;
        let stored = db
            .get_certificate("org:one", &certificate.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored, certificate);

        assert!(db
            .set_certificate_metadata("org:one", &certificate.id, r#"{"team":"platform"}"#)
            .await
            .unwrap());
        assert_eq!(
            db.get_certificate_metadata("org:one", &certificate.id)
                .await
                .unwrap()
                .as_deref(),
            Some(r#"{"team":"platform"}"#)
        );

        let key = StoredManagedCertificateKey {
            id: "key:alpha".into(),
            organization_id: "org:one".into(),
            certificate_id: certificate.id.clone(),
            sealed_key: certmgr_sealed("leaf"),
            version: 1,
            created_at: CERTMGR_NOW.into(),
            updated_at: CERTMGR_NOW.into(),
        };
        db.insert_managed_certificate_key(&key).await.unwrap();
        assert_eq!(
            db.get_managed_certificate_key("org:one", &certificate.id)
                .await
                .unwrap()
                .map(|found| found.sealed_key),
            Some(certmgr_sealed("leaf"))
        );
        assert!(db
            .delete_managed_certificate_key("org:one", &certificate.id)
            .await
            .unwrap());
        assert!(db
            .delete_certificate("org:one", &certificate.id)
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn certmgr_managed_key_custody_never_widens_the_inventory_row() {
        let db = Db::connect_memory().await.unwrap();
        let columns: Vec<String> = sqlx::query("PRAGMA table_info(issued_certificates)")
            .fetch_all(db.pool())
            .await
            .unwrap()
            .into_iter()
            .map(|row| row.get::<String, _>("name"))
            .collect();
        assert!(columns.iter().all(|column| {
            !column.contains("private")
                && !column.contains("ciphertext")
                && !column.contains("nonce")
                && !column.contains("sealed")
        }));

        // Private key material lives in exactly three tables: the pre-0016
        // authority keys, code-signing keys, and managed leaf keys. The
        // inventory row is not one of them.
        let key_tables: Vec<String> = sqlx::query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%sealed\\_key%' ESCAPE '\\' ORDER BY name",
        )
        .fetch_all(db.pool())
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.get::<String, _>("name"))
        .collect();
        assert_eq!(
            key_tables,
            vec![
                "certificate_authorities",
                "managed_certificate_keys",
                "signers"
            ]
        );

        let sql = CertificateFilter::default().to_query().sql;
        assert!(!sql.contains("managed_certificate_keys"));
        assert!(!sql.contains("sealed"));
    }

    #[tokio::test]
    async fn certmgr_rows_are_isolated_between_organizations() {
        let db = Db::connect_memory().await.unwrap();
        let (authority, policy_id, _, application_id) =
            seed_certmgr_org(&db, "org:one", "one").await;
        seed_certmgr_org(&db, "org:two", "two").await;
        let certificate = seed_certificate(&db, "org:one", &authority, "alpha").await;

        db.insert_signer(&certmgr_signer("org:one", "signer:one", "release"))
            .await
            .unwrap();
        db.insert_approval_policy(&certmgr_approval_policy(
            "org:one",
            "approval:one",
            "two-step",
            &application_id,
        ))
        .await
        .unwrap();
        db.insert_approval_request(&certmgr_approval_request(
            "org:one",
            "request:approval",
            "approval:one",
        ))
        .await
        .unwrap();
        db.insert_discovery_job(&certmgr_discovery_job("org:one", "job:one", "edge"))
            .await
            .unwrap();
        db.record_installation(&certmgr_installation(
            "org:one",
            "install:one",
            "job:one",
            "alpha.example",
        ))
        .await
        .unwrap();

        assert!(db
            .get_certificate_policy("org:two", &policy_id)
            .await
            .unwrap()
            .is_none());
        assert!(db
            .list_certificate_policies("org:two")
            .await
            .unwrap()
            .iter()
            .all(|policy| policy.id != policy_id));
        assert!(db
            .get_certificate("org:two", &certificate.id)
            .await
            .unwrap()
            .is_none());
        assert!(db
            .list_certificates("org:two", &CertificateFilter::default())
            .await
            .unwrap()
            .is_empty());
        assert!(db
            .get_signer("org:two", "signer:one")
            .await
            .unwrap()
            .is_none());
        assert!(db.list_signers("org:two").await.unwrap().is_empty());
        assert!(db
            .get_approval_request("org:two", "request:approval")
            .await
            .unwrap()
            .is_none());
        assert!(db
            .list_approval_requests("org:two", None)
            .await
            .unwrap()
            .is_empty());
        assert!(db
            .list_installations("org:two", None)
            .await
            .unwrap()
            .is_empty());
        assert!(db
            .match_installation_by_fingerprint("org:two", "fp:observed")
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn certmgr_stale_version_loses_the_optimistic_update() {
        let db = Db::connect_memory().await.unwrap();
        let (_, policy_id, ..) = seed_certmgr_org(&db, "org:one", "one").await;
        let policy = db
            .get_certificate_policy("org:one", &policy_id)
            .await
            .unwrap()
            .unwrap();
        let mut edit = policy.clone();
        edit.description = Some("first writer".into());
        assert!(db.update_certificate_policy(&edit).await.unwrap());

        let mut stale = policy;
        stale.description = Some("second writer".into());
        assert!(!db.update_certificate_policy(&stale).await.unwrap());
        assert_eq!(
            db.get_certificate_policy("org:one", &policy_id)
                .await
                .unwrap()
                .unwrap()
                .description
                .as_deref(),
            Some("first writer")
        );
    }

    #[tokio::test]
    async fn certmgr_partial_sealed_group_is_rejected_by_the_database() {
        let db = Db::connect_memory().await.unwrap();
        let (_, _, profile_id, application_id) = seed_certmgr_org(&db, "org:one", "one").await;
        let partial = sqlx::query(
            "INSERT INTO enrollment_configs (id, organization_id, application_id, profile_id, method, enabled, config_json, auto_renew_enabled, renew_before_seconds, sealed_secret_key_id, sealed_secret_ciphertext, sealed_secret_nonce, sealed_secret_aad_digest, version, created_at, updated_at) \
             VALUES ('enroll:partial', 'org:one', ?, ?, 'scep', 1, '{}', 0, NULL, 'seal:v1', X'0102', X'0304', NULL, 1, ?, ?)",
        )
        .bind(&application_id)
        .bind(&profile_id)
        .bind(CERTMGR_NOW)
        .bind(CERTMGR_NOW)
        .execute(db.pool())
        .await;
        assert!(partial.is_err());

        let mut broken = certmgr_sealed("enrollment");
        broken.nonce.clear();
        let config = StoredEnrollmentConfig {
            id: "enroll:broken".into(),
            organization_id: "org:one".into(),
            application_id,
            profile_id,
            method: "scep".into(),
            enabled: true,
            config_json: "{}".into(),
            auto_renew_enabled: false,
            renew_before_seconds: None,
            sealed_secret: Some(broken),
            version: 1,
            created_at: CERTMGR_NOW.into(),
            updated_at: CERTMGR_NOW.into(),
        };
        assert!(db.insert_enrollment_config(&config).await.is_err());
    }

    #[tokio::test]
    async fn certmgr_scep_challenge_is_single_use_and_expiring() {
        let db = Db::connect_memory().await.unwrap();
        let (_, _, profile_id, _) = seed_certmgr_org(&db, "org:one", "one").await;
        let config = StoredScepConfig {
            id: "scep:one".into(),
            organization_id: "org:one".into(),
            profile_id,
            challenge_mode: "dynamic".into(),
            sealed_static_secret: None,
            ra_signs_with_ca: true,
            include_ca_cert: true,
            allow_cert_renewal: false,
            version: 1,
            created_at: CERTMGR_NOW.into(),
            updated_at: CERTMGR_NOW.into(),
        };
        db.insert_scep_config(&config).await.unwrap();

        let id = db
            .mint_scep_challenge(
                "org:one",
                "scep:one",
                "sha256:challenge",
                "2099-01-01T00:00:00+00:00",
            )
            .await
            .unwrap();
        db.consume_scep_challenge("org:one", "scep:one", "sha256:challenge")
            .await
            .unwrap();
        assert!(db
            .consume_scep_challenge("org:one", "scep:one", "sha256:challenge")
            .await
            .is_err());
        assert!(db
            .get_scep_challenge("org:one", &id)
            .await
            .unwrap()
            .unwrap()
            .consumed_at
            .is_some());

        db.mint_scep_challenge(
            "org:one",
            "scep:one",
            "sha256:expired",
            "2020-01-01T00:00:00+00:00",
        )
        .await
        .unwrap();
        assert!(db
            .consume_scep_challenge("org:one", "scep:one", "sha256:expired")
            .await
            .is_err());
    }

    #[tokio::test]
    async fn certmgr_acme_nonce_is_single_use() {
        let db = Db::connect_memory().await.unwrap();
        let nonce = db.mint_acme_nonce("org:one").await.unwrap();
        db.consume_acme_nonce("org:one", &nonce).await.unwrap();
        assert!(db.consume_acme_nonce("org:one", &nonce).await.is_err());
        assert!(db
            .consume_acme_nonce("org:one", "never-minted")
            .await
            .is_err());
    }

    #[tokio::test]
    async fn certmgr_signature_count_stops_at_the_cap() {
        let db = Db::connect_memory().await.unwrap();
        seed_certmgr_org(&db, "org:one", "one").await;
        db.insert_signer(&certmgr_signer("org:one", "signer:one", "release"))
            .await
            .unwrap();
        db.insert_signing_access_record(&certmgr_access_record(
            "org:one",
            "record:one",
            "signer:one",
            Some(2),
        ))
        .await
        .unwrap();
        assert_eq!(
            db.increment_signature_count("org:one", "record:one")
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            db.increment_signature_count("org:one", "record:one")
                .await
                .unwrap(),
            2
        );
        assert!(db
            .increment_signature_count("org:one", "record:one")
            .await
            .is_err());
        assert_eq!(
            db.list_active_records("org:one", "signer:one")
                .await
                .unwrap()
                .len(),
            1
        );
        assert!(db
            .revoke_access_record("org:one", "record:one")
            .await
            .unwrap());
        assert!(db
            .increment_signature_count("org:one", "record:one")
            .await
            .is_err());
    }

    #[tokio::test]
    async fn certmgr_approval_transition_rejects_a_stale_expectation() {
        let db = Db::connect_memory().await.unwrap();
        let (_, _, _, application_id) = seed_certmgr_org(&db, "org:one", "one").await;
        db.insert_approval_policy(&certmgr_approval_policy(
            "org:one",
            "approval:one",
            "two-step",
            &application_id,
        ))
        .await
        .unwrap();
        db.insert_approval_request(&certmgr_approval_request(
            "org:one",
            "request:approval",
            "approval:one",
        ))
        .await
        .unwrap();
        db.transition_approval_request("org:one", "request:approval", "open", "approved")
            .await
            .unwrap();
        assert!(db
            .transition_approval_request("org:one", "request:approval", "open", "rejected")
            .await
            .is_err());
        assert!(db
            .transition_approval_request("org:two", "request:approval", "approved", "cancelled")
            .await
            .is_err());
    }

    #[tokio::test]
    async fn certmgr_approval_steps_and_decisions_round_trip() {
        let db = Db::connect_memory().await.unwrap();
        let (_, _, _, application_id) = seed_certmgr_org(&db, "org:one", "one").await;
        db.insert_approval_policy(&certmgr_approval_policy(
            "org:one",
            "approval:one",
            "two-step",
            &application_id,
        ))
        .await
        .unwrap();
        for seq in 0..2 {
            db.insert_approval_step(&StoredApprovalStep {
                id: format!("step:{seq}"),
                organization_id: "org:one".into(),
                policy_id: "approval:one".into(),
                seq,
                name: format!("step {seq}"),
                approvers_json: r#"["principal:ada"]"#.into(),
                required_count: 1,
                notify: true,
                version: 1,
                created_at: CERTMGR_NOW.into(),
                updated_at: CERTMGR_NOW.into(),
            })
            .await
            .unwrap();
        }
        assert_eq!(
            db.list_steps_for_policy("org:one", "approval:one")
                .await
                .unwrap()
                .len(),
            2
        );

        db.insert_approval_request(&certmgr_approval_request(
            "org:one",
            "request:approval",
            "approval:one",
        ))
        .await
        .unwrap();
        db.insert_approval_decision(&StoredApprovalDecision {
            id: "decision:one".into(),
            organization_id: "org:one".into(),
            request_id: "request:approval".into(),
            step_seq: 0,
            approver: "principal:ada".into(),
            decision: "approve".into(),
            comment: Some("looks right".into()),
            decided_at: CERTMGR_NOW.into(),
            version: 1,
            created_at: CERTMGR_NOW.into(),
            updated_at: CERTMGR_NOW.into(),
        })
        .await
        .unwrap();
        assert_eq!(
            db.list_decisions_for_request("org:one", "request:approval")
                .await
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            db.advance_approval_step("org:one", "request:approval", 0)
                .await
                .unwrap(),
            1
        );
        assert!(db
            .advance_approval_step("org:one", "request:approval", 0)
            .await
            .is_err());
        assert!(db
            .set_approval_result("org:one", "request:approval", "cert:alpha")
            .await
            .unwrap());
        assert!(db.delete_approval_step("org:one", "step:1").await.unwrap());
        assert_eq!(db.list_approval_policies("org:one").await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn certmgr_signer_membership_and_activity_round_trip() {
        let db = Db::connect_memory().await.unwrap();
        seed_certmgr_org(&db, "org:one", "one").await;
        db.insert_signer(&certmgr_signer("org:one", "signer:one", "release"))
            .await
            .unwrap();
        db.upsert_signer_member(&StoredSignerMember {
            id: "signer-member:one".into(),
            organization_id: "org:one".into(),
            signer_id: "signer:one".into(),
            subject: "principal:ada".into(),
            role: "administrator".into(),
            version: 1,
            created_at: CERTMGR_NOW.into(),
            updated_at: CERTMGR_NOW.into(),
        })
        .await
        .unwrap();
        assert_eq!(
            db.effective_signer_role("org:one", "signer:one", "principal:ada")
                .await
                .unwrap(),
            Some(Role::Admin)
        );
        assert_eq!(
            db.list_signer_members("org:one", "signer:one")
                .await
                .unwrap()
                .len(),
            1
        );

        db.append_signing_event(&StoredSigningEvent {
            id: "event:one".into(),
            organization_id: "org:one".into(),
            signer_id: "signer:one".into(),
            access_record_id: None,
            outcome: "succeeded".into(),
            command: Some("signtool sign".into()),
            application_name: Some("installer.exe".into()),
            application_sha256: Some("sha256:app".into()),
            hostname: Some("build-01".into()),
            os_username: Some("build".into()),
            ip: Some("10.0.0.4".into()),
            data_hash: Some("sha256:data".into()),
            occurred_at: CERTMGR_NOW.into(),
            version: 1,
            created_at: CERTMGR_NOW.into(),
            updated_at: CERTMGR_NOW.into(),
        })
        .await
        .unwrap();
        assert_eq!(
            db.list_signing_events("org:one", "signer:one")
                .await
                .unwrap()
                .len(),
            1
        );

        let signer = db
            .get_signer("org:one", "signer:one")
            .await
            .unwrap()
            .unwrap();
        assert!(db.update_signer(&signer).await.unwrap());
        assert!(db
            .remove_signer_member("org:one", "signer:one", "principal:ada")
            .await
            .unwrap());
        assert!(db.delete_signer("org:one", "signer:one").await.unwrap());
    }

    #[tokio::test]
    async fn certmgr_alerts_round_trip() {
        let db = Db::connect_memory().await.unwrap();
        let (_, _, _, application_id) = seed_certmgr_org(&db, "org:one", "one").await;

        let alert = StoredCertAlert {
            id: "alert:one".into(),
            organization_id: "org:one".into(),
            application_id,
            alert_type: "expiration".into(),
            before_window_seconds: Some(2_592_000),
            daily_reminder: true,
            channels_json: r#"[{"kind":"email","addresses":["ops@example.com"]}]"#.into(),
            version: 1,
            created_at: CERTMGR_NOW.into(),
            updated_at: CERTMGR_NOW.into(),
        };
        db.insert_cert_alert(&alert).await.unwrap();
        assert_eq!(
            db.get_cert_alert("org:one", "alert:one")
                .await
                .unwrap()
                .unwrap()
                .alert_type,
            "expiration"
        );
        assert_eq!(
            db.list_cert_alerts("org:one", &alert.application_id)
                .await
                .unwrap()
                .len(),
            1
        );
        db.record_alert_delivery(&StoredAlertDelivery {
            id: "delivery:one".into(),
            organization_id: "org:one".into(),
            alert_id: "alert:one".into(),
            channel: "email".into(),
            outcome: "succeeded".into(),
            attempts: 1,
            last_attempt_at: Some(CERTMGR_NOW.into()),
            payload_digest: "sha256:payload".into(),
            version: 1,
            created_at: CERTMGR_NOW.into(),
            updated_at: CERTMGR_NOW.into(),
        })
        .await
        .unwrap();
        assert_eq!(
            db.list_alert_deliveries("org:one", "alert:one")
                .await
                .unwrap()
                .len(),
            1
        );
        assert!(db.update_cert_alert(&alert).await.unwrap());
        assert!(db.delete_cert_alert("org:one", "alert:one").await.unwrap());
    }

    #[tokio::test]
    async fn certmgr_syncs_round_trip() {
        let db = Db::connect_memory().await.unwrap();
        let (authority, ..) = seed_certmgr_org(&db, "org:one", "one").await;
        let certificate = seed_certificate(&db, "org:one", &authority, "alpha").await;
        let sync = StoredCertSync {
            id: "sync:one".into(),
            organization_id: "org:one".into(),
            certificate_id: certificate.id.clone(),
            destination_kind: "aws_certificate_manager".into(),
            connection_id: "connection:aws".into(),
            name_schema: "{{certificateId}}".into(),
            remove_on_expiry: true,
            include_root: false,
            options_json: "{}".into(),
            enabled: true,
            last_run_at: None,
            version: 1,
            created_at: CERTMGR_NOW.into(),
            updated_at: CERTMGR_NOW.into(),
        };
        db.insert_cert_sync(&sync).await.unwrap();
        assert_eq!(db.list_cert_syncs("org:one").await.unwrap().len(), 1);
        assert_eq!(
            db.list_active_syncs_for_certificate("org:one", &certificate.id)
                .await
                .unwrap()
                .len(),
            1
        );
        db.record_sync_run(&StoredSyncRun {
            id: "run:one".into(),
            organization_id: "org:one".into(),
            sync_id: "sync:one".into(),
            outcome: "succeeded".into(),
            detail: None,
            ran_at: CERTMGR_NOW.into(),
            version: 1,
            created_at: CERTMGR_NOW.into(),
            updated_at: CERTMGR_NOW.into(),
        })
        .await
        .unwrap();
        assert_eq!(
            db.list_sync_runs("org:one", "sync:one")
                .await
                .unwrap()
                .len(),
            1
        );
        let ran = db
            .get_cert_sync("org:one", "sync:one")
            .await
            .unwrap()
            .unwrap();
        assert!(ran.last_run_at.is_some());
        // The run stamped the parent row, so the pre-run version is now stale.
        assert!(!db.update_cert_sync(&sync).await.unwrap());
        assert!(db.update_cert_sync(&ran).await.unwrap());
        assert!(db.delete_cert_sync("org:one", "sync:one").await.unwrap());
    }

    #[tokio::test]
    async fn certmgr_connectors_and_external_authorities_round_trip() {
        let db = Db::connect_memory().await.unwrap();
        seed_certmgr_org(&db, "org:one", "one").await;
        let connector = StoredHsmConnector {
            id: "hsm:one".into(),
            organization_id: "org:one".into(),
            label: "luna-1".into(),
            sealed_pin: Some(certmgr_sealed("hsm")),
            module_hint: "libcklog2.so".into(),
            key_label_prefix: Some("os-".into()),
            gateway_ref: None,
            status: "unverified".into(),
            version: 1,
            created_at: CERTMGR_NOW.into(),
            updated_at: CERTMGR_NOW.into(),
        };
        db.insert_hsm_connector(&connector).await.unwrap();
        assert_eq!(
            db.get_hsm_connector("org:one", "hsm:one")
                .await
                .unwrap()
                .unwrap()
                .sealed_pin,
            Some(certmgr_sealed("hsm"))
        );
        assert_eq!(db.list_hsm_connectors("org:one").await.unwrap().len(), 1);
        assert!(db.update_hsm_connector(&connector).await.unwrap());

        let external = StoredExternalCaConfig {
            id: "external:one".into(),
            organization_id: "org:one".into(),
            kind: "aws_pca".into(),
            connection_id: "connection:aws".into(),
            config_json: r#"{"arn":"arn:aws:acm-pca"}"#.into(),
            trust_class: "private_local".into(),
            auto_renew: true,
            renew_before_seconds: Some(2_592_000),
            version: 1,
            created_at: CERTMGR_NOW.into(),
            updated_at: CERTMGR_NOW.into(),
        };
        db.insert_external_ca_config(&external).await.unwrap();
        assert!(db
            .get_external_ca_config("org:one", "external:one")
            .await
            .unwrap()
            .is_some());
        assert_eq!(
            db.list_external_ca_configs("org:one").await.unwrap().len(),
            1
        );
        assert!(db.update_external_ca_config(&external).await.unwrap());
        assert!(db
            .delete_external_ca_config("org:one", "external:one")
            .await
            .unwrap());
        assert!(db.delete_hsm_connector("org:one", "hsm:one").await.unwrap());
    }

    #[tokio::test]
    async fn certmgr_acme_server_state_round_trips() {
        let db = Db::connect_memory().await.unwrap();
        let (_, _, profile_id, _) = seed_certmgr_org(&db, "org:one", "one").await;
        db.insert_acme_account(&StoredAcmeAccount {
            id: "acme:one".into(),
            organization_id: "org:one".into(),
            profile_id: profile_id.clone(),
            jwk_thumbprint: "thumb:one".into(),
            eab_kid: Some("kid:one".into()),
            status: "valid".into(),
            contacts_json: r#"["mailto:ops@example.com"]"#.into(),
            version: 1,
            created_at: CERTMGR_NOW.into(),
            updated_at: CERTMGR_NOW.into(),
        })
        .await
        .unwrap();
        assert!(db
            .get_acme_account("org:one", "acme:one")
            .await
            .unwrap()
            .is_some());
        assert!(db
            .get_acme_account_by_thumbprint("org:one", &profile_id, "thumb:one")
            .await
            .unwrap()
            .is_some());
        assert_eq!(
            db.list_acme_accounts("org:one", &profile_id)
                .await
                .unwrap()
                .len(),
            1
        );
        assert!(db
            .update_acme_account_status("org:one", "acme:one", "deactivated")
            .await
            .unwrap());

        db.insert_acme_order(&StoredAcmeOrder {
            id: "order:one".into(),
            organization_id: "org:one".into(),
            account_id: "acme:one".into(),
            status: "pending".into(),
            identifiers_json: r#"[{"type":"dns","value":"alpha.example"}]"#.into(),
            expires_at: "2099-01-01T00:00:00+00:00".into(),
            finalize_csr_pem: None,
            certificate_id: None,
            version: 1,
            created_at: CERTMGR_NOW.into(),
            updated_at: CERTMGR_NOW.into(),
        })
        .await
        .unwrap();
        db.transition_acme_order("org:one", "order:one", "pending", "ready")
            .await
            .unwrap();
        assert!(db
            .transition_acme_order("org:one", "order:one", "pending", "valid")
            .await
            .is_err());
        assert_eq!(
            db.list_acme_orders("org:one", "acme:one")
                .await
                .unwrap()
                .len(),
            1
        );
        assert!(db
            .get_acme_order("org:one", "order:one")
            .await
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn certmgr_acme_challenges_round_trip() {
        let db = Db::connect_memory().await.unwrap();
        let (_, _, profile_id, _) = seed_certmgr_org(&db, "org:one", "one").await;
        db.insert_acme_account(&StoredAcmeAccount {
            id: "acme:one".into(),
            organization_id: "org:one".into(),
            profile_id,
            jwk_thumbprint: "thumb:one".into(),
            eab_kid: None,
            status: "valid".into(),
            contacts_json: "[]".into(),
            version: 1,
            created_at: CERTMGR_NOW.into(),
            updated_at: CERTMGR_NOW.into(),
        })
        .await
        .unwrap();
        db.insert_acme_order(&StoredAcmeOrder {
            id: "order:one".into(),
            organization_id: "org:one".into(),
            account_id: "acme:one".into(),
            status: "pending".into(),
            identifiers_json: "[]".into(),
            expires_at: "2099-01-01T00:00:00+00:00".into(),
            finalize_csr_pem: None,
            certificate_id: None,
            version: 1,
            created_at: CERTMGR_NOW.into(),
            updated_at: CERTMGR_NOW.into(),
        })
        .await
        .unwrap();
        db.insert_acme_challenge(&StoredAcmeChallenge {
            id: "challenge:one".into(),
            organization_id: "org:one".into(),
            order_id: "order:one".into(),
            authz_id: "authz:one".into(),
            challenge_type: "http-01".into(),
            token: "token:one".into(),
            status: "pending".into(),
            version: 1,
            created_at: CERTMGR_NOW.into(),
            updated_at: CERTMGR_NOW.into(),
        })
        .await
        .unwrap();
        assert!(db
            .update_acme_challenge_status("org:one", "challenge:one", "valid")
            .await
            .unwrap());
        assert_eq!(
            db.get_acme_challenge("org:one", "challenge:one")
                .await
                .unwrap()
                .unwrap()
                .status,
            "valid"
        );
        assert_eq!(
            db.list_acme_challenges("org:one", "order:one")
                .await
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn certmgr_est_and_scep_configs_round_trip() {
        let db = Db::connect_memory().await.unwrap();
        let (_, _, profile_id, _) = seed_certmgr_org(&db, "org:one", "one").await;
        let est = StoredEstConfig {
            id: "est:one".into(),
            organization_id: "org:one".into(),
            profile_id: profile_id.clone(),
            sealed_passphrase: Some(certmgr_sealed("est")),
            bootstrap_chain_pem: None,
            require_bootstrap: true,
            version: 1,
            created_at: CERTMGR_NOW.into(),
            updated_at: CERTMGR_NOW.into(),
        };
        db.insert_est_config(&est).await.unwrap();
        assert_eq!(
            db.get_est_config("org:one", &profile_id)
                .await
                .unwrap()
                .unwrap()
                .sealed_passphrase,
            Some(certmgr_sealed("est"))
        );
        assert_eq!(db.list_est_configs("org:one").await.unwrap().len(), 1);
        assert!(db.update_est_config(&est).await.unwrap());
        assert!(db.delete_est_config("org:one", "est:one").await.unwrap());

        let scep = StoredScepConfig {
            id: "scep:one".into(),
            organization_id: "org:one".into(),
            profile_id: profile_id.clone(),
            challenge_mode: "static".into(),
            sealed_static_secret: Some(certmgr_sealed("scep")),
            ra_signs_with_ca: true,
            include_ca_cert: true,
            allow_cert_renewal: true,
            version: 1,
            created_at: CERTMGR_NOW.into(),
            updated_at: CERTMGR_NOW.into(),
        };
        db.insert_scep_config(&scep).await.unwrap();
        assert!(db
            .get_scep_config("org:one", &profile_id)
            .await
            .unwrap()
            .is_some());
        assert_eq!(db.list_scep_configs("org:one").await.unwrap().len(), 1);
        assert!(db.update_scep_config(&scep).await.unwrap());
        assert!(db.delete_scep_config("org:one", "scep:one").await.unwrap());
    }

    #[tokio::test]
    async fn certmgr_discovery_jobs_and_installations_round_trip() {
        let db = Db::connect_memory().await.unwrap();
        seed_certmgr_org(&db, "org:one", "one").await;
        let job = certmgr_discovery_job("org:one", "job:one", "edge");
        db.insert_discovery_job(&job).await.unwrap();
        assert!(db
            .get_discovery_job("org:one", "job:one")
            .await
            .unwrap()
            .is_some());
        assert_eq!(db.list_discovery_jobs("org:one").await.unwrap().len(), 1);
        assert!(db.update_discovery_job(&job).await.unwrap());

        let mut installation =
            certmgr_installation("org:one", "install:one", "job:one", "alpha.example");
        db.record_installation(&installation).await.unwrap();
        installation.last_seen_at = "2026-08-31T00:00:00+00:00".into();
        db.record_installation(&installation).await.unwrap();
        let stored = db
            .list_installations("org:one", Some("job:one"))
            .await
            .unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].version, 2);
        assert_eq!(
            db.match_installation_by_fingerprint("org:one", "fp:observed")
                .await
                .unwrap()
                .len(),
            1
        );
        assert!(db.delete_discovery_job("org:one", "job:one").await.unwrap());
        assert!(db
            .list_installations("org:one", None)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn certmgr_revocation_and_crl_state_round_trip() {
        let db = Db::connect_memory().await.unwrap();
        let (authority, ..) = seed_certmgr_org(&db, "org:one", "one").await;
        let certificate = seed_certificate(&db, "org:one", &authority, "alpha").await;
        db.insert_certificate_revocation(&StoredCertificateRevocation {
            id: "revocation:one".into(),
            organization_id: "org:one".into(),
            certificate_id: certificate.id.clone(),
            ca_id: authority.clone(),
            serial: certificate.serial_number.clone(),
            reason_code: 1,
            revoked_at: CERTMGR_NOW.into(),
            crl_number: Some(1),
            version: 1,
            created_at: CERTMGR_NOW.into(),
            updated_at: CERTMGR_NOW.into(),
        })
        .await
        .unwrap();
        let revoked = db
            .get_certificate("org:one", &certificate.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(revoked.status, "revoked");
        assert_eq!(revoked.revocation_reason, Some(1));
        assert_eq!(
            db.list_revocations_for_ca("org:one", &authority)
                .await
                .unwrap()
                .len(),
            1
        );

        let state = StoredCrlState {
            id: "crl:one".into(),
            organization_id: "org:one".into(),
            ca_id: authority.clone(),
            crl_number: 1,
            this_update: CERTMGR_NOW.into(),
            next_update: "2026-09-06T00:00:00+00:00".into(),
            sealed_der: Some(certmgr_sealed("crl")),
            mirror_urls_json: Some(r#"["https://crl.example/one.crl"]"#.into()),
            version: 1,
            created_at: CERTMGR_NOW.into(),
            updated_at: CERTMGR_NOW.into(),
        };
        db.upsert_crl_state(&state).await.unwrap();
        db.upsert_crl_state(&state).await.unwrap();
        let stored = db
            .get_crl_state("org:one", &authority)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.version, 2);
        assert_eq!(stored.sealed_der, Some(certmgr_sealed("crl")));
        assert!(db
            .get_crl_state("org:two", &authority)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn certmgr_authority_hierarchy_and_signing_config_round_trip() {
        let db = Db::connect_memory().await.unwrap();
        let (root, ..) = seed_certmgr_org(&db, "org:one", "one").await;
        db.insert_certificate_authority(&certificate_authority(
            "org:one",
            "ca:intermediate",
            false,
        ))
        .await
        .unwrap();
        assert!(db
            .insert_ca_link("org:one", "ca:intermediate", &root)
            .await
            .unwrap());
        assert_eq!(db.get_ca_children("org:one", &root).await.unwrap().len(), 1);
        assert_eq!(
            db.get_ca_parent("org:one", "ca:intermediate")
                .await
                .unwrap()
                .map(|parent| parent.id),
            Some(root.clone())
        );
        assert!(db.insert_ca_link("org:one", &root, &root).await.is_err());
        assert!(db
            .insert_ca_link("org:two", "ca:intermediate", &root)
            .await
            .is_err());

        let config = db
            .get_signing_config("org:one", "ca:intermediate")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(config.kind, "intermediate");
        let mut edited = config.clone();
        edited.crl_enabled = false;
        edited.crl_mirrors_json = Some(r#"["https://crl.example/int.crl"]"#.into());
        assert!(db.update_signing_config(&edited).await.unwrap());
        assert!(!db.update_signing_config(&config).await.unwrap());

        assert!(db
            .set_ca_pending_csr(
                "org:one",
                "ca:intermediate",
                "-----BEGIN CERTIFICATE REQUEST-----"
            )
            .await
            .unwrap());
        let pending = db
            .get_signing_config("org:one", "ca:intermediate")
            .await
            .unwrap()
            .unwrap();
        assert!(pending.pending_csr_pem.is_some());
        assert!(db
            .complete_ca_import(
                "org:one",
                "ca:intermediate",
                pending.version,
                r#"{"chain":1}"#
            )
            .await
            .unwrap());
        assert!(db
            .get_signing_config("org:one", "ca:intermediate")
            .await
            .unwrap()
            .unwrap()
            .pending_csr_pem
            .is_none());
    }

    #[tokio::test]
    async fn certmgr_renewal_link_is_recorded_in_both_directions() {
        let db = Db::connect_memory().await.unwrap();
        let (authority, ..) = seed_certmgr_org(&db, "org:one", "one").await;
        let first = seed_certificate(&db, "org:one", &authority, "alpha").await;
        let second = seed_certificate(&db, "org:one", &authority, "beta").await;
        db.insert_renewal_link("org:one", &first.id, &second.id)
            .await
            .unwrap();
        assert_eq!(
            db.get_renewed_by("org:one", &first.id)
                .await
                .unwrap()
                .map(|found| found.id),
            Some(second.id.clone())
        );
        assert_eq!(
            db.get_renewed_from("org:one", &second.id)
                .await
                .unwrap()
                .map(|found| found.id),
            Some(first.id.clone())
        );
        assert!(db
            .insert_renewal_link("org:one", &first.id, &first.id)
            .await
            .is_err());
        assert!(db
            .insert_renewal_link("org:two", &first.id, &second.id)
            .await
            .is_err());
    }

    /// Seed three certificates that differ in status, subject, SAN, profile,
    /// application, expiry and metadata. Returns
    /// `(alpha_id, gamma_id, profile_id, application_id)`.
    async fn seed_filter_fixture(db: &Db) -> (String, String, String, String) {
        let (authority, _, profile_id, application_id) =
            seed_certmgr_org(db, "org:one", "one").await;
        let alpha = seed_certificate(db, "org:one", &authority, "alpha").await;

        db.insert_certificate_issuance_request(&certificate_request(
            "org:one",
            &authority,
            "request:beta",
            "idem:beta",
        ))
        .await
        .unwrap();
        let mut beta =
            certmgr_managed_certificate("org:one", &authority, "request:beta", "cert:beta");
        beta.common_name = "beta.internal".into();
        beta.san_json = r#"{"dns_names":["beta.internal"],"ip_addrs":[]}"#.into();
        beta.profile_id = Some(profile_id.clone());
        beta.application_id = Some(application_id.clone());
        beta.status = "revoked".into();
        beta.expires_at = "2027-06-01T00:00:00+00:00".into();
        db.insert_managed_certificate(&beta).await.unwrap();

        db.insert_certificate_issuance_request(&certificate_request(
            "org:one",
            &authority,
            "request:gamma",
            "idem:gamma",
        ))
        .await
        .unwrap();
        let mut gamma =
            certmgr_managed_certificate("org:one", &authority, "request:gamma", "cert:gamma");
        gamma.common_name = "gamma.example".into();
        gamma.san_json = r#"{"dns_names":["gamma.example"],"ip_addrs":[]}"#.into();
        gamma.metadata_json = r#"{"team":"platform"}"#.into();
        gamma.expires_at = "2028-01-01T00:00:00+00:00".into();
        db.insert_managed_certificate(&gamma).await.unwrap();
        (alpha.id, gamma.id, profile_id, application_id)
    }

    #[tokio::test]
    async fn certmgr_list_certificates_filters_narrow_the_result() {
        let db = Db::connect_memory().await.unwrap();
        let (alpha_id, _, profile_id, application_id) = seed_filter_fixture(&db).await;

        let all = db
            .list_certificates("org:one", &CertificateFilter::default())
            .await
            .unwrap();
        assert_eq!(all.len(), 3);

        let active = db
            .list_certificates(
                "org:one",
                &CertificateFilter {
                    status: Some("active".into()),
                    ..CertificateFilter::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(active.len(), 2);

        let by_cn = db
            .list_certificates(
                "org:one",
                &CertificateFilter {
                    common_name_contains: Some("beta".into()),
                    ..CertificateFilter::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(by_cn.len(), 1);

        let by_san = db
            .list_certificates(
                "org:one",
                &CertificateFilter {
                    san_contains: Some("gamma.example".into()),
                    ..CertificateFilter::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(by_san.len(), 1);

        let by_profile = db
            .list_certificates(
                "org:one",
                &CertificateFilter {
                    profile_id: Some(profile_id),
                    application_id: Some(application_id),
                    ..CertificateFilter::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(by_profile.len(), 1);

        let expiring = db
            .list_certificates(
                "org:one",
                &CertificateFilter {
                    expiring_before: Some("2027-01-01T00:00:00+00:00".into()),
                    ..CertificateFilter::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(expiring.len(), 1);
        assert_eq!(expiring[0].id, alpha_id);
    }

    #[tokio::test]
    async fn certmgr_metadata_and_limit_filters_narrow_the_result() {
        let db = Db::connect_memory().await.unwrap();
        let (_, gamma_id, ..) = seed_filter_fixture(&db).await;

        let by_metadata = db
            .list_certificates(
                "org:one",
                &CertificateFilter {
                    metadata_key: Some("team".into()),
                    metadata_value: Some("platform".into()),
                    ..CertificateFilter::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(by_metadata.len(), 1);
        assert_eq!(by_metadata[0].id, gamma_id);

        let limited = db
            .list_certificates(
                "org:one",
                &CertificateFilter {
                    limit: Some(2),
                    ..CertificateFilter::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(limited.len(), 2);

        // A wildcard in caller input stays literal rather than matching all.
        let literal = db
            .list_certificates(
                "org:one",
                &CertificateFilter {
                    common_name_contains: Some("%".into()),
                    ..CertificateFilter::default()
                },
            )
            .await
            .unwrap();
        assert!(literal.is_empty());
    }

    #[tokio::test]
    async fn certmgr_dashboard_rollup_counts_a_seeded_fixture() {
        let db = Db::connect_memory().await.unwrap();
        let (authority, ..) = seed_certmgr_org(&db, "org:one", "one").await;
        let now = Utc::now();
        let seeds = [
            ("alpha", "active", "ecdsa-p256", "api", 3_i64),
            ("beta", "active", "rsa-2048", "acme", 20),
            ("gamma", "revoked", "ecdsa-p256", "est", 200),
        ];
        for (suffix, status, algorithm, method, days) in seeds {
            db.insert_certificate_issuance_request(&certificate_request(
                "org:one",
                &authority,
                &format!("request:{suffix}"),
                &format!("idem:{suffix}"),
            ))
            .await
            .unwrap();
            let mut certificate = certmgr_managed_certificate(
                "org:one",
                &authority,
                &format!("request:{suffix}"),
                &format!("cert:{suffix}"),
            );
            certificate.status = status.into();
            certificate.key_algorithm = Some(algorithm.into());
            certificate.enrollment_method = Some(method.into());
            certificate.expires_at = (now + Duration::days(days)).to_rfc3339();
            db.insert_managed_certificate(&certificate).await.unwrap();
        }

        let rollup = db.dashboard_rollup("org:one").await.unwrap();
        assert_eq!(rollup.total, 3);
        assert_eq!(rollup.by_status.get("active"), Some(&2));
        assert_eq!(rollup.by_status.get("revoked"), Some(&1));
        assert_eq!(rollup.by_key_algorithm.get("ecdsa-p256"), Some(&2));
        assert_eq!(rollup.by_key_algorithm.get("rsa-2048"), Some(&1));
        assert_eq!(rollup.by_issuing_ca.get(&authority), Some(&3));
        assert_eq!(rollup.by_enrollment_method.get("api"), Some(&1));
        assert_eq!(rollup.expiring_within_7_days, 1);
        assert_eq!(rollup.expiring_within_30_days, 2);
        assert_eq!(rollup.expiring_within_90_days, 2);
        assert_eq!(db.dashboard_rollup("org:two").await.unwrap().total, 0);
    }

    #[tokio::test]
    async fn certmgr_expiring_helper_matches_the_legacy_shape() {
        let db = Db::connect_memory().await.unwrap();
        let (authority, ..) = seed_certmgr_org(&db, "org:one", "one").await;
        seed_certificate(&db, "org:one", &authority, "alpha").await;
        assert_eq!(
            db.list_certificates_expiring_before("org:one", "2027-01-01T00:00:00+00:00")
                .await
                .unwrap()
                .len(),
            1
        );
        assert!(db
            .list_certificates_expiring_before("org:two", "2027-01-01T00:00:00+00:00")
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn certmgr_metadata_documents_are_bounded_and_scalar() {
        let db = Db::connect_memory().await.unwrap();
        let (authority, ..) = seed_certmgr_org(&db, "org:one", "one").await;
        let certificate = seed_certificate(&db, "org:one", &authority, "alpha").await;
        for rejected in [
            "[]".to_string(),
            r#"{"nested":{"a":1}}"#.to_string(),
            format!(r#"{{"big":"{}"}}"#, "x".repeat(20_000)),
            "not json".to_string(),
        ] {
            assert!(db
                .set_certificate_metadata("org:one", &certificate.id, &rejected)
                .await
                .is_err());
        }
        assert!(db
            .set_certificate_metadata("org:one", &certificate.id, r#"{"team":"platform"}"#)
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn certmgr_unknown_certificate_status_is_rejected_in_rust() {
        let db = Db::connect_memory().await.unwrap();
        let (authority, ..) = seed_certmgr_org(&db, "org:one", "one").await;
        db.insert_certificate_issuance_request(&certificate_request(
            "org:one",
            &authority,
            "request:bogus",
            "idem:bogus",
        ))
        .await
        .unwrap();
        let mut certificate =
            certmgr_managed_certificate("org:one", &authority, "request:bogus", "cert:bogus");
        certificate.status = "compromised".into();
        assert!(db.insert_managed_certificate(&certificate).await.is_err());
    }

    #[test]
    fn certmgr_sealed_carriers_redact_their_debug_output() {
        let material = SealedCertificateMaterial {
            key_id: "seal:v1".into(),
            ciphertext: b"super-secret".to_vec(),
            nonce: b"nonce".to_vec(),
            aad_digest: "sha256:aad".into(),
        };
        let signer = StoredSigner {
            id: "signer:one".into(),
            organization_id: "org:one".into(),
            name: "release".into(),
            certificate_id: None,
            key_source: "sealed".into(),
            hsm_connector_id: None,
            hsm_key_label: None,
            status: "active".into(),
            auto_renew: false,
            renew_before_seconds: None,
            sealed_key: Some(material.clone()),
            version: 1,
            created_at: CERTMGR_NOW.into(),
            updated_at: CERTMGR_NOW.into(),
        };
        let key = StoredManagedCertificateKey {
            id: "key:one".into(),
            organization_id: "org:one".into(),
            certificate_id: "cert:one".into(),
            sealed_key: material,
            version: 1,
            created_at: CERTMGR_NOW.into(),
            updated_at: CERTMGR_NOW.into(),
        };
        for rendered in [format!("{signer:?}"), format!("{key:?}")] {
            assert!(rendered.contains("[REDACTED]"));
            assert!(!rendered.contains("super-secret"));
            assert!(!rendered.contains("115"));
        }
    }

    #[test]
    fn certmgr_role_ladder_maps_both_spellings() {
        assert_eq!(Role::from_application_str("admin"), Some(Role::Admin));
        assert_eq!(Role::from_signer_str("administrator"), Some(Role::Admin));
        assert_eq!(Role::from_application_str("administrator"), None);
        assert_eq!(Role::from_signer_str("admin"), None);
        assert!(Role::Admin > Role::Operator && Role::Operator > Role::Auditor);
        assert_eq!(Role::Admin.as_application_str(), "admin");
        assert_eq!(Role::Admin.as_signer_str(), "administrator");
    }

    #[test]
    fn certmgr_filter_clamps_and_escapes_caller_patterns() {
        let long = "\u{00e9}".repeat(MAX_FILTER_PATTERN_LEN * 2);
        let query = CertificateFilter {
            common_name_contains: Some(long.clone()),
            san_contains: Some(long.clone()),
            metadata_key: Some(long.clone()),
            metadata_value: Some(long),
            ..CertificateFilter::default()
        }
        .to_query();
        // Clamped at a character boundary, so multi-byte input cannot split a
        // code point; each pattern is still exactly one bound parameter.
        assert_eq!(query.text_binds.len(), 4);
        for (index, bound) in query.text_binds.iter().enumerate() {
            let expected = if index < 2 {
                // The two LIKE patterns carry the leading and trailing wildcard.
                MAX_FILTER_PATTERN_LEN + 2
            } else {
                MAX_FILTER_PATTERN_LEN
            };
            assert_eq!(bound.chars().count(), expected);
        }

        // LIKE metacharacters are escaped, so `%` and `_` match literally.
        let escaped = CertificateFilter {
            common_name_contains: Some("100%_x".into()),
            ..CertificateFilter::default()
        }
        .to_query();
        assert_eq!(escaped.text_binds, vec![r"%100\%\_x%".to_string()]);
        assert_eq!(escaped.sql.matches("ESCAPE '\\'").count(), 1);
        assert_eq!(escaped.sql.matches('?').count(), 2);
    }

    #[tokio::test]
    async fn certmgr_escaped_wildcards_match_literally_not_everything() {
        let db = Db::connect_memory().await.unwrap();
        let (authority, ..) = seed_certmgr_org(&db, "org:one", "one").await;
        seed_certificate(&db, "org:one", &authority, "alpha").await;
        // Without an ESCAPE clause this pattern would match every row.
        let matched = db
            .list_certificates(
                "org:one",
                &CertificateFilter {
                    common_name_contains: Some("%".into()),
                    ..CertificateFilter::default()
                },
            )
            .await
            .unwrap();
        assert!(matched.is_empty());

        // A 100k-character subject is stored verbatim; only the pattern clamps.
        let long_cn = "x".repeat(100_000);
        db.insert_certificate_issuance_request(&certificate_request(
            "org:one",
            &authority,
            "request:long",
            "idem:long",
        ))
        .await
        .unwrap();
        let mut long =
            certmgr_managed_certificate("org:one", &authority, "request:long", "cert:long");
        long.common_name.clone_from(&long_cn);
        db.insert_managed_certificate(&long).await.unwrap();
        assert_eq!(
            db.get_certificate("org:one", "cert:long")
                .await
                .unwrap()
                .unwrap()
                .common_name
                .len(),
            100_000
        );
        assert_eq!(
            db.list_certificates(
                "org:one",
                &CertificateFilter {
                    common_name_contains: Some(long_cn),
                    ..CertificateFilter::default()
                },
            )
            .await
            .unwrap()
            .len(),
            1
        );
    }

    #[test]
    fn certmgr_filter_only_ever_emits_bind_placeholders() {
        let filter = CertificateFilter {
            status: Some("'; DROP TABLE issued_certificates; --".into()),
            common_name_contains: Some("100% _wild".into()),
            san_contains: Some("\\".into()),
            profile_id: Some("profile:one".into()),
            application_id: Some("app:one".into()),
            expiring_before: Some("2027-01-01T00:00:00+00:00".into()),
            metadata_key: Some("team".into()),
            metadata_value: Some("platform".into()),
            limit: Some(10_000),
        };
        let query = filter.to_query();
        assert_eq!(query.text_binds.len(), 8);
        assert_eq!(query.limit, Some(CERTIFICATE_LIST_MAX_LIMIT));
        assert!(!query.sql.contains("DROP TABLE"));
        for value in &query.text_binds {
            assert!(!query.sql.contains(value.as_str()));
        }
        // The only quoted literals in the statement are the two LIKE escapes.
        assert_eq!(query.sql.matches("ESCAPE '\\'").count(), 2);
        assert_eq!(query.sql.matches('\'').count(), 4);
        assert_eq!(query.sql.matches('?').count(), 10);
    }
}
