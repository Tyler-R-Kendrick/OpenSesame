use crate::{DomainError, IntentId, InvocationId};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InvocationState {
    Received,
    Authorizing,
    AwaitingApproval,
    Authorized,
    Leased,
    Executing,
    Succeeded,
    Failed,
    Denied,
    Cancelled,
    Expired,
}

impl InvocationState {
    pub fn can_transition(self, to: Self) -> bool {
        use InvocationState::*;
        matches!(
            (self, to),
            (Received, Authorizing)
                | (Authorizing, AwaitingApproval)
                | (Authorizing, Authorized)
                | (Authorizing, Denied)
                | (AwaitingApproval, Authorized)
                | (AwaitingApproval, Denied)
                | (AwaitingApproval, Cancelled)
                | (Authorized, Leased)
                | (Authorized, Cancelled)
                | (Leased, Executing)
                | (Leased, Authorized) // lease expiry return
                | (Executing, Succeeded)
                | (Executing, Failed)
                | (Executing, Cancelled)
                | (Received, Expired)
                | (Authorizing, Expired)
                | (AwaitingApproval, Expired)
                | (Authorized, Expired)
                | (Leased, Expired)
        )
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Invocation {
    pub id: InvocationId,
    pub intent_id: IntentId,
    pub state: InvocationState,
    pub attempt: u32,
    pub lease_owner: Option<String>,
    pub lease_expires_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Invocation {
    pub fn transition(&mut self, to: InvocationState, now: DateTime<Utc>) -> Result<(), DomainError> {
        if !self.state.can_transition(to) {
            return Err(DomainError::InvalidTransition {
                from: format!("{:?}", self.state),
                to: format!("{to:?}"),
            });
        }
        self.state = to;
        self.updated_at = now;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn happy_path_transitions() {
        assert!(InvocationState::Received.can_transition(InvocationState::Authorizing));
        assert!(InvocationState::Executing.can_transition(InvocationState::Succeeded));
        assert!(!InvocationState::Succeeded.can_transition(InvocationState::Executing));
    }
}
