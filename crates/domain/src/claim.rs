use crate::{
    ActorId, ActorInstanceId, ClaimSessionId, ClientId, OperatorId, OrganizationId, PrincipalId,
    ProjectId,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaimState {
    Pending,
    Claimed,
    Active,
    Expired,
    Revoked,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ClaimSession {
    pub id: ClaimSessionId,
    pub organization_hint: Option<OrganizationId>,
    pub project_hint: Option<ProjectId>,
    pub actor_id: ActorId,
    pub actor_instance_id: ActorInstanceId,
    pub client_id: Option<ClientId>,
    pub operator_id: Option<OperatorId>,
    pub instance_public_key_jwk: serde_json::Value,
    /// Memory-hard or keyed hash only — never the recoverable claim token.
    pub claim_token_hash: String,
    pub user_code_hash: Option<String>,
    pub claim_attempt_token_hash: Option<String>,
    pub provider_assertion_digest: Option<String>,
    pub attestation_digest: Option<String>,
    pub requested_grant_digest: String,
    pub state: ClaimState,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub claimed_at: Option<DateTime<Utc>>,
    pub claimed_by_principal_id: Option<PrincipalId>,
}
