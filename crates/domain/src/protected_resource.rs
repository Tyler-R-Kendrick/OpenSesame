//! Protected resources and external capability mappings.

use crate::{
    CapabilitySet, DomainError, OrganizationId, ProjectId, ProtectedResourceId,
    ProtocolProfileId, ResourceAccountRefId,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResourceAccountRef {
    pub id: ResourceAccountRefId,
    pub organization_id: OrganizationId,
    pub project_id: Option<ProjectId>,
    /// Stable external account identifier (e.g. `github:acme`).
    pub external_account: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExternalCapabilityMapping {
    pub external_action: String,
    pub external_resource_pattern: String,
    pub internal_action: String,
    pub internal_resource: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProtectedResource {
    pub id: ProtectedResourceId,
    pub organization_id: OrganizationId,
    pub project_id: Option<ProjectId>,
    pub name: String,
    pub audience: String,
    pub required_capabilities: CapabilitySet,
    pub protocol_profile_id: ProtocolProfileId,
    pub account_ref: Option<ResourceAccountRef>,
    pub external_mappings: Vec<ExternalCapabilityMapping>,
}

impl ProtectedResource {
    pub fn assert_capabilities(&self, held: &CapabilitySet) -> Result<(), DomainError> {
        if !self.required_capabilities.is_subset_of(held) {
            return Err(DomainError::AuthorizationDenied(
                "insufficient capabilities for protected resource".into(),
            ));
        }
        Ok(())
    }
}
