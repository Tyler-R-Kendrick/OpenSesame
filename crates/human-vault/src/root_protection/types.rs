//! Native root-protection manifest types (C03). Metadata only.

use serde::{Deserialize, Serialize};

use crate::password_wrap::PasswordWrapper;

use super::limits::MANIFEST_SCHEMA_VERSION;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProtectionPurpose {
    HumanVaultRoot,
    WorkloadRoot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProofStatus {
    Verified,
    Untested,
    Stale,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationEvidence {
    pub kind: String,
    pub implementation_version: String,
    pub tested_at: String,
    pub evidence_ref: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ProtectionRecord {
    #[serde(rename = "password")]
    Password {
        #[serde(rename = "protectorId")]
        protector_id: String,
        legacy: bool,
        wrapper: PasswordWrapper,
        #[serde(rename = "proofStatus")]
        proof_status: ProofStatus,
        #[serde(rename = "lastEvidence", default, skip_serializing_if = "Option::is_none")]
        last_evidence: Option<VerificationEvidence>,
    },
    #[serde(rename = "age-recipient")]
    AgeRecipient {
        #[serde(rename = "protectorId")]
        protector_id: String,
        recipients: Vec<String>,
        #[serde(rename = "capsuleAgeB64")]
        capsule_age_b64: String,
        #[serde(rename = "proofStatus")]
        proof_status: ProofStatus,
        #[serde(rename = "lastEvidence", default, skip_serializing_if = "Option::is_none")]
        last_evidence: Option<VerificationEvidence>,
    },
    #[serde(rename = "yubikey-piv-age")]
    YubikeyPivAge {
        #[serde(rename = "protectorId")]
        protector_id: String,
        recipient: String,
        #[serde(rename = "serialHint", default, skip_serializing_if = "Option::is_none")]
        serial_hint: Option<String>,
        #[serde(rename = "capsuleAgeB64")]
        capsule_age_b64: String,
        #[serde(rename = "proofStatus")]
        proof_status: ProofStatus,
        #[serde(rename = "lastEvidence", default, skip_serializing_if = "Option::is_none")]
        last_evidence: Option<VerificationEvidence>,
    },
    #[serde(rename = "recovery-key")]
    RecoveryKey {
        #[serde(rename = "protectorId")]
        protector_id: String,
        wrap: RecoveryWrap,
        #[serde(rename = "fingerprintB64")]
        fingerprint_b64: String,
        #[serde(rename = "proofStatus")]
        proof_status: ProofStatus,
        #[serde(rename = "lastEvidence", default, skip_serializing_if = "Option::is_none")]
        last_evidence: Option<VerificationEvidence>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryWrap {
    pub nonce_b64: String,
    pub ct_b64: String,
}

impl ProtectionRecord {
    #[must_use]
    pub fn protector_id(&self) -> &str {
        match self {
            Self::Password { protector_id, .. }
            | Self::AgeRecipient { protector_id, .. }
            | Self::YubikeyPivAge { protector_id, .. }
            | Self::RecoveryKey { protector_id, .. } => protector_id,
        }
    }

    #[must_use]
    pub fn kind_name(&self) -> &'static str {
        match self {
            Self::Password { .. } => "password",
            Self::AgeRecipient { .. } => "age-recipient",
            Self::YubikeyPivAge { .. } => "yubikey-piv-age",
            Self::RecoveryKey { .. } => "recovery-key",
        }
    }

    #[must_use]
    pub fn proof_status(&self) -> ProofStatus {
        match self {
            Self::Password { proof_status, .. }
            | Self::AgeRecipient { proof_status, .. }
            | Self::YubikeyPivAge { proof_status, .. }
            | Self::RecoveryKey { proof_status, .. } => *proof_status,
        }
    }
}

/// Four independent enrollment flags, spelled as the manifest spells them;
/// an enum set would change the wire format the Pages client writes.
#[allow(clippy::struct_excessive_bools)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticatedLegacyGates {
    pub totp_enrolled: bool,
    pub email_enrolled: bool,
    pub sms_enrolled: bool,
    pub recovery_codes_enrolled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootProtectionManifest {
    pub schema_version: u32,
    pub vault_id: String,
    pub root_key_id: String,
    pub root_epoch: u64,
    pub revision: u64,
    pub purpose: ProtectionPurpose,
    pub records: Vec<ProtectionRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_protector_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legacy_gates: Option<AuthenticatedLegacyGates>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_b64: Option<String>,
}

impl RootProtectionManifest {
    #[must_use]
    pub fn new_empty(vault_id: String, root_key_id: String) -> Self {
        Self {
            schema_version: MANIFEST_SCHEMA_VERSION,
            vault_id,
            root_key_id,
            root_epoch: 1,
            revision: 1,
            purpose: ProtectionPurpose::HumanVaultRoot,
            records: Vec::new(),
            preferred_protector_id: None,
            legacy_gates: None,
            auth_b64: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtectorSummary {
    pub protector_id: String,
    pub kind: String,
    pub proof_status: ProofStatus,
}
