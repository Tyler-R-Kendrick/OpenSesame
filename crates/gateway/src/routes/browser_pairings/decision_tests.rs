//! What an operator's approval writes, through the real decision route.
//!
//! Approving a sync pairing makes its person a member of the Host's
//! organization; approving a join pairing (ADR 0136) makes nobody a member
//! of anything — the join routes read no organization role, and one invite
//! is not a seat in the organization.

use crate::routes::shared_sessions::tests::state;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use opensesame_claims::hash_low_entropy;
use opensesame_connection_broker::config_access::role_policy;
use opensesame_domain::{OrganizationId, PrincipalId};
use opensesame_storage::browser_pairing::NewBrowserPairing;
use serde_json::json;
use tower::ServiceExt;

/// Approve a fresh pairing that asked for `capabilities`; whether it left a role.
async fn approve(capabilities: &str) -> bool {
    let st = Box::pin(state()).await;
    let router = crate::routes::router(st.clone());
    let user_code = "BCDF-GHJK";
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp();
    st.db
        .create_browser_pairing(&NewBrowserPairing {
            id: &id,
            device_digest: &format!("device-{id}"),
            user_code_digest: &hash_low_entropy(&st.claim_pepper, "browser-pairing-v1", user_code),
            origin: "https://join.example",
            dpop_jkt: "jkt",
            audience: &st.resource,
            capabilities_json: capabilities,
            now,
        })
        .await
        .unwrap();
    let (org, person) = (OrganizationId::new(), PrincipalId::new());
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/browser-pairings/decision")
        .header("x-opensesame-operator", &st.operator_token)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"user_code": user_code, "decision": "approve",
                "principal_id": person.to_string(), "organization_id": org.to_string()})
            .to_string(),
        ))
        .unwrap();
    let response = router.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    role_policy(st.db.pool(), &org, &person)
        .await
        .unwrap()
        .is_some()
}

#[tokio::test]
async fn approving_a_join_pairing_makes_nobody_a_member() {
    assert!(!approve("[\"host.join\"]").await);
}

#[tokio::test]
async fn approving_a_sync_pairing_still_makes_a_member() {
    assert!(approve("[\"host.sync.read\"]").await);
}
