//! Proof keys, purposes, and bindings for task-scoped authorization.

use crate::{DomainError, ProofKeyId, TaskRunId};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProofKeyOwnerKind {
    Principal,
    Actor,
    TaskRun,
    MediationPoint,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProofPurpose {
    /// DPoP or HTTP message signature at the resource.
    ResourceAccess,
    /// Intent or frozen-intent attestation.
    IntentAttestation,
    /// Mediation / enforcement acknowledgement.
    MediationAcknowledgement,
    /// Token exchange or delegation proof.
    Delegation,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProofKey {
    pub id: ProofKeyId,
    pub owner_kind: ProofKeyOwnerKind,
    pub owner_ref: String,
    pub algorithm: String,
    pub public_key_jwk_thumbprint: String,
    pub created_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
}

impl ProofKey {
    pub fn assert_active(&self, now: DateTime<Utc>) -> Result<(), DomainError> {
        if let Some(revoked) = self.revoked_at {
            if now >= revoked {
                return Err(DomainError::ProofKeyRevoked);
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProofMechanism {
    Dpop,
    HttpMessageSignature,
    JwtBearer,
    MacKey,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProofBinding {
    pub mechanism: ProofMechanism,
    pub proof_key_id: ProofKeyId,
    pub task_run_id: Option<TaskRunId>,
    pub intent_digest: Option<String>,
    pub state_version: Option<u64>,
    pub state_digest: Option<String>,
    pub covered_components: Vec<String>,
    pub issued_at: DateTime<Utc>,
}

impl ProofBinding {
    pub fn assert_task_bound(&self, task_run_id: TaskRunId) -> Result<(), DomainError> {
        match self.task_run_id {
            Some(id) if id == task_run_id => Ok(()),
            Some(_) => Err(DomainError::ProofBindingMismatch(
                "task_run_id mismatch".into(),
            )),
            None => Err(DomainError::ProofBindingMismatch(
                "proof not task-bound".into(),
            )),
        }
    }
}
