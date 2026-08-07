//! Adversarial broker battle tests — prove idempotency, org isolation, expiry, quorum.
use chrono::{Duration, Utc};
use opensesame_audit::ReceiptSigner;
use opensesame_authz::PolicyEngine;
use opensesame_broker::{Broker, InvokeInput};
use opensesame_connector_host::HostRuntime;
use opensesame_domain::*;
use opensesame_storage::Db;
use serde_json::json;

fn sample_grant(org: OrganizationId, principal: PrincipalId) -> Grant {
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
            budgets: Default::default(),
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

fn sample_intent(
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

async fn setup() -> (Broker, OrganizationId, PrincipalId, ActorId) {
    let db = Db::connect_memory().await.unwrap();
    let org = OrganizationId::new();
    let principal = PrincipalId::new();
    let actor = ActorId::new();
    db.create_organization(&org, "acme").await.unwrap();
    let mut policy = PolicyEngine::default();
    policy
        .relationships
        .write("connection:demo-conn", "user", "user:demo");
    policy
        .assurance
        .insert("user:demo".into(), "mfa".into());
    let broker = Broker {
        db,
        policy,
        host: HostRuntime::default(),
        signer: ReceiptSigner::generate(),
    };
    (broker, org, principal, actor)
}

#[tokio::test]
async fn idempotency_must_not_duplicate_side_effects() {
    let (broker, org, principal, actor) = setup().await;
    let grant = sample_grant(org, principal);
    let params = json!({"title": "once"});
    let intent1 = sample_intent(org, principal, actor, "pull_request.create", "idem-1", &params);
    let r1 = broker
        .invoke(InvokeInput {
            intent: intent1.clone(),
            grant: grant.clone(),
            subject: "user:demo".into(),
            connection_policy_id: "demo-conn".into(),
            parameters: params.clone(),
        })
        .await
        .unwrap();
    assert_eq!(r1.outcome, ReceiptOutcome::Succeeded);

    // Same idempotency key, new intent id — MUST return prior receipt, not re-execute.
    let mut intent2 = sample_intent(org, principal, actor, "pull_request.create", "idem-1", &params);
    intent2.id = IntentId::new();
    let r2 = broker
        .invoke(InvokeInput {
            intent: intent2,
            grant,
            subject: "user:demo".into(),
            connection_policy_id: "demo-conn".into(),
            parameters: params,
        })
        .await
        .unwrap();

    let receipts = broker.db.count_receipts().await.unwrap();
    let inv_count = broker
        .db
        .count_invocations_for_intent(&intent1.id)
        .await
        .unwrap();
    assert_eq!(
        r1.id, r2.id,
        "idempotent retry must return same receipt id"
    );
    assert_eq!(receipts, 1, "must not create a second receipt");
    assert_eq!(inv_count, 1, "must not create a second invocation for first intent");
}

#[tokio::test]
async fn cross_org_grant_must_be_rejected() {
    let (broker, org_a, principal, actor) = setup().await;
    let org_b = OrganizationId::new();
    broker.db.create_organization(&org_b, "evil").await.unwrap();
    let grant = sample_grant(org_b, principal); // grant in B
    let params = json!({});
    let intent = sample_intent(org_a, principal, actor, "repository.read", "xorg-1", &params);
    let result = broker
        .invoke(InvokeInput {
            intent,
            grant,
            subject: "user:demo".into(),
            connection_policy_id: "demo-conn".into(),
            parameters: params,
        })
        .await;
    assert!(
        result.is_err()
            || matches!(
                result.as_ref().map(|r| r.outcome),
                Ok(ReceiptOutcome::Denied)
            ),
        "cross-org grant/intent must fail (hypothesis B), got {result:?}"
    );
}

#[tokio::test]
async fn revoked_grant_fails_closed() {
    let (broker, org, principal, actor) = setup().await;
    let mut grant = sample_grant(org, principal);
    grant.revoked_at = Some(Utc::now());
    let params = json!({});
    let intent = sample_intent(org, principal, actor, "repository.read", "rev-1", &params);
    let err = broker
        .invoke(InvokeInput {
            intent,
            grant,
            subject: "user:demo".into(),
            connection_policy_id: "demo-conn".into(),
            parameters: params,
        })
        .await
        .unwrap_err();
    assert!(
        err.to_string().to_lowercase().contains("revok")
            || err.to_string().contains("GrantRevoked"),
        "revoked grant must fail: {err}"
    );
}

#[tokio::test]
async fn expired_grant_fails_closed() {
    let (broker, org, principal, actor) = setup().await;
    let mut grant = sample_grant(org, principal);
    grant.constraints.expires_at = Utc::now() - Duration::seconds(1);
    let params = json!({});
    let intent = sample_intent(org, principal, actor, "repository.read", "exp-1", &params);
    let err = broker
        .invoke(InvokeInput {
            intent,
            grant,
            subject: "user:demo".into(),
            connection_policy_id: "demo-conn".into(),
            parameters: params,
        })
        .await
        .unwrap_err();
    assert!(
        err.to_string().contains("time")
            || err.to_string().contains("GrantTimeWindow")
            || err.to_string().contains("expired"),
        "expired grant must fail: {err}"
    );
}

#[tokio::test]
async fn quorum_loss_fails_closed_a3() {
    let (broker, org, principal, actor) = setup().await;
    broker.db.set_authority_quorum(false).await.unwrap();
    let grant = sample_grant(org, principal);
    let params = json!({});
    let intent = sample_intent(org, principal, actor, "repository.read", "q-1", &params);
    let err = broker
        .invoke(InvokeInput {
            intent,
            grant,
            subject: "user:demo".into(),
            connection_policy_id: "demo-conn".into(),
            parameters: params,
        })
        .await
        .unwrap_err();
    assert!(
        err.to_string().contains("quorum")
            || err.to_string().contains("AuthorityUnavailable")
            || err.to_string().contains("availability"),
        "{err}"
    );
}

#[tokio::test]
async fn parameter_digest_tamper_rejected() {
    let (broker, org, principal, actor) = setup().await;
    let grant = sample_grant(org, principal);
    let params = json!({"a": 1});
    let mut intent = sample_intent(org, principal, actor, "repository.read", "tamper-1", &params);
    intent.normalized_parameters_hash = "sha256:deadbeef".into();
    let err = broker
        .invoke(InvokeInput {
            intent,
            grant,
            subject: "user:demo".into(),
            connection_policy_id: "demo-conn".into(),
            parameters: params,
        })
        .await
        .unwrap_err();
    assert!(err.to_string().contains("parameter digest"));
}

#[tokio::test]
async fn operation_not_in_grant_denied() {
    let (broker, org, principal, actor) = setup().await;
    let grant = sample_grant(org, principal);
    let params = json!({});
    let intent = sample_intent(org, principal, actor, "admin.destroy", "op-1", &params);
    let receipt = broker
        .invoke(InvokeInput {
            intent,
            grant,
            subject: "user:demo".into(),
            connection_policy_id: "demo-conn".into(),
            parameters: params,
        })
        .await
        .unwrap();
    assert_eq!(receipt.outcome, ReceiptOutcome::Denied);
}

#[tokio::test]
async fn receipt_roundtrip_prefixed_and_bare_id() {
    let (broker, org, principal, actor) = setup().await;
    let grant = sample_grant(org, principal);
    let params = json!({});
    let intent = sample_intent(org, principal, actor, "repository.read", "rt-1", &params);
    let receipt = broker
        .invoke(InvokeInput {
            intent,
            grant,
            subject: "user:demo".into(),
            connection_policy_id: "demo-conn".into(),
            parameters: params,
        })
        .await
        .unwrap();
    let by_prefixed = broker.db.get_receipt(&receipt.id).await.unwrap();
    assert!(by_prefixed.is_some());
    let bare = ReceiptId::parse(&receipt.id.as_uuid().to_string()).unwrap();
    let by_bare = broker.db.get_receipt(&bare).await.unwrap();
    assert!(by_bare.is_some(), "hypothesis D: bare uuid lookup must work");
    broker.signer.verify_receipt(&receipt).unwrap();
}
