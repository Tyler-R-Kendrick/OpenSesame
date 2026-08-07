//! Task-bound frozen intent (V2) with domain-separated digest.
//!
//! Legacy [`Intent`] (V1) remains for compatibility; callers must not treat V1
//! intents as fully task-secured without explicit migration.

use crate::{
    ActorId, ActorInstanceId, ClientId, ConnectionId, DomainError, Intent, IntentId,
    OperatorId, OrganizationId, PrincipalId, ProjectId, TaskRunId, canonicalize_json,
    digest_sha256,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const FROZEN_INTENT_V2_DOMAIN: &[u8] = b"OpenSesame/FrozenIntent/v2\0";
pub const FROZEN_INTENT_SCHEMA_VERSION: u32 = 2;

/// Compatibility profile marker for intents not yet bound to a task run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegacyIntentCompatibility {
    pub source_intent_id: IntentId,
    pub note: String,
    pub task_secured: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FrozenIntentV2 {
    pub schema_version: u32,
    pub id: IntentId,
    pub task_run_id: TaskRunId,
    pub task_state_version: u64,
    pub task_state_digest: String,
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
    pub canonical_arguments: Value,
    pub body_hash: Option<String>,
    pub nonce: String,
    pub idempotency_key: String,
    pub issued_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    /// Computed by [`FrozenIntentV2::compute_digest`]; never trusted from callers.
    #[serde(skip_deserializing, default = "default_uncomputed_digest")]
    pub intent_digest: String,
}

fn default_uncomputed_digest() -> String {
    String::new()
}

impl FrozenIntentV2 {
    pub fn canonical_bytes(&self) -> Result<Vec<u8>, DomainError> {
        let payload = FrozenIntentCanonicalPayload {
            schema_version: self.schema_version,
            id: self.id,
            task_run_id: self.task_run_id,
            task_state_version: self.task_state_version,
            task_state_digest: self.task_state_digest.clone(),
            organization_id: self.organization_id,
            project_id: self.project_id,
            principal_id: self.principal_id,
            actor_id: self.actor_id,
            actor_instance_id: self.actor_instance_id,
            client_id: self.client_id,
            operator_id: self.operator_id,
            connection_id: self.connection_id,
            operation: self.operation.clone(),
            resource: self.resource.clone(),
            audience: self.audience.clone(),
            canonical_arguments: self.canonical_arguments.clone(),
            body_hash: self.body_hash.clone(),
            nonce: self.nonce.clone(),
            idempotency_key: self.idempotency_key.clone(),
            issued_at: self.issued_at,
            expires_at: self.expires_at,
        };
        canonicalize_json(
            &serde_json::to_value(payload)
                .map_err(|e| DomainError::Canonicalization(e.to_string()))?,
        )
    }

    /// Domain-separated digest: `OpenSesame/FrozenIntent/v2\0 || canonical bytes`.
    pub fn compute_digest(&self) -> Result<String, DomainError> {
        let mut buf = Vec::with_capacity(FROZEN_INTENT_V2_DOMAIN.len() + 256);
        buf.extend_from_slice(FROZEN_INTENT_V2_DOMAIN);
        buf.extend_from_slice(&self.canonical_bytes()?);
        Ok(digest_sha256(&buf))
    }

    /// Returns a copy with `intent_digest` populated from computation.
    pub fn with_computed_digest(mut self) -> Result<Self, DomainError> {
        self.intent_digest = self.compute_digest()?;
        Ok(self)
    }

    pub fn assert_fresh(&self, now: DateTime<Utc>) -> Result<(), DomainError> {
        if now >= self.expires_at || now < self.issued_at {
            return Err(DomainError::GrantTimeWindow);
        }
        Ok(())
    }

    pub fn assert_digest(&self) -> Result<(), DomainError> {
        let computed = self.compute_digest()?;
        if self.intent_digest.is_empty() {
            return Err(DomainError::FrozenIntentDigestUntrusted);
        }
        if self.intent_digest != computed {
            return Err(DomainError::FrozenIntentDigestMismatch);
        }
        Ok(())
    }
}

#[derive(Serialize)]
struct FrozenIntentCanonicalPayload {
    schema_version: u32,
    id: IntentId,
    task_run_id: TaskRunId,
    task_state_version: u64,
    task_state_digest: String,
    organization_id: OrganizationId,
    project_id: Option<ProjectId>,
    principal_id: PrincipalId,
    actor_id: ActorId,
    actor_instance_id: Option<ActorInstanceId>,
    client_id: Option<ClientId>,
    operator_id: Option<OperatorId>,
    connection_id: Option<ConnectionId>,
    operation: String,
    resource: String,
    audience: String,
    canonical_arguments: Value,
    body_hash: Option<String>,
    nonce: String,
    idempotency_key: String,
    issued_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
}

impl Intent {
    /// Documents that legacy V1 intents are not task-secured.
    pub fn compatibility_notes(&self) -> LegacyIntentCompatibility {
        LegacyIntentCompatibility {
            source_intent_id: self.id,
            note: "V1 Intent lacks task_run binding; migrate to FrozenIntentV2 for task-scoped authority".into(),
            task_secured: false,
        }
    }
}

impl FrozenIntentV2 {
    /// Explicit migration from legacy Intent — does NOT silently upgrade security posture.
    pub fn from_legacy(
        legacy: &Intent,
        task_run_id: TaskRunId,
        task_state_version: u64,
        task_state_digest: String,
        canonical_arguments: Value,
    ) -> Result<Self, DomainError> {
        if legacy.compatibility_notes().task_secured {
            return Err(DomainError::FrozenIntentMigrationDenied(
                "legacy intent already marked task-secured".into(),
            ));
        }
        let mut frozen = Self {
            schema_version: FROZEN_INTENT_SCHEMA_VERSION,
            id: legacy.id,
            task_run_id,
            task_state_version,
            task_state_digest,
            organization_id: legacy.organization_id,
            project_id: legacy.project_id,
            principal_id: legacy.principal_id,
            actor_id: legacy.actor_id,
            actor_instance_id: legacy.actor_instance_id,
            client_id: legacy.client_id,
            operator_id: legacy.operator_id,
            connection_id: legacy.connection_id,
            operation: legacy.operation.clone(),
            resource: legacy.resource.clone(),
            audience: legacy.audience.clone(),
            canonical_arguments,
            body_hash: legacy.body_hash.clone(),
            nonce: legacy.nonce.clone(),
            idempotency_key: legacy.idempotency_key.clone(),
            issued_at: legacy.issued_at,
            expires_at: legacy.expires_at,
            intent_digest: String::new(),
        };
        frozen.intent_digest = frozen.compute_digest()?;
        Ok(frozen)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DetachedProof;

    fn sample_legacy() -> Intent {
        let now = Utc::now();
        Intent {
            id: IntentId::new(),
            organization_id: OrganizationId::new(),
            project_id: None,
            principal_id: PrincipalId::new(),
            actor_id: ActorId::new(),
            actor_instance_id: None,
            client_id: None,
            operator_id: None,
            connection_id: None,
            operation: "repository.read".into(),
            resource: "repo:acme/x".into(),
            audience: "https://api.example".into(),
            normalized_parameters_hash: "sha256:abc".into(),
            body_hash: None,
            nonce: "n".into(),
            idempotency_key: "ik".into(),
            issued_at: now,
            expires_at: now + chrono::Duration::hours(1),
            parent_invocation_id: None,
            delegation_chain: vec![],
            proof: DetachedProof {
                algorithm: "EdDSA".into(),
                key_thumbprint: "thumb".into(),
                signature: "sig".into(),
            },
        }
    }

    #[test]
    fn legacy_not_task_secured() {
        let intent = sample_legacy();
        assert!(!intent.compatibility_notes().task_secured);
    }

    #[test]
    fn digest_domain_separated_and_stable() {
        let legacy = sample_legacy();
        let frozen = FrozenIntentV2::from_legacy(
            &legacy,
            TaskRunId::new(),
            1,
            "state-digest".into(),
            serde_json::json!({"branch": "main"}),
        )
        .unwrap();
        let d1 = frozen.compute_digest().unwrap();
        let d2 = frozen.compute_digest().unwrap();
        assert_eq!(d1, d2);
        assert!(d1.starts_with("sha256:"));
        assert_ne!(legacy.digest().unwrap(), d1);
    }

    #[test]
    fn rejects_untrusted_digest() {
        let legacy = sample_legacy();
        let mut frozen = FrozenIntentV2::from_legacy(
            &legacy,
            TaskRunId::new(),
            1,
            "state-digest".into(),
            serde_json::json!({}),
        )
        .unwrap();
        frozen.intent_digest = "sha256:deadbeef".into();
        assert!(frozen.assert_digest().is_err());
    }

    #[test]
    fn migration_populates_digest() {
        let legacy = sample_legacy();
        let frozen = FrozenIntentV2::from_legacy(
            &legacy,
            TaskRunId::new(),
            1,
            "state-digest".into(),
            serde_json::json!({}),
        )
        .unwrap();
        assert!(!frozen.intent_digest.is_empty());
        assert!(frozen.assert_digest().is_ok());
    }
}
