//! Authorization requirements derived from protected resources and protocol profiles.

use crate::{
    CapabilitySet, DomainError, ProofPurpose, ProtectedResource, ProtocolProfile, TokenPresentation,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AuthorizationRequirement {
    pub required_capabilities: CapabilitySet,
    pub minimum_presentation: TokenPresentation,
    pub proof_purposes: Vec<ProofPurpose>,
    pub requires_task_binding: bool,
    pub requires_replay_protection: bool,
    pub audience: String,
}

impl AuthorizationRequirement {
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn from_protected_resource(
        resource: &ProtectedResource,
        profile: &ProtocolProfile,
    ) -> Result<Self, DomainError> {
        Ok(Self {
            required_capabilities: resource.required_capabilities.clone(),
            minimum_presentation: profile.minimum_presentation,
            proof_purposes: vec![ProofPurpose::ResourceAccess],
            requires_task_binding: profile.requires_task_binding,
            requires_replay_protection: profile.requires_replay_protection,
            audience: resource.audience.clone(),
        })
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn assert_satisfied(
        &self,
        held: &CapabilitySet,
        presentation: TokenPresentation,
    ) -> Result<(), DomainError> {
        if !self.required_capabilities.is_subset_of(held) {
            return Err(DomainError::AuthorizationDenied(
                "capability subset not satisfied".into(),
            ));
        }
        if presentation_strength(presentation) < presentation_strength(self.minimum_presentation) {
            return Err(DomainError::TokenPresentationDowngrade);
        }
        Ok(())
    }
}

fn presentation_strength(p: TokenPresentation) -> u8 {
    match p {
        TokenPresentation::Bearer => 0,
        TokenPresentation::DpopBound => 1,
        TokenPresentation::HttpMessageSignature => 2,
        TokenPresentation::MutualTls => 3,
    }
}
