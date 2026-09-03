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
    (
        "0019_shared_sessions",
        include_str!("../../../migrations/0019_shared_sessions.sql"),
    ),
    (
        "0020_security_events",
        include_str!("../../../migrations/0020_security_events.sql"),
    ),
    (
        "0021_web_login_observation",
        include_str!("../../../migrations/0021_web_login_observation.sql"),
    ),
    (
        "0022_rotation_policy_owner",
        include_str!("../../../migrations/0022_rotation_policy_owner.sql"),
    ),
    (
        "0023_a2h_delivery_and_web_login_watermarks",
        include_str!("../../../migrations/0023_a2h_delivery_and_web_login_watermarks.sql"),
    ),
    (
        "0024_session_grant_watermarks",
        include_str!("../../../migrations/0024_session_grant_watermarks.sql"),
    ),
    (
        "0025_runner_steps",
        include_str!("../../../migrations/0025_runner_steps.sql"),
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

mod shared_sessions;
pub use shared_sessions::StoredSession;

mod security;
pub use security::{
    StoredBreachFinding, StoredLifecycleWatermark, StoredSecurityDelivery, StoredSecurityHook,
    BREACH_FINDING_CLEARED, BREACH_FINDING_OPEN, DELIVERY_BATCH_LIMIT, SECURITY_HOOK_SECRET_SCOPE,
};

mod observation;

mod runner_steps;

/// Shared across the split `impl Db` modules, so it stays at the crate root:
/// a private method is visible to descendant modules but not to sibling ones,
/// and seven of them insert rows that need the organization to exist first.
impl Db {
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
}
// The `impl Db` block was split by responsibility; see each module's header.
mod acme;
mod approval_policies;
mod approval_requests;
mod cert_alerts;
mod cert_authorities;
mod cert_inventory;
mod cert_issuance;
mod cert_policy;
mod connections;
mod discovery;
mod enrollment;
mod est_scep;
mod external_ca;
mod grants;
mod host_kv;
mod invocations;
mod outbox;
mod revocation;
mod signing;
mod signing_access;
mod sync;
mod tenancy;
mod vault_backup;
pub use runner_steps::{StoredRunnerStep, STEP_CLAIM_SECONDS};

pub use observation::{
    ObservationAppend, ObservationControlUpdate, StoredObservationEvent, StoredObservationRun,
    MAX_BLOCKED_REASON_CHARS, OBSERVATION_READ_LIMIT,
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
mod tests;
