//! Mediation points and enforcement acknowledgements.

use crate::{
    DomainError, EnforcementAcknowledgementId, MediationPointId, ProofBinding, TaskRunId,
    VerificationEvidenceId,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MediationKind {
    /// Broker holds result until ack.
    ResultBuffer,
    /// Credential agent fences in-flight requests.
    RequestFence,
    /// Audit plane records ratchet commit.
    AuditWitness,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MediationPoint {
    pub id: MediationPointId,
    pub kind: MediationKind,
    pub logical_name: String,
    pub required: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EnforcementAcknowledgement {
    pub id: EnforcementAcknowledgementId,
    pub mediation_point_id: MediationPointId,
    pub task_run_id: TaskRunId,
    pub transition_id: String,
    pub state_version: u64,
    pub evidence_id: VerificationEvidenceId,
    pub proof: Option<ProofBinding>,
    pub acknowledged_at: DateTime<Utc>,
}

impl EnforcementAcknowledgement {
    pub fn assert_matches_transition(
        &self,
        task_run_id: TaskRunId,
        state_version: u64,
        mediation_point_id: MediationPointId,
    ) -> Result<(), DomainError> {
        if self.task_run_id != task_run_id {
            return Err(DomainError::MediationAckMismatch(
                "task_run_id mismatch".into(),
            ));
        }
        if self.state_version != state_version {
            return Err(DomainError::MediationAckMismatch(
                "state_version mismatch".into(),
            ));
        }
        if self.mediation_point_id != mediation_point_id {
            return Err(DomainError::MediationAckMismatch(
                "mediation_point_id mismatch".into(),
            ));
        }
        Ok(())
    }
}

/// Tracks pending acknowledgements for a capability transition.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AcknowledgementSet {
    pub required: Vec<MediationPointId>,
    pub received: Vec<EnforcementAcknowledgementId>,
}

impl AcknowledgementSet {
    pub fn is_complete(&self) -> bool {
        self.required.len() == self.received.len()
    }

    pub fn assert_complete(&self) -> Result<(), DomainError> {
        if self.is_complete() {
            Ok(())
        } else {
            Err(DomainError::MediationAckIncomplete)
        }
    }
}
