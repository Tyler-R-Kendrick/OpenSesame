use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(kani, derive(kani::Arbitrary))]
#[serde(rename_all = "snake_case")]
pub enum RotationState {
    Scheduled,
    Discovering,
    CandidateGenerated,
    CandidateInstalled,
    CandidateVerified,
    CandidateActivated,
    DependentsUpdated,
    Observing,
    PreviousRevoked,
    RevocationVerified,
    Completed,
    RollbackStarted,
    RollbackCompleted,
    RollbackFailed,
    ReconciliationRequired,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum RotationError {
    #[error("invalid transition")]
    InvalidTransition,
    #[error("unknown provider outcome — reconcile before retry")]
    Indeterminate,
}

impl RotationState {
    #[must_use]
    pub fn can_transition(self, to: Self) -> bool {
        use RotationState::{
            CandidateActivated, CandidateGenerated, CandidateInstalled, CandidateVerified,
            Completed, DependentsUpdated, Discovering, Observing, PreviousRevoked,
            ReconciliationRequired, RevocationVerified, RollbackCompleted, RollbackFailed,
            RollbackStarted, Scheduled,
        };
        matches!(
            (self, to),
            (Scheduled, Discovering)
                | (Discovering, CandidateGenerated)
                | (CandidateGenerated, CandidateInstalled)
                | (
                    CandidateInstalled,
                    CandidateVerified | RollbackStarted | ReconciliationRequired
                )
                | (CandidateVerified, CandidateActivated | RollbackStarted)
                | (
                    CandidateActivated,
                    DependentsUpdated | RollbackStarted | ReconciliationRequired
                )
                | (DependentsUpdated, Observing | RollbackStarted)
                | (Observing, PreviousRevoked | RollbackStarted)
                | (PreviousRevoked, RevocationVerified | ReconciliationRequired)
                | (RevocationVerified, Completed)
                | (RollbackStarted, RollbackCompleted | RollbackFailed)
        )
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn transition(self, to: Self) -> Result<Self, RotationError> {
        if self.can_transition(to) {
            Ok(to)
        } else {
            Err(RotationError::InvalidTransition)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn verify_before_revoke_path() {
        let mut s = RotationState::Scheduled;
        for next in [
            RotationState::Discovering,
            RotationState::CandidateGenerated,
            RotationState::CandidateInstalled,
            RotationState::CandidateVerified,
            RotationState::CandidateActivated,
            RotationState::DependentsUpdated,
            RotationState::Observing,
            RotationState::PreviousRevoked,
            RotationState::RevocationVerified,
            RotationState::Completed,
        ] {
            s = s.transition(next).unwrap();
        }
        assert_eq!(s, RotationState::Completed);
    }

    #[test]
    fn cannot_revoke_before_verify() {
        assert!(!RotationState::CandidateInstalled.can_transition(RotationState::PreviousRevoked));
        assert!(!RotationState::CandidateGenerated.can_transition(RotationState::PreviousRevoked));
    }

    #[test]
    fn rollback_paths() {
        for from in [
            RotationState::CandidateInstalled,
            RotationState::CandidateVerified,
            RotationState::CandidateActivated,
            RotationState::DependentsUpdated,
            RotationState::Observing,
        ] {
            assert!(from.can_transition(RotationState::RollbackStarted));
        }
        assert!(RotationState::RollbackStarted.can_transition(RotationState::RollbackCompleted));
        assert!(RotationState::RollbackStarted.can_transition(RotationState::RollbackFailed));
    }

    #[test]
    fn indeterminate_requires_reconcile() {
        assert!(
            RotationState::CandidateInstalled.can_transition(RotationState::ReconciliationRequired)
        );
        assert!(
            RotationState::CandidateActivated.can_transition(RotationState::ReconciliationRequired)
        );
        assert!(!RotationState::Completed.can_transition(RotationState::Scheduled));
    }

    #[test]
    fn illegal_skip_to_completed() {
        assert_eq!(
            RotationState::Scheduled.transition(RotationState::Completed),
            Err(RotationError::InvalidTransition)
        );
    }
}

#[cfg(kani)]
mod kani_proofs {
    use super::*;

    #[kani::proof]
    fn completed_is_a_sink() {
        let from = RotationState::Completed;
        for to in [
            RotationState::Scheduled,
            RotationState::Discovering,
            RotationState::PreviousRevoked,
            RotationState::RollbackStarted,
            RotationState::Completed,
        ] {
            assert!(!from.can_transition(to));
        }
    }

    #[kani::proof]
    fn cannot_revoke_before_observe() {
        assert!(!RotationState::CandidateInstalled.can_transition(RotationState::PreviousRevoked));
        assert!(!RotationState::CandidateGenerated.can_transition(RotationState::PreviousRevoked));
    }

    #[kani::proof]
    fn transition_matches_can_transition() {
        let from: RotationState = kani::any();
        let to: RotationState = kani::any();
        match from.transition(to) {
            Ok(next) => {
                assert!(from.can_transition(to));
                assert_eq!(next, to);
            }
            Err(RotationError::InvalidTransition) => assert!(!from.can_transition(to)),
            Err(RotationError::Indeterminate) => {}
        }
    }
}
