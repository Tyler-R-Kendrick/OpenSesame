use chrono::{DateTime, Utc};
use opensesame_domain::{TaskCredentialId, TaskRunId};
use serde::{Deserialize, Serialize};

/// Stored credential metadata — digest only, never raw secret material.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskCredentialRecord {
    pub id: TaskCredentialId,
    pub task_run_id: TaskRunId,
    pub credential_digest: String,
    pub state_version: u64,
    pub issued_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

/// Buffered protected operation result held until mediation acks complete.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProtectedResultBuffer {
    pub task_run_id: TaskRunId,
    pub transition_id: String,
    pub state_version: u64,
    pub result_digest: String,
    pub payload: serde_json::Value,
    pub created_at: DateTime<Utc>,
    pub released: bool,
}

impl ProtectedResultBuffer {
    pub fn is_held(&self) -> bool {
        !self.released
    }
}
