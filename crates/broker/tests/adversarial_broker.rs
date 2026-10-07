//! Adversarial broker battle tests — prove idempotency, org isolation, expiry, quorum.
use chrono::{Duration, Utc};
use opensesame_broker::InvokeInput;
use opensesame_domain::*;
use serde_json::json;

mod support;
use support::{sample_grant, sample_intent, setup};

#[tokio::test]
async fn idempotency_must_not_duplicate_side_effects() {
    let (broker, org, principal, actor) = setup().await;
    let grant = sample_grant(org, principal);
    let params = json!({"title": "once"});
    let intent1 = sample_intent(
        org,
        principal,
        actor,
        "pull_request.create",
        "idem-1",
        &params,
    );
    let r1 = broker
        .invoke(InvokeInput {
            intent: intent1.clone(),
            grant: grant.clone(),
            subject: "user:demo".into(),
            connection_policy_id: "demo-conn".into(),
            parameters: params.clone(),
            lineage: None,
        })
        .await
        .unwrap();
    assert_eq!(r1.outcome, ReceiptOutcome::Succeeded);
    assert_eq!(r1.organization_id, Some(org));
    assert_eq!(r1.receipt_schema_version, 3);

    // Same idempotency key, new intent id — MUST return prior receipt, not re-execute.
    let mut intent2 = sample_intent(
        org,
        principal,
        actor,
        "pull_request.create",
        "idem-1",
        &params,
    );
    intent2.id = IntentId::new();
    let r2 = broker
        .invoke(InvokeInput {
            intent: intent2,
            grant,
            subject: "user:demo".into(),
            connection_policy_id: "demo-conn".into(),
            parameters: params,
            lineage: None,
        })
        .await
        .unwrap();

    let receipts = broker.db.count_receipts().await.unwrap();
    let inv_count = broker
        .db
        .count_invocations_for_intent(&intent1.id)
        .await
        .unwrap();
    assert_eq!(r1.id, r2.id, "idempotent retry must return same receipt id");
    assert_eq!(r2.organization_id, Some(org));
    assert_eq!(r2.receipt_schema_version, 3);
    assert_eq!(receipts, 1, "must not create a second receipt");
    assert_eq!(
        inv_count, 1,
        "must not create a second invocation for first intent"
    );
}

#[tokio::test]
async fn cross_org_grant_must_be_rejected() {
    let (broker, org_a, principal, actor) = setup().await;
    let org_b = OrganizationId::new();
    broker.db.create_organization(&org_b, "evil").await.unwrap();
    let grant = sample_grant(org_b, principal); // grant in B
    let params = json!({});
    let intent = sample_intent(
        org_a,
        principal,
        actor,
        "repository.read",
        "xorg-1",
        &params,
    );
    let result = broker
        .invoke(InvokeInput {
            intent,
            grant,
            subject: "user:demo".into(),
            connection_policy_id: "demo-conn".into(),
            parameters: params,
            lineage: None,
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
            lineage: None,
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
            lineage: None,
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
            lineage: None,
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
    let mut intent = sample_intent(
        org,
        principal,
        actor,
        "repository.read",
        "tamper-1",
        &params,
    );
    intent.normalized_parameters_hash = "sha256:deadbeef".into();
    let err = broker
        .invoke(InvokeInput {
            intent,
            grant,
            subject: "user:demo".into(),
            connection_policy_id: "demo-conn".into(),
            parameters: params,
            lineage: None,
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
            lineage: None,
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
            lineage: None,
        })
        .await
        .unwrap();
    let by_prefixed = broker.db.get_receipt(&receipt.id).await.unwrap();
    assert!(by_prefixed.is_some());
    let bare = ReceiptId::parse(&receipt.id.as_uuid().to_string()).unwrap();
    let by_bare = broker.db.get_receipt(&bare).await.unwrap();
    assert!(
        by_bare.is_some(),
        "hypothesis D: bare uuid lookup must work"
    );
    broker.signer.verify_receipt(&receipt).unwrap();
}
