use super::*;
use chrono::{Duration, TimeZone};

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
fn contract_a_replacement_may_only_narrow() {
    let parent = sample_parent();
    let mut current = parent.clone();
    current.id = GrantId::new();
    current.parent_grant_id = Some(parent.id);
    current.delegation_depth = 1;
    current.actions = vec!["repository.read".into(), "pull_request.create".into()];
    current.resources = vec!["repo:acme/catalog".into(), "repo:acme/other".into()];
    current.constraints.expires_at = parent.constraints.expires_at - Duration::minutes(5);
    current.constraints.budgets.insert("calls".into(), 5);
    current.constraints.maximum_delegation_depth = 0;

    let mut narrower = current.clone();
    narrower.id = GrantId::new();
    narrower.actions = vec!["repository.read".into()];
    narrower.resources = vec!["repo:acme/catalog".into()];
    narrower.constraints.expires_at = current.constraints.expires_at - Duration::minutes(1);
    narrower.constraints.budgets.insert("calls".into(), 2);
    assert!(Grant::validate_replacement(&parent, &current, &narrower).is_ok());
}

#[test]
fn adversarial_a_replacement_cannot_widen_past_the_child_it_replaces() {
    let parent = sample_parent();
    let mut current = parent.clone();
    current.id = GrantId::new();
    current.parent_grant_id = Some(parent.id);
    current.delegation_depth = 1;
    current.actions = vec!["repository.read".into()];
    current.constraints.expires_at = parent.constraints.expires_at - Duration::minutes(5);
    current.constraints.maximum_delegation_depth = 0;
    current.constraints.budgets.insert("calls".into(), 3);

    let mut wider = current.clone();
    wider.id = GrantId::new();
    wider.actions = vec!["repository.read".into(), "pull_request.create".into()];
    assert!(Grant::validate_attenuation(&parent, &wider).is_ok());
    assert!(Grant::validate_replacement(&parent, &current, &wider).is_err());

    let mut longer = current.clone();
    longer.id = GrantId::new();
    longer.constraints.expires_at = current.constraints.expires_at + Duration::minutes(1);
    assert!(Grant::validate_replacement(&parent, &current, &longer).is_err());

    let mut richer = current.clone();
    richer.id = GrantId::new();
    richer.constraints.budgets.insert("calls".into(), 4);
    assert!(Grant::validate_replacement(&parent, &current, &richer).is_err());

    let mut deeper = current.clone();
    deeper.id = GrantId::new();
    deeper.delegation_depth = 2;
    assert!(Grant::validate_replacement(&parent, &current, &deeper).is_err());
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
fn interval_contains_is_half_open() {
    let nbf = Utc.timestamp_opt(10, 0).unwrap();
    let exp = Utc.timestamp_opt(20, 0).unwrap();
    assert!(!interval_contains(
        Utc.timestamp_opt(9, 0).unwrap(),
        Some(nbf),
        exp
    ));
    assert!(interval_contains(nbf, Some(nbf), exp));
    assert!(!interval_contains(exp, Some(nbf), exp));
}

#[test]
fn resource_scope_is_enforced_with_segment_boundaries() {
    let mut g = sample_parent();
    assert!(g.permits_resource("repo:acme/catalog"));
    assert!(!g.permits_resource("repo:victim/secrets"));
    assert!(!g.permits_resource("repo:acme/catalog-private"));

    g.resources = vec!["repo:acme/*".into()];
    assert!(g.permits_resource("repo:acme/catalog"));
    assert!(!g.permits_resource("repo:acme-private/catalog"));
    assert!(!g.permits_resource("repo:acme/"));

    g.resources = vec!["*".into()];
    assert!(g.permits_resource("anything"));

    g.resources = vec![];
    assert!(!g.permits_resource("repo:acme/catalog"));
}

#[test]
fn export_denied_by_default_invariant() {
    let g = sample_parent();
    assert!(!g.constraints.raw_credential_export);
}
