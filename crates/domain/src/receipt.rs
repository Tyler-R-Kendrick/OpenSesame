use crate::{
    ActorId, ActorInstanceId, ApprovalId, ClientId, ConnectionId, CredentialHandleId, GrantId,
    InvocationId, OperatorId, OrganizationId, PrincipalId, ReceiptId, TaskRunId,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReceiptOutcome {
    Succeeded,
    Failed,
    Denied,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InvocationReceipt {
    pub id: ReceiptId,
    pub invocation_id: InvocationId,
    pub intent_digest: String,
    pub principal_id: PrincipalId,
    /// Organization whose authority produced this receipt. Legacy schema 1/2
    /// receipts omit it; storage resolves those through the invocation intent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organization_id: Option<OrganizationId>,
    pub actor_id: ActorId,
    pub actor_instance_id: Option<ActorInstanceId>,
    pub client_id: Option<ClientId>,
    pub operator_id: Option<OperatorId>,
    pub delegation_chain: Vec<GrantId>,
    pub connection_id: Option<ConnectionId>,
    pub operation: String,
    pub resource: String,
    pub policy_decision_id: String,
    pub policy_version_digest: String,
    pub approval_id: Option<ApprovalId>,
    pub credential_handle_id: Option<CredentialHandleId>,
    pub connector_component_digest: Option<String>,
    pub external_request_digest: Option<String>,
    pub external_response_digest: Option<String>,
    pub started_at: DateTime<Utc>,
    pub completed_at: DateTime<Utc>,
    pub outcome: ReceiptOutcome,
    pub safe_result_summary: Option<serde_json::Value>,
    pub authority_key_id: String,
    pub signature: String,
    /// Schema 1 = legacy; schema 2 adds task binding; schema 3 adds organization binding.
    #[serde(default = "default_receipt_schema_version")]
    pub receipt_schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_run_id: Option<TaskRunId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_state_version: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_state_digest: Option<String>,
}

fn default_receipt_schema_version() -> u32 {
    1
}

impl InvocationReceipt {
    /// Ensure no obvious secret-bearing keys appear in the safe summary.
    pub fn assert_no_secret_leak(&self) -> bool {
        let Some(summary) = &self.safe_result_summary else {
            return true;
        };
        let s = summary.to_string().to_lowercase();
        let banned = [
            "refresh_token",
            "access_token",
            "password",
            "private_key",
            "authorization_code",
            "device_code",
            "claim_token",
            "client_secret",
        ];
        !banned.iter().any(|b| s.contains(b))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_secret_keys_in_summary() {
        let mut r = InvocationReceipt {
            id: ReceiptId::new(),
            invocation_id: InvocationId::new(),
            intent_digest: "sha256:abc".into(),
            principal_id: PrincipalId::new(),
            organization_id: None,
            actor_id: ActorId::new(),
            actor_instance_id: None,
            client_id: None,
            operator_id: None,
            delegation_chain: vec![],
            connection_id: None,
            operation: "x".into(),
            resource: "y".into(),
            policy_decision_id: "d".into(),
            policy_version_digest: "p".into(),
            approval_id: None,
            credential_handle_id: None,
            connector_component_digest: None,
            external_request_digest: None,
            external_response_digest: None,
            started_at: Utc::now(),
            completed_at: Utc::now(),
            outcome: ReceiptOutcome::Succeeded,
            safe_result_summary: Some(serde_json::json!({"access_token": "nope"})),
            authority_key_id: "k".into(),
            signature: "s".into(),
            receipt_schema_version: 1,
            task_run_id: None,
            task_state_version: None,
            task_state_digest: None,
        };
        assert!(!r.assert_no_secret_leak());
        r.safe_result_summary = Some(serde_json::json!({"pr_number": 12}));
        assert!(r.assert_no_secret_leak());
    }
}
