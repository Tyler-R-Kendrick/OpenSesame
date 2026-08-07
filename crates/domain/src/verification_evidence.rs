//! Verification evidence attached to ratchet transitions and proofs.

use crate::{
    canonicalize_json, digest_sha256, DomainError, ProtocolProfileId, TaskRunId,
    VerificationEvidenceId,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationEvidenceKind {
    DpopValidation,
    HttpSignatureValidation,
    IntentDigestMatch,
    StateVersionMatch,
    MediationAcknowledgement,
    ExternalPolicyDecision,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct VerificationEvidence {
    pub id: VerificationEvidenceId,
    pub kind: VerificationEvidenceKind,
    pub task_run_id: Option<TaskRunId>,
    pub protocol_profile_id: Option<ProtocolProfileId>,
    pub subject_digest: String,
    pub detail: serde_json::Value,
    pub recorded_at: DateTime<Utc>,
}

impl VerificationEvidence {
    pub fn digest(&self) -> Result<String, DomainError> {
        let v =
            serde_json::to_value(self).map_err(|e| DomainError::Canonicalization(e.to_string()))?;
        Ok(digest_sha256(&canonicalize_json(&v)?))
    }

    pub fn builder(kind: VerificationEvidenceKind) -> VerificationEvidenceBuilder {
        VerificationEvidenceBuilder {
            id: VerificationEvidenceId::new(),
            kind,
            task_run_id: None,
            protocol_profile_id: None,
            subject_digest: String::new(),
            detail: serde_json::Value::Null,
            recorded_at: Utc::now(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct VerificationEvidenceBuilder {
    id: VerificationEvidenceId,
    kind: VerificationEvidenceKind,
    task_run_id: Option<TaskRunId>,
    protocol_profile_id: Option<ProtocolProfileId>,
    subject_digest: String,
    detail: serde_json::Value,
    recorded_at: DateTime<Utc>,
}

impl VerificationEvidenceBuilder {
    pub fn task_run_id(mut self, id: TaskRunId) -> Self {
        self.task_run_id = Some(id);
        self
    }

    pub fn protocol_profile_id(mut self, id: ProtocolProfileId) -> Self {
        self.protocol_profile_id = Some(id);
        self
    }

    pub fn subject_digest(mut self, digest: impl Into<String>) -> Self {
        self.subject_digest = digest.into();
        self
    }

    pub fn detail(mut self, detail: serde_json::Value) -> Self {
        self.detail = detail;
        self
    }

    pub fn recorded_at(mut self, at: DateTime<Utc>) -> Self {
        self.recorded_at = at;
        self
    }

    pub fn build(self) -> VerificationEvidence {
        VerificationEvidence {
            id: self.id,
            kind: self.kind,
            task_run_id: self.task_run_id,
            protocol_profile_id: self.protocol_profile_id,
            subject_digest: self.subject_digest,
            detail: self.detail,
            recorded_at: self.recorded_at,
        }
    }
}
