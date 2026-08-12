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
    /// Whether this acknowledgement is about the transition it is offered for.
    /// Which mediation point it speaks for is not checked here: only the set of
    /// required points knows whether that one was asked for.
    pub fn assert_matches_transition(
        &self,
        task_run_id: TaskRunId,
        state_version: u64,
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
        Ok(())
    }
}

/// One required mediation point, and the acknowledgement that settled it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReceivedAcknowledgement {
    pub mediation_point_id: MediationPointId,
    pub acknowledgement_id: EnforcementAcknowledgementId,
}

/// Tracks pending acknowledgements for a capability transition. Which point each
/// acknowledgement settled is recorded, not merely how many arrived: counting
/// would let one mediator answer twice and stand in for a silent one.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AcknowledgementSet {
    pub required: Vec<MediationPointId>,
    pub received: Vec<ReceivedAcknowledgement>,
}

impl AcknowledgementSet {
    /// Record an acknowledgement against the point it names. Refuses a point
    /// this transition never asked for, and ignores a repeat of one already
    /// settled so a retry is harmless.
    pub fn accept(&mut self, ack: &EnforcementAcknowledgement) -> Result<(), DomainError> {
        if !self.required.contains(&ack.mediation_point_id) {
            return Err(DomainError::MediationAckMismatch(
                "mediation_point_id is not required by this transition".into(),
            ));
        }
        if self.satisfied(ack.mediation_point_id) {
            return Ok(());
        }
        self.received.push(ReceivedAcknowledgement {
            mediation_point_id: ack.mediation_point_id,
            acknowledgement_id: ack.id,
        });
        Ok(())
    }

    pub fn satisfied(&self, point: MediationPointId) -> bool {
        self.received.iter().any(|r| r.mediation_point_id == point)
    }

    /// Points still to answer. Empty is the only way a transition may commit.
    pub fn outstanding(&self) -> Vec<MediationPointId> {
        self.required
            .iter()
            .copied()
            .filter(|point| !self.satisfied(*point))
            .collect()
    }

    pub fn is_complete(&self) -> bool {
        self.outstanding().is_empty()
    }

    pub fn assert_complete(&self) -> Result<(), DomainError> {
        if self.is_complete() {
            Ok(())
        } else {
            Err(DomainError::MediationAckIncomplete)
        }
    }
}
