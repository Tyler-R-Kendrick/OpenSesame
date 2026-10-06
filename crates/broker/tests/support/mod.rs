//! Adversarial broker battle tests — prove idempotency, org isolation, expiry, quorum.
use chrono::{Duration, Utc};
use opensesame_audit::ReceiptSigner;
use opensesame_authz::PolicyEngine;
use opensesame_broker::{Broker, InvokeInput};
use opensesame_connector_host::HostRuntime;
use opensesame_domain::*;
use opensesame_storage::Db;

pub(crate) fn sample_grant(org: OrganizationId, principal: PrincipalId) -> Grant {
    let now = Utc::now();
    Grant {
        id: GrantId::new(),
        version: 1,
        issuer_principal_id: principal,
        beneficiary_principal_id: principal,
        actor_id: None,
        client_id: None,
        actor_instance_id: None,
        proof_key_thumbprint: None,
        organization_id: org,
        project_id: None,
        environment_id: None,
        connection_id: None,
        actions: vec!["repository.read".into(), "pull_request.create".into()],
        resources: vec!["repo:acme/catalog".into()],
        constraints: GrantConstraints {
            audiences: vec!["https://api.github.com".into()],
            not_before: None,
            expires_at: now + Duration::hours(1),
            required_assurance: Some("mfa".into()),
            authentication_max_age_seconds: None,
            allowed_networks: vec![],
            parameter_rules_digest: None,
            budgets: std::collections::BTreeMap::default(),
            maximum_delegation_depth: 0,
            offline_use: OfflineUse::Forbidden,
            raw_credential_export: false,
        },
        parent_grant_id: None,
        delegation_depth: 0,
        created_at: now,
        revoked_at: None,
    }
}

pub(crate) fn sample_intent(
    org: OrganizationId,
    principal: PrincipalId,
    actor: ActorId,
    operation: &str,
    idem: &str,
    params: &serde_json::Value,
) -> Intent {
    let now = Utc::now();
    Intent {
        id: IntentId::new(),
        organization_id: org,
        project_id: None,
        principal_id: principal,
        actor_id: actor,
        actor_instance_id: None,
        client_id: None,
        operator_id: None,
        connection_id: None,
        operation: operation.into(),
        resource: "repo:acme/catalog".into(),
        audience: "https://api.github.com".into(),
        normalized_parameters_hash: Intent::parameters_hash(params).unwrap(),
        body_hash: None,
        nonce: uuid::Uuid::new_v4().to_string(),
        idempotency_key: idem.into(),
        issued_at: now,
        expires_at: now + Duration::minutes(5),
        parent_invocation_id: None,
        delegation_chain: vec![],
        proof: DetachedProof {
            algorithm: "EdDSA".into(),
            key_thumbprint: "t".into(),
            signature: "s".into(),
        },
    }
}

pub(crate) async fn setup() -> (Broker, OrganizationId, PrincipalId, ActorId) {
    let db = Db::connect_memory().await.unwrap();
    let org = OrganizationId::new();
    let principal = PrincipalId::new();
    let actor = ActorId::new();
    db.create_organization(&org, "acme").await.unwrap();
    let mut policy = PolicyEngine::default();
    policy
        .relationships
        .write("connection:demo-conn", "user", "user:demo");
    policy.assurance.insert("user:demo".into(), "mfa".into());
    let broker = Broker {
        db,
        policy,
        host: HostRuntime::default(),
        signer: ReceiptSigner::generate(),
    };
    (broker, org, principal, actor)
}
