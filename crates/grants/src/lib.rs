pub use opensesame_domain::{DomainError, Grant};

///
/// # Errors
///
/// Returns an error when the child grant does not attenuate the parent.
pub fn delegate(parent: &Grant, mut child: Grant) -> Result<Grant, DomainError> {
    child.parent_grant_id = Some(parent.id);
    child.delegation_depth = parent.delegation_depth + 1;
    Grant::validate_attenuation(parent, &child)?;
    Ok(child)
}

#[cfg(test)]
mod pact {
    use chrono::{Duration, Utc};
    use opensesame_domain::{
        ConnectionId, Grant, GrantConstraints, GrantId, OfflineUse, OrganizationId, PrincipalId,
        ProjectId,
    };

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
            resources: vec!["repo:acme/catalog".into()],
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
    fn property_delegate_attenuates_and_increments_depth() {
        let parent = sample_parent();
        let mut child = parent.clone();
        child.id = GrantId::new();
        child.actions = vec!["repository.read".into()];
        child.constraints.expires_at = parent.constraints.expires_at - Duration::minutes(5);
        child.constraints.budgets.insert("calls".into(), 5);
        child.constraints.maximum_delegation_depth = 0;
        let out = super::delegate(&parent, child).unwrap();
        assert_eq!(out.parent_grant_id, Some(parent.id));
        assert_eq!(out.delegation_depth, 1);
    }

    #[test]
    fn adversarial_expanded_actions_are_refused() {
        let parent = sample_parent();
        let mut child = parent.clone();
        child.actions.push("admin.destroy".into());
        assert!(super::delegate(&parent, child).is_err());
    }

    #[test]
    fn chaos_cross_org_child_is_refused() {
        let parent = sample_parent();
        let mut child = parent.clone();
        child.organization_id = OrganizationId::new();
        child.actions = vec!["repository.read".into()];
        child.constraints.maximum_delegation_depth = 0;
        assert!(super::delegate(&parent, child).is_err());
    }

    #[test]
    fn contract_grant_json_has_no_secret_fields() {
        let json = serde_json::to_value(sample_parent()).unwrap();
        let blob = json.to_string();
        assert!(!blob.contains("access_token"));
        assert!(!blob.contains("private_key"));
        assert!(!blob.contains("refresh_token"));
    }
}
