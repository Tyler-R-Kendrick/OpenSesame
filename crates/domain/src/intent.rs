use crate::{
    canonicalize_json, digest_sha256, ActorId, ActorInstanceId, ClientId, ConnectionId,
    DomainError, GrantId, IntentId, InvocationId, OperatorId, OrganizationId, PrincipalId,
    ProjectId,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DetachedProof {
    pub algorithm: String,
    pub key_thumbprint: String,
    pub signature: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Intent {
    pub id: IntentId,
    pub organization_id: OrganizationId,
    pub project_id: Option<ProjectId>,
    pub principal_id: PrincipalId,
    pub actor_id: ActorId,
    pub actor_instance_id: Option<ActorInstanceId>,
    pub client_id: Option<ClientId>,
    pub operator_id: Option<OperatorId>,
    pub connection_id: Option<ConnectionId>,
    pub operation: String,
    pub resource: String,
    pub audience: String,
    pub normalized_parameters_hash: String,
    pub body_hash: Option<String>,
    pub nonce: String,
    pub idempotency_key: String,
    pub issued_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub parent_invocation_id: Option<InvocationId>,
    pub delegation_chain: Vec<GrantId>,
    pub proof: DetachedProof,
}

impl Intent {
    pub fn parameters_hash(parameters: &Value) -> Result<String, DomainError> {
        let bytes = canonicalize_json(parameters)?;
        Ok(digest_sha256(&bytes))
    }

    pub fn assert_fresh(&self, now: DateTime<Utc>) -> Result<(), DomainError> {
        if now >= self.expires_at || now < self.issued_at {
            return Err(DomainError::GrantTimeWindow);
        }
        Ok(())
    }

    pub fn digest(&self) -> Result<String, DomainError> {
        let v =
            serde_json::to_value(self).map_err(|e| DomainError::Canonicalization(e.to_string()))?;
        crate::digest_json(&v)
    }
}
