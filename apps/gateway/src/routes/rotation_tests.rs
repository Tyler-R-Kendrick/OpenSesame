use super::*;
use crate::test_principals::{P23, P24};
use opensesame_connection_broker::RotationStatus;
use opensesame_task_bus::{InMemoryTaskBus, TaskBus as _};

#[tokio::test]
async fn requested_event_has_no_secret_payload() {
    let db = opensesame_storage::Db::connect_memory().await.unwrap();
    let broker = opensesame_connection_broker::ConnectionBroker::new(
        db.pool().clone(),
        opensesame_connection_broker::BrokerConfig::in_memory(
            Some([9u8; 32]),
            "http://127.0.0.1:8787",
        ),
    )
    .unwrap();
    let bus = InMemoryTaskBus::default();
    let job = request_rotation(
        &broker,
        &bus,
        RotationTarget::Connection {
            connection_id: "connection:test".into(),
        },
        None,
        "org:test",
        None,
    )
    .await
    .unwrap();
    assert_eq!(job.status, RotationStatus::Requested);
    let view = job.public_view().to_string();
    assert!(!view.contains("access_token"));
    assert!(!view.contains("\"password\""));
    assert_eq!(
        job.public_view()["secrets_returned"],
        serde_json::Value::Null
    );
    let events = bus.drain(10).await.unwrap();
    assert!(!events[0].data.to_string().contains("access_token"));
}

use crate::app_state::{test_demo_state, test_session_headers, AppState};
use axum::body::Body;
use axum::http::Request;
use opensesame_domain::OrganizationRole;
use tower::ServiceExt;

async fn send(
    st: &AppState,
    headers: &axum::http::HeaderMap,
    method: &str,
    uri: &str,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .header(
            "authorization",
            headers.get("authorization").unwrap().as_bytes(),
        )
        .body(Body::from(body.to_string()))
        .unwrap();
    let response = crate::routes::router(st.clone())
        .oneshot(request)
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let value = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    (status, value)
}

#[tokio::test]
async fn policy_routes_are_owner_admin_gated() {
    let st = test_demo_state().await;
    let org = st.connection_organization;
    let member = test_session_headers(&st, P23, org, OrganizationRole::Member);
    let body = json!({"store_path": "Dev/api-token", "interval": "24h"});
    let (status, _) = send(
        &st,
        &member,
        "PUT",
        "/api/v1/rotation/policies",
        body.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = send(&st, &member, "GET", "/api/v1/rotation/policies", json!({})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let admin = test_session_headers(&st, P24, org, OrganizationRole::Admin);
    let (status, created) = send(&st, &admin, "PUT", "/api/v1/rotation/policies", body).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["interval_seconds"], 86_400);
    assert_eq!(created["enabled"], true);
    assert_eq!(created["secrets_returned"], false);

    let (status, listed) = send(&st, &admin, "GET", "/api/v1/rotation/policies", json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed["policies"].as_array().unwrap().len(), 1);
    let text = listed.to_string();
    assert!(!text.contains("access_token"));
    assert!(!text.contains("client_secret"));

    // Update in place: disable it, keeping the same id.
    let id = created["id"].as_str().unwrap();
    let (status, updated) = send(
        &st,
        &admin,
        "PUT",
        "/api/v1/rotation/policies",
        json!({"id": id, "store_path": "Dev/api-token", "interval": "1h", "enabled": false}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(updated["id"], id);
    assert_eq!(updated["interval_seconds"], 3600);
    assert_eq!(updated["enabled"], false);

    // Garbage interval is refused.
    let (status, _) = send(
        &st,
        &admin,
        "PUT",
        "/api/v1/rotation/policies",
        json!({"store_path": "Dev/api-token", "interval": "soon"}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn jobs_are_durable_and_value_blind_across_router_instances() {
    let st = test_demo_state().await;
    let org = st.connection_organization;
    let admin = test_session_headers(&st, P24, org, OrganizationRole::Admin);

    let (status, accepted) = send(
        &st,
        &admin,
        "POST",
        "/api/v1/rotations",
        json!({"store_path": "Dev/api-token", "interval": "24h"}),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{accepted}");
    assert_eq!(accepted["state"], "scheduled");
    assert_eq!(accepted["secrets_returned"], false);
    assert!(
        accepted["policy_id"].is_string(),
        "interval creates a policy"
    );
    let id = accepted["id"].as_str().unwrap().to_string();

    // No static registry: a fresh router over the same state (pool) still
    // sees the job.
    let (status, fetched) = send(
        &st,
        &admin,
        "GET",
        &format!("/api/v1/rotations/{id}"),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(fetched["id"], id.as_str());
    assert_eq!(fetched["secrets_returned"], false);

    let (status, listed) = send(&st, &admin, "GET", "/api/v1/rotations", json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed["rotations"].as_array().unwrap().len(), 1);
    let text = listed.to_string();
    assert!(!text.contains("access_token"));
    assert!(!text.contains("refresh_token"));
    assert!(!text.contains("\"password\""));
}
