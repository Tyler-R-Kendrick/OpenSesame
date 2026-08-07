use crate::{
    ActorId, ActorInstanceId, ClientId, ConnectionId, DomainError, EnvironmentId, GrantId,
    OrganizationId, PrincipalId, ProjectId,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OfflineUse {
    Forbidden,
    ReadOnly,
    PreAuthorized,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GrantConstraints {
    pub audiences: Vec<String>,
    pub not_before: Option<DateTime<Utc>>,
    pub expires_at: DateTime<Utc>,
    pub required_assurance: Option<String>,
    pub authentication_max_age_seconds: Option<u64>,
    pub allowed_networks: Vec<String>,
    pub parameter_rules_digest: Option<String>,
    pub budgets: std::collections::BTreeMap<String, i64>,
    pub maximum_delegation_depth: u32,
    pub offline_use: OfflineUse,
    pub raw_credential_export: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Grant {
    pub id: GrantId,
    pub version: u32,
    pub issuer_principal_id: PrincipalId,
    pub beneficiary_principal_id: PrincipalId,
    pub actor_id: Option<ActorId>,
    pub client_id: Option<ClientId>,
    pub actor_instance_id: Option<ActorInstanceId>,
    pub proof_key_thumbprint: Option<String>,
    pub organization_id: OrganizationId,
    pub project_id: Option<ProjectId>,
    pub environment_id: Option<EnvironmentId>,
    pub connection_id: Option<ConnectionId>,
    pub actions: Vec<String>,
    pub resources: Vec<String>,
    pub constraints: GrantConstraints,
    pub parent_grant_id: Option<GrantId>,
    pub delegation_depth: u32,
    pub created_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
}

impl Grant {
    pub fn assert_active(&self, now: DateTime<Utc>) -> Result<(), DomainError> {
        if self.revoked_at.is_some() {
            return Err(DomainError::GrantRevoked);
        }
        if let Some(nbf) = self.constraints.not_before {
            if now < nbf {
                return Err(DomainError::GrantTimeWindow);
            }
        }
        if now >= self.constraints.expires_at {
            return Err(DomainError::GrantTimeWindow);
        }
        Ok(())
    }

    /// Child grants may only attenuate authority.
    pub fn validate_attenuation(parent: &Grant, child: &Grant) -> Result<(), DomainError> {
        if child.organization_id != parent.organization_id {
            return Err(DomainError::OrganizationMismatch);
        }
        if child.delegation_depth != parent.delegation_depth + 1 {
            return Err(DomainError::GrantAttenuation(
                "delegation_depth must increment by 1".into(),
            ));
        }
        if child.constraints.maximum_delegation_depth > parent.constraints.maximum_delegation_depth
        {
            return Err(DomainError::GrantAttenuation(
                "maximum_delegation_depth expanded".into(),
            ));
        }
        if child.delegation_depth > parent.constraints.maximum_delegation_depth {
            return Err(DomainError::DelegationDepthExceeded);
        }
        if child.constraints.expires_at > parent.constraints.expires_at {
            return Err(DomainError::GrantAttenuation("lifetime expanded".into()));
        }
        if child.constraints.raw_credential_export && !parent.constraints.raw_credential_export {
            return Err(DomainError::GrantAttenuation("export privilege expanded".into()));
        }
        if !is_subset(&child.actions, &parent.actions) {
            return Err(DomainError::GrantAttenuation("actions expanded".into()));
        }
        if !is_subset(&child.resources, &parent.resources) {
            return Err(DomainError::GrantAttenuation("resources expanded".into()));
        }
        if !is_subset(&child.constraints.audiences, &parent.constraints.audiences) {
            return Err(DomainError::GrantAttenuation("audiences expanded".into()));
        }
        for (k, v) in &child.constraints.budgets {
            match parent.constraints.budgets.get(k) {
                Some(pv) if v <= pv => {}
                _ => {
                    return Err(DomainError::GrantAttenuation(format!(
                        "budget expanded for {k}"
                    )))
                }
            }
        }
        Ok(())
    }
}

fn is_subset(child: &[String], parent: &[String]) -> bool {
    child.iter().all(|c| parent.iter().any(|p| p == c))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    fn sample_parent() -> Grant {
        let now = Utc::now();
        Grant {
            id: GrantId::new(),
            version: 1,
            issuer_principal_id: PrincipalId::new(),
            beneficiary_principal_id: PrincipalId::new(),
            actor_id: None,
            client_id: None,
            actor_instance_id: None,
            proof_key_thumbprint: None,
            organization_id: OrganizationId::new(),
            project_id: Some(ProjectId::new()),
            environment_id: None,
            connection_id: Some(ConnectionId::new()),
            actions: vec!["pull_request.create".into(), "repository.read".into()],
            resources: vec!["repo:acme/catalog".into(), "repo:acme/other".into()],
            constraints: GrantConstraints {
                audiences: vec!["https://api.github.com".into()],
                not_before: None,
                expires_at: now + Duration::hours(1),
                required_assurance: Some("mfa".into()),
                authentication_max_age_seconds: Some(600),
                allowed_networks: vec![],
                parameter_rules_digest: None,
                budgets: [("calls".into(), 10)].into_iter().collect(),
                maximum_delegation_depth: 1,
                offline_use: OfflineUse::Forbidden,
                raw_credential_export: false,
            },
            parent_grant_id: None,
            delegation_depth: 0,
            created_at: now,
            revoked_at: None,
        }
    }

    #[test]
    fn attenuation_ok() {
        let parent = sample_parent();
        let mut child = parent.clone();
        child.id = GrantId::new();
        child.parent_grant_id = Some(parent.id);
        child.delegation_depth = 1;
        child.actions = vec!["repository.read".into()];
        child.resources = vec!["repo:acme/catalog".into()];
        child.constraints.expires_at = parent.constraints.expires_at - Duration::minutes(5);
        child.constraints.budgets.insert("calls".into(), 5);
        child.constraints.maximum_delegation_depth = 0;
        assert!(Grant::validate_attenuation(&parent, &child).is_ok());
    }

    #[test]
    fn cannot_expand_actions() {
        let parent = sample_parent();
        let mut child = parent.clone();
        child.parent_grant_id = Some(parent.id);
        child.delegation_depth = 1;
        child.actions.push("admin.destroy".into());
        assert!(Grant::validate_attenuation(&parent, &child).is_err());
    }

    #[test]
    fn export_denied_by_default_invariant() {
        let g = sample_parent();
        assert!(!g.constraints.raw_credential_export);
    }
}
