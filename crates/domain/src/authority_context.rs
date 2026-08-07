//! Effective authority context for task-scoped access.
//!
//! A task run binds to exactly one authority context at activation; switching
//! after activation is a domain error.

use crate::{
    AuthorityContextId, CapabilitySet, DomainError, OrganizationId, PrincipalId, ProjectId,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthorityContextMode {
    /// One principal's grant materializes the ceiling.
    SinglePrincipal,
    /// Intersection of grants across principals — conservative common grant.
    ConservativeCommonGrant,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AuthorityContext {
    pub id: AuthorityContextId,
    pub mode: AuthorityContextMode,
    pub organization_id: OrganizationId,
    pub project_id: Option<ProjectId>,
    pub principal_ids: Vec<PrincipalId>,
    pub capability_ceiling: CapabilitySet,
    pub compiled_at: DateTime<Utc>,
}

impl AuthorityContext {
    pub fn assert_single_effective_principal(&self) -> Result<(), DomainError> {
        match self.mode {
            AuthorityContextMode::SinglePrincipal if self.principal_ids.len() == 1 => Ok(()),
            AuthorityContextMode::ConservativeCommonGrant if self.principal_ids.len() >= 2 => {
                Ok(())
            }
            AuthorityContextMode::SinglePrincipal => Err(DomainError::AuthorityContextInvalid(
                "single_principal requires exactly one principal".into(),
            )),
            AuthorityContextMode::ConservativeCommonGrant => {
                Err(DomainError::AuthorityContextInvalid(
                    "conservative_common_grant requires at least two principals".into(),
                ))
            }
        }
    }

    pub fn assert_same_context(&self, other: &Self) -> Result<(), DomainError> {
        if self.id != other.id {
            return Err(DomainError::AuthorityContextLocked);
        }
        Ok(())
    }
}
