//! A session's admission policy, through the real router (ADR 0137).
//!
//! The operator states it once when opening a public session; an asker is
//! then seated at once as an observer holding nothing, or waits for the
//! operator as before. A policy that cannot apply is refused, and nothing a
//! policy does hands anybody a key.

use crate::routes::router;
use crate::routes::shared_sessions::tests::{actor, call, get, state};
use axum::http::StatusCode;
use opensesame_domain::OrganizationId;
use serde_json::{json, Value};

async fn open(
    router: &axum::Router,
    operator: &crate::routes::shared_sessions::tests::Actor,
    body: Value,
) -> (StatusCode, Value) {
    call(router, "POST", "/api/v1/shared-sessions", operator, body).await
}

#[tokio::test]
async fn a_policy_that_cannot_apply_is_refused() {
    let st = Box::pin(state()).await;
    let router = router(st.clone());
    let operator = actor(&st, OrganizationId::new());
    for body in [
        json!({"display_name": "Desk", "admission": "observer_on_ask"}),
        json!({"display_name": "Desk", "visibility": "private", "admission": "observer_on_ask"}),
        json!({"display_name": "Desk", "visibility": "public", "admission": "participant_on_ask"}),
    ] {
        let (status, answer) = open(&router, &operator, body).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{answer}");
        assert_eq!(answer["error"], "session_admission");
    }
    let (status, answer) = open(&router, &operator, json!({"display_name": "Desk"})).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(answer["admission"], "operator");
}

#[tokio::test]
async fn an_asker_is_seated_as_an_observer_holding_nothing() {
    let st = Box::pin(state()).await;
    let router = router(st.clone());
    let organization = OrganizationId::new();
    let operator = actor(&st, organization);
    let asker = actor(&st, organization);
    let (_, lobby) = open(
        &router,
        &operator,
        json!({"display_name": "Lobby", "visibility": "public", "admission": "observer_on_ask"}),
    )
    .await;
    let (_, desk) = open(
        &router,
        &operator,
        json!({"display_name": "Desk", "visibility": "public"}),
    )
    .await;
    let (lobby, desk) = (lobby["id"].as_str().unwrap(), desk["id"].as_str().unwrap());

    // The discovery record says which answer an ask will get.
    let (_, listed) = get(&router, "/api/v1/shared-sessions?visibility=public", &asker).await;
    let admission = |id: &str| {
        listed["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["id"] == id)
            .unwrap()["admission"]
            .clone()
    };
    assert_eq!(admission(lobby), "observer_on_ask");
    assert_eq!(admission(desk), "operator");

    let asks = |id: &str| format!("/api/v1/shared-sessions/{id}/join-requests");
    let (status, answer) = call(&router, "POST", &asks(lobby), &asker, json!({})).await;
    assert_eq!(status, StatusCode::CREATED, "{answer}");
    assert_eq!(answer["decision"], "admitted");
    assert_eq!(answer["mode"], "observer");
    assert!(answer.get("grant").is_none());

    // Seated: in the room, as an observer, and nothing waits on the operator.
    let (_, members) = get(
        &router,
        &format!("/api/v1/shared-sessions/{lobby}/members"),
        &operator,
    )
    .await;
    let seat = members["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|seat| seat["principal_id"] == asker.principal.to_string())
        .cloned();
    assert_eq!(
        seat.map(|seat| seat["mode"].clone()),
        Some(json!("observer"))
    );
    let (_, waiting) = get(&router, &asks(lobby), &operator).await;
    assert_eq!(waiting["requests"], json!([]));
    let (status, again) = call(&router, "POST", &asks(lobby), &asker, json!({})).await;
    assert_eq!(
        (status, again["error"].clone()),
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            json!("already_in_session")
        )
    );

    // The session that did not opt in still waits for its operator.
    let (status, answer) = call(&router, "POST", &asks(desk), &asker, json!({})).await;
    assert_eq!(
        (status, answer["decision"].clone()),
        (StatusCode::ACCEPTED, json!("pending"))
    );
}

#[tokio::test]
async fn pending_observer_and_participant_admissions_are_refused_after_close() {
    let st = Box::pin(state()).await;
    let router = router(st.clone());
    let organization = OrganizationId::new();
    let operator = actor(&st, organization);
    let asker = actor(&st, organization);
    for mode in ["observer", "participant"] {
        let (_, opened) = open(
            &router,
            &operator,
            json!({"display_name": "Closed", "visibility": "public"}),
        )
        .await;
        let id = opened["id"].as_str().unwrap();
        let asks = format!("/api/v1/shared-sessions/{id}/join-requests");
        let (status, waiting) = call(&router, "POST", &asks, &asker, json!({})).await;
        assert_eq!(status, StatusCode::ACCEPTED);
        let request_id = waiting["id"].as_str().unwrap();
        let (status, _) = call(
            &router,
            "POST",
            &format!("/api/v1/shared-sessions/{id}/close"),
            &operator,
            json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let mut body = json!({"decision": "admitted", "mode": mode});
        if mode == "participant" {
            body["grant"] = json!({"scope": {"kind": "collection", "vault_id": opensesame_domain::VaultId::new().to_string()}, "role": "read", "expires_at": (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339()});
        }
        let path = format!("{asks}/{request_id}/decide");
        let (status, _) = call(&router, "POST", &path, &operator, body).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let session_id = opensesame_domain::SessionId::parse(id).unwrap();
        let request_id = opensesame_domain::JoinRequestId::parse(request_id).unwrap();
        assert_eq!(
            st.db
                .join_request(&organization.to_string(), request_id)
                .await
                .unwrap()
                .unwrap()
                .decision,
            opensesame_domain::JoinDecision::Pending
        );
        assert!(st
            .db
            .session_membership(session_id, asker.principal)
            .await
            .unwrap()
            .is_none());
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM session_grants WHERE session_id = ?1")
                .bind(id)
                .fetch_one(st.db.pool())
                .await
                .unwrap();
        assert_eq!(count, 0);
        let (status, _) = call(
            &router,
            "POST",
            &path,
            &operator,
            json!({"decision": "refused"}),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
}
