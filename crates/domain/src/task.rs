//! Task template, run lifecycle, and trust-ratchet transitions.
//!
//! There is no widen operation — capability sets may only shrink monotonically.

use crate::{
    AuthorityContextId, CapabilitySet, CapabilityStateTransitionId, DomainError, OrganizationId,
    PrincipalId, ProjectId, TaskRunId, TaskTemplateId,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TaskTemplate {
    pub id: TaskTemplateId,
    pub organization_id: OrganizationId,
    pub project_id: Option<ProjectId>,
    pub name: String,
    pub description: Option<String>,
    pub initial_ceiling: CapabilitySet,
    pub ratchet_rules: Vec<RatchetRule>,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskRunStatus {
    Pending,
    Active,
    Restricting,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TaskRun {
    pub id: TaskRunId,
    pub template_id: TaskTemplateId,
    pub organization_id: OrganizationId,
    pub project_id: Option<ProjectId>,
    pub principal_id: PrincipalId,
    pub authority_context_id: AuthorityContextId,
    pub status: TaskRunStatus,
    pub capability_ceiling: CapabilitySet,
    pub current_capabilities: CapabilitySet,
    pub state_version: u64,
    pub state_digest: String,
    pub maximum_expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CeilingInput {
    pub principal_id: PrincipalId,
    pub capabilities: CapabilitySet,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CeilingCompilation {
    pub inputs: Vec<CeilingInput>,
    pub compiled_ceiling: CapabilitySet,
    pub ceiling_digest: String,
    pub compiled_at: DateTime<Utc>,
}

impl CeilingCompilation {
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn compile(inputs: Vec<CeilingInput>, now: DateTime<Utc>) -> Result<Self, DomainError> {
        if inputs.is_empty() {
            return Err(DomainError::TaskCeilingEmpty);
        }
        let mut acc = inputs[0].capabilities.clone().canonicalize();
        for input in inputs.iter().skip(1) {
            acc = acc.intersection(&input.capabilities);
        }
        let compiled = acc.canonicalize();
        Ok(Self {
            inputs,
            compiled_ceiling: compiled.clone(),
            ceiling_digest: compiled.digest()?,
            compiled_at: now,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RatchetRule {
    /// Removing a selector requires mediation acknowledgement.
    RestrictRequiresAck { mediation_point_id: String },
    /// Credential renewal may not exceed `maximum_expires_at`.
    CredentialRenewalBounded,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityTransitionStatus {
    Proposed,
    Fencing,
    AwaitingAcknowledgements,
    Committed,
    Rejected,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CapabilityStateTransition {
    pub id: CapabilityStateTransitionId,
    pub task_run_id: TaskRunId,
    pub from_state_version: u64,
    pub to_state_version: u64,
    pub status: CapabilityTransitionStatus,
    pub removed: CapabilitySet,
    pub resulting_capabilities: CapabilitySet,
    pub trigger_evidence_digest: Option<String>,
    pub created_at: DateTime<Utc>,
    pub committed_at: Option<DateTime<Utc>>,
}

impl TaskRun {
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn compute_state_digest(&self) -> Result<String, DomainError> {
        let snapshot = serde_json::json!({
            "task_run_id": self.id,
            "state_version": self.state_version,
            "current_capabilities": self.current_capabilities.canonicalize(),
            "capability_ceiling": self.capability_ceiling.canonicalize(),
            "status": self.status,
        });
        crate::digest_json(&snapshot)
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn assert_active(&self) -> Result<(), DomainError> {
        if self.status != TaskRunStatus::Active && self.status != TaskRunStatus::Restricting {
            return Err(DomainError::TaskNotActive);
        }
        Ok(())
    }

    /// Task authority is time-boxed: `maximum_expires_at` is a hard ceiling on
    /// every capability assertion, not merely on credential renewal.
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn assert_not_expired(&self, now: DateTime<Utc>) -> Result<(), DomainError> {
        if now > self.maximum_expires_at {
            return Err(DomainError::TaskExpired);
        }
        Ok(())
    }

    /// Fail closed: proposed capabilities must be subset of current (no widen).
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn validate_restriction(&self, proposed: &CapabilitySet) -> Result<(), DomainError> {
        if !proposed.is_subset_of(&self.current_capabilities) {
            return Err(DomainError::CapabilityWidenForbidden);
        }
        if !proposed.is_subset_of(&self.capability_ceiling) {
            return Err(DomainError::CapabilityWidenForbidden);
        }
        Ok(())
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn assert_state_version(&self, expected: u64) -> Result<(), DomainError> {
        if self.state_version != expected {
            return Err(DomainError::TaskStateVersionMismatch {
                expected,
                actual: self.state_version,
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ResourceSelector;

    fn cap(action: &str, resource: &str) -> crate::Capability {
        crate::Capability::new(action, ResourceSelector::exact(resource))
    }

    #[test]
    fn ceiling_intersection() {
        let now = Utc::now();
        let a = CeilingInput {
            principal_id: PrincipalId::new(),
            capabilities: CapabilitySet::new(vec![cap("read", "repo:a"), cap("write", "repo:a")]),
        };
        let b = CeilingInput {
            principal_id: PrincipalId::new(),
            capabilities: CapabilitySet::new(vec![cap("read", "repo:a"), cap("read", "repo:b")]),
        };
        let compiled = CeilingCompilation::compile(vec![a, b], now).unwrap();
        assert_eq!(compiled.compiled_ceiling.capabilities.len(), 1);
        assert_eq!(compiled.compiled_ceiling.capabilities[0].action, "read");
    }

    #[test]
    fn widen_forbidden() {
        let now = Utc::now();
        let run = TaskRun {
            id: TaskRunId::new(),
            template_id: TaskTemplateId::new(),
            organization_id: OrganizationId::new(),
            project_id: None,
            principal_id: PrincipalId::new(),
            authority_context_id: AuthorityContextId::new(),
            status: TaskRunStatus::Active,
            capability_ceiling: CapabilitySet::new(vec![cap("read", "repo:a")]),
            current_capabilities: CapabilitySet::new(vec![cap("read", "repo:a")]),
            state_version: 1,
            state_digest: String::new(),
            maximum_expires_at: now + chrono::Duration::hours(1),
            created_at: now,
            updated_at: now,
        };
        let wider = CapabilitySet::new(vec![cap("read", "repo:a"), cap("write", "repo:a")]);
        assert!(run.validate_restriction(&wider).is_err());
    }

    #[test]
    fn state_digest_stable() {
        let now = Utc::now();
        let mut run = TaskRun {
            id: TaskRunId::new(),
            template_id: TaskTemplateId::new(),
            organization_id: OrganizationId::new(),
            project_id: None,
            principal_id: PrincipalId::new(),
            authority_context_id: AuthorityContextId::new(),
            status: TaskRunStatus::Active,
            capability_ceiling: CapabilitySet::new(vec![cap("read", "repo:a")]),
            current_capabilities: CapabilitySet::new(vec![cap("read", "repo:a")]),
            state_version: 1,
            state_digest: String::new(),
            maximum_expires_at: now + chrono::Duration::hours(1),
            created_at: now,
            updated_at: now,
        };
        let d1 = run.compute_state_digest().unwrap();
        let d2 = run.compute_state_digest().unwrap();
        assert_eq!(d1, d2);
        run.state_version = 2;
        assert_ne!(run.compute_state_digest().unwrap(), d1);
    }
}
