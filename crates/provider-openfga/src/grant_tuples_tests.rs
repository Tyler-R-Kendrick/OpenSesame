use super::*;
use chrono::{Duration, Utc};
use opensesame_domain::{
    ConnectionId, GrantConstraints, OfflineUse, OrganizationId, PrincipalId, ProjectId,
};
fn sample_grant() -> Grant {
    let now = Utc::now();
    Grant {
        id: opensesame_domain::GrantId::new(),
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
        actions: vec!["secret.read".into()],
        resources: vec!["vault/item/*".into()],
        constraints: GrantConstraints {
            audiences: vec!["host".into()],
            not_before: None,
            expires_at: now + Duration::days(30),
            required_assurance: None,
            authentication_max_age_seconds: None,
            allowed_networks: vec![],
            parameter_rules_digest: None,
            budgets: std::collections::BTreeMap::default(),
            maximum_delegation_depth: 2,
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
fn projects_connection_user_and_project_viewer_for_read_grant() {
    let grant = sample_grant();
    let tuples = grant_to_openfga_tuples(&grant).expect("map");
    let user = format!("user:{}", grant.beneficiary_principal_id);
    assert!(tuples.iter().any(|t| {
        t.user == user && t.relation == "user" && t.object.starts_with("connection:")
    }));
    assert!(tuples
        .iter()
        .any(|t| { t.user == user && t.relation == "viewer" && t.object.starts_with("project:") }));
}

#[test]
fn refuses_revoked_grants() {
    let mut grant = sample_grant();
    grant.revoked_at = Some(Utc::now());
    assert!(matches!(
        grant_to_openfga_tuples(&grant),
        Err(GrantTupleMappingError::Revoked)
    ));
}

#[test]
fn refuses_cohort_shaped_resources() {
    let mut grant = sample_grant();
    grant.resources = vec!["cohort:eng".into()];
    assert!(matches!(
        grant_to_openfga_tuples(&grant),
        Err(GrantTupleMappingError::CohortGrantee)
    ));
}
#[test]
fn invoke_check_uses_resolved_connection_not_demo_conn() {
    let tuple = invoke_check_tuple("alice", "repository.read", "repo:x", Some("live")).unwrap();
    assert_eq!(tuple.object, "connection:live");
    assert!(invoke_check_tuple("alice", "read", "connection:other", Some("live")).is_err());
    assert!(invoke_check_tuple("alice", "read", "cohort:eng", Some("c")).is_err());
}
