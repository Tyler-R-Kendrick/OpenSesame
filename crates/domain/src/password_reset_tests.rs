use super::*;
use crate::{
    ActorId, ConnectionId, DetachedProof, GrantConstraints, GrantId, IntentId, OfflineUse,
    OrganizationId, PrincipalId,
};
use chrono::Duration;
use serde::Deserialize;

#[derive(Deserialize)]
struct VectorFile {
    vectors: Vec<Vector>,
}

#[derive(Deserialize)]
struct Vector {
    name: String,
    run_id: String,
    grant_run_id: Option<String>,
    intent_run_id: Option<String>,
    domain: String,
    item_id: Option<String>,
    capability: PasswordResetCapability,
    narrow_capability: Option<PasswordResetCapability>,
    grant_actions: Vec<String>,
    grant_resources: Vec<String>,
    raw_credential_export: bool,
    expected: String,
}

#[test]
fn shared_cua_password_reset_vectors() {
    let file: VectorFile = serde_json::from_str(include_str!(
        "../../../spec/conformance/cua-password-reset.json"
    ))
    .unwrap();
    assert_eq!(file.vectors.len(), 13);
    for vector in file.vectors {
        let metadata =
            PasswordResetGrantScope::domain_metadata(&vector.run_id, &vector.domain).unwrap();
        let scoped = match vector.capability {
            PasswordResetCapability::DomainMetadata => metadata.clone(),
            capability => metadata
                .narrow_to_item(vector.item_id.as_deref().unwrap(), capability)
                .unwrap(),
        };
        if vector.expected == "invalid_scope" {
            assert!(
                metadata
                    .narrow_to_item("", vector.narrow_capability.unwrap())
                    .is_err(),
                "{}",
                vector.name
            );
            continue;
        }
        let now = Utc::now();
        let grant = Grant {
            id: GrantId::new(),
            version: 1,
            issuer_principal_id: PrincipalId::new(),
            beneficiary_principal_id: PrincipalId::new(),
            actor_id: Some(ActorId::new()),
            client_id: None,
            actor_instance_id: None,
            proof_key_thumbprint: None,
            organization_id: OrganizationId::new(),
            project_id: None,
            environment_id: None,
            connection_id: Some(ConnectionId::new()),
            actions: vector.grant_actions,
            resources: vector.grant_resources,
            constraints: GrantConstraints {
                audiences: vec![format!(
                    "opensesame:password-reset:{}",
                    vector.grant_run_id.as_deref().unwrap_or(&vector.run_id)
                )],
                not_before: Some(now - Duration::minutes(1)),
                expires_at: now + Duration::minutes(5),
                required_assurance: None,
                authentication_max_age_seconds: None,
                allowed_networks: vec![],
                parameter_rules_digest: None,
                budgets: Default::default(),
                maximum_delegation_depth: 0,
                offline_use: OfflineUse::Forbidden,
                raw_credential_export: vector.raw_credential_export,
            },
            parent_grant_id: None,
            delegation_depth: 0,
            created_at: now,
            revoked_at: None,
        };
        let intent = Intent {
            id: IntentId::new(),
            organization_id: grant.organization_id,
            project_id: None,
            principal_id: grant.beneficiary_principal_id,
            actor_id: grant.actor_id.unwrap(),
            actor_instance_id: None,
            client_id: None,
            operator_id: None,
            connection_id: grant.connection_id,
            operation: scoped.capability.required_action().into(),
            resource: scoped.resource(),
            audience: format!(
                "opensesame:password-reset:{}",
                vector.intent_run_id.unwrap_or(vector.run_id)
            ),
            normalized_parameters_hash: "sha256:parameters".into(),
            body_hash: None,
            nonce: "nonce".into(),
            idempotency_key: "effect-key".into(),
            issued_at: now,
            expires_at: now + Duration::minutes(5),
            parent_invocation_id: None,
            delegation_chain: vec![],
            proof: DetachedProof {
                algorithm: "EdDSA".into(),
                key_thumbprint: "thumb".into(),
                signature: "signature".into(),
            },
        };
        let result = scoped.authorize(&grant, &intent, now);
        assert_eq!(
            result.is_ok(),
            vector.expected == "allow",
            "{}",
            vector.name
        );
    }
}

#[test]
fn every_item_capability_needs_its_own_exact_action() {
    let capabilities = [
        PasswordResetCapability::Item,
        PasswordResetCapability::Mailbox,
        PasswordResetCapability::Browser,
        PasswordResetCapability::Runtime,
        PasswordResetCapability::Model,
        PasswordResetCapability::Proxy,
        PasswordResetCapability::PasswordProduction,
        PasswordResetCapability::HumanTakeover,
        PasswordResetCapability::Reconciliation,
        PasswordResetCapability::Compensation,
    ];
    let metadata = PasswordResetGrantScope::domain_metadata("run-01", "example.test").unwrap();
    let actions: Vec<_> = capabilities
        .into_iter()
        .map(|capability| {
            let scope = metadata.narrow_to_item("login-01", capability).unwrap();
            assert_eq!(scope.item_id.as_deref(), Some("login-01"));
            scope.capability.required_action()
        })
        .collect();
    assert_eq!(actions.len(), 10);
    for (index, action) in actions.iter().enumerate() {
        assert!(!actions[..index].contains(action));
    }
}

#[test]
fn scope_rejects_ambiguous_or_unnormalized_names() {
    for domain in [
        "Example.test",
        "https://example.test",
        "*.example.test",
        "localhost",
    ] {
        assert!(PasswordResetGrantScope::domain_metadata("run-01", domain).is_err());
    }
    let metadata = PasswordResetGrantScope::domain_metadata("run-01", "example.test").unwrap();
    assert!(metadata
        .narrow_to_item("login:01", PasswordResetCapability::Item)
        .is_err());
    let item = metadata
        .narrow_to_item("login-01", PasswordResetCapability::Item)
        .unwrap();
    assert!(item
        .narrow_to_item("login-02", PasswordResetCapability::Model)
        .is_err());
}
