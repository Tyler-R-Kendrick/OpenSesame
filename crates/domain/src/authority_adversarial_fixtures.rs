//! Shared grant / intent fixtures for the named AT-* adversarial regressions.
//!
//! Kept beside `authority_adversarial_matrix` rather than inside it: the
//! matrix is a list of named refusals, and a reader looking up an AT- row
//! should not have to scroll past a hundred lines of struct literal to reach
//! the first one.

use chrono::{Duration, Utc};

use crate::{
    DomainError, Grant, GrantConstraints, GrantId, Intent, IntentId, OfflineUse, OrganizationId,
    PrincipalId, ProjectId,
};

pub fn constrained_parent() -> Grant {
    let now = Utc::now();
    Grant {
        id: GrantId::new(),
        version: 1,
        issuer_principal_id: PrincipalId::new(),
        beneficiary_principal_id: PrincipalId::new(),
        actor_id: None,
        client_id: None,
        actor_instance_id: None,
        proof_key_thumbprint: Some("jkt:parent".into()),
        organization_id: OrganizationId::new(),
        project_id: Some(ProjectId::new()),
        environment_id: None,
        connection_id: None,
        actions: vec!["repository.read".into()],
        resources: vec!["repo:acme/*".into()],
        constraints: GrantConstraints {
            audiences: vec!["https://api.example".into()],
            not_before: Some(now),
            expires_at: now + Duration::hours(2),
            required_assurance: Some("mfa".into()),
            authentication_max_age_seconds: Some(600),
            allowed_networks: vec!["10.0.0.0/8".into()],
            parameter_rules_digest: Some("sha256:rules-a".into()),
            budgets: [("calls".into(), 10)].into_iter().collect(),
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

pub fn child_of(parent: &Grant) -> Grant {
    let mut child = parent.clone();
    child.id = GrantId::new();
    child.parent_grant_id = Some(parent.id);
    child.delegation_depth = parent.delegation_depth + 1;
    child.issuer_principal_id = parent.beneficiary_principal_id;
    child.beneficiary_principal_id = PrincipalId::new();
    child.proof_key_thumbprint = Some(format!("jkt:{}", child.id));
    child.created_at = parent.created_at + Duration::seconds(1);
    child.resources = vec!["repo:acme/catalog".into()];
    child.constraints.expires_at = parent.constraints.expires_at - Duration::minutes(5);
    child.constraints.authentication_max_age_seconds = Some(300);
    child.constraints.budgets.insert("calls".into(), 5);
    child.constraints.maximum_delegation_depth = 1;
    child
}

pub fn attenuation_refused(parent: &Grant, child: &Grant) -> String {
    match Grant::validate_attenuation(parent, child) {
        Err(DomainError::GrantAttenuation(why)) => why,
        other => panic!("expected attenuation refusal, got {other:?}"),
    }
}

pub fn sample_intent() -> Intent {
    let now = Utc::now();
    Intent {
        id: IntentId::new(),
        organization_id: OrganizationId::new(),
        project_id: None,
        principal_id: PrincipalId::new(),
        actor_id: crate::ActorId::new(),
        actor_instance_id: None,
        client_id: None,
        operator_id: None,
        connection_id: None,
        operation: "repository.read".into(),
        resource: "repo:acme/x".into(),
        audience: "https://api.example".into(),
        normalized_parameters_hash: "sha256:params".into(),
        body_hash: None,
        nonce: "n".into(),
        idempotency_key: "ik".into(),
        issued_at: now,
        expires_at: now + Duration::hours(1),
        parent_invocation_id: None,
        delegation_chain: vec![],
        proof: crate::DetachedProof {
            algorithm: "EdDSA".into(),
            key_thumbprint: "thumb".into(),
            signature: "sig".into(),
        },
    }
}
