use crate::app_state::{self, test_session_headers, AppState};
use crate::config::Args;
use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use opensesame_connection_broker::github_app::GithubAppCredentials;
use opensesame_connection_broker::{BrokerConfig, ConnectionBroker};
use serde_json::{json, Value};
use std::sync::Arc;
use tower::ServiceExt;

async fn state() -> AppState {
    let mut state = app_state::build_test(Args {
        listen: "127.0.0.1:0".parse().unwrap(),
        resource: "https://opensesame.local".into(),
        issuer: "https://issuer.local".into(),
        database_url: "sqlite::memory:".into(),
        task_database_url: String::new(),
    })
    .await
    .unwrap();
    let config = BrokerConfig::in_memory(Some([7u8; 32]), "http://127.0.0.1:8787");
    state.connection_broker =
        Arc::new(ConnectionBroker::new(state.db.pool().clone(), config).unwrap());
    state
}

async fn call(
    state: &AppState,
    method: &str,
    path: &str,
    headers: Option<axum::http::HeaderMap>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = Request::builder().method(method).uri(path);
    match headers {
        Some(map) => {
            for (name, value) in &map {
                request = request.header(name, value);
            }
        }
        None => {
            request = request.header(
                "authorization",
                format!("Bearer operator:{}", state.operator_token),
            );
        }
    }
    let request = match body {
        Some(value) => request
            .header("content-type", "application/json")
            .body(Body::from(value.to_string()))
            .unwrap(),
        None => request.body(Body::empty()).unwrap(),
    };
    let response = super::super::router(state.clone())
        .oneshot(request)
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value)
}

async fn register_app(state: &AppState) -> String {
    sqlx::query("INSERT OR IGNORE INTO organizations (id, name, created_at) VALUES (?, 'Org', ?)")
        .bind(state.connection_organization.to_string())
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(state.db.pool())
        .await
        .unwrap();
    state
        .connection_broker
        .register_github_app_credentials(
            &state.connection_organization,
            &GithubAppCredentials {
                id: 99,
                name: "App".into(),
                client_id: "Iv1.x".into(),
                client_secret: "s".into(),
                html_url: None,
                pem: Some(
                    "-----BEGIN RSA PRIVATE KEY-----\nstub\n-----END RSA PRIVATE KEY-----".into(),
                ),
                webhook_secret: None,
            },
            "test",
        )
        .await
        .unwrap()
        .id
}

#[tokio::test]
async fn list_installations_is_scoped_to_caller_organization() {
    let state = state().await;
    let integration = register_app(&state).await;
    let foreign = opensesame_domain::OrganizationId::new();
    let headers = test_session_headers(
        &state,
        "principal:00000000-0000-4000-8000-000000000003",
        foreign,
        opensesame_domain::OrganizationRole::Owner,
    );
    let (status, body) = call(
        &state,
        "GET",
        &format!("/api/v1/integrations/{integration}/github/installations"),
        Some(headers),
        None,
    )
    .await;
    if status == StatusCode::OK {
        let rows = body["installations"].as_array().expect("installations");
        assert!(
            rows.is_empty(),
            "foreign org must not see another org's GitHub App installs: {body}"
        );
    } else {
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    }
}

#[tokio::test]
async fn put_target_queues_resync_with_organization_id_when_enabled() {
    let state = state().await;
    let integration = register_app(&state).await;
    let org = state.connection_organization.to_string();
    let before = state.db.count_unpublished_outbox().await.unwrap();
    let (status, body) = call(
        &state,
        "PUT",
        "/api/v1/backup/target",
        None,
        Some(json!({
            "integration_id": integration,
            "installation_id": "55",
            "owner": "acme",
            "repo": "vault",
            "enabled": true,
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["target"]["enabled"], true);
    assert!(state.db.count_unpublished_outbox().await.unwrap() > before);
    let events = state.db.claim_outbox_batch(16, 60).await.unwrap();
    let resync = events
        .iter()
        .find(|e| e.event_type == "backup.resync")
        .expect("expected backup.resync");
    let payload: serde_json::Value = serde_json::from_str(&resync.payload_json).unwrap();
    assert_eq!(payload["organization_id"], org);
    assert_eq!(payload["reason"], "target_updated");
}

#[tokio::test]
async fn put_target_disable_does_not_queue_resync() {
    let state = state().await;
    let integration = register_app(&state).await;
    let (status, _) = call(
        &state,
        "PUT",
        "/api/v1/backup/target",
        None,
        Some(json!({
            "integration_id": integration,
            "installation_id": "55",
            "owner": "acme",
            "repo": "vault",
            "enabled": true,
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // Drain the initial sync so we can observe a clean disable.
    let claimed = state.db.claim_outbox_batch(16, 60).await.unwrap();
    let ids: Vec<_> = claimed.iter().map(|e| e.id.clone()).collect();
    state.db.mark_outbox_published(&ids).await.unwrap();
    let before = state.db.count_unpublished_outbox().await.unwrap();
    let (status, body) = call(
        &state,
        "PUT",
        "/api/v1/backup/target",
        None,
        Some(json!({
            "integration_id": integration,
            "installation_id": "55",
            "owner": "acme",
            "repo": "vault",
            "enabled": false,
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["target"]["enabled"], false);
    assert_eq!(state.db.count_unpublished_outbox().await.unwrap(), before);
}

#[tokio::test]
async fn reenable_queues_a_fresh_sync() {
    let state = state().await;
    let integration = register_app(&state).await;
    for enabled in [true, false, true] {
        let (status, _) = call(
            &state,
            "PUT",
            "/api/v1/backup/target",
            None,
            Some(json!({
                "integration_id": integration,
                "installation_id": "55",
                "owner": "acme",
                "repo": "vault",
                "enabled": enabled,
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }
    let events = state.db.claim_outbox_batch(16, 60).await.unwrap();
    let resyncs: Vec<_> = events
        .iter()
        .filter(|e| e.event_type == "backup.resync")
        .collect();
    // Initial enable + re-enable after disable — never the disable itself.
    assert_eq!(resyncs.len(), 2, "{events:?}");
}

#[tokio::test]
async fn resync_publishes_backup_wake_on_taskbus() {
    let _guard = crate::app_state::test_env::lock();
    use opensesame_task_bus::{InMemoryTaskBus, TaskBus};
    use std::sync::Arc;
    use tokio::sync::RwLock;

    std::env::set_var("OPENSESAME_TASKBUS", "memory");
    let mut state = state().await;
    let mem = Arc::new(InMemoryTaskBus::default());
    let as_dyn: Arc<dyn opensesame_task_bus::TaskBus> = mem.clone();
    state.task_bus = Arc::new(RwLock::new(as_dyn));

    let (status, body) = call(&state, "POST", "/api/v1/backup/resync", None, None).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    assert_eq!(state.db.count_unpublished_outbox().await.unwrap(), 1);

    let events = mem.drain(10).await.unwrap();
    assert!(
        events.iter().any(|e| e.r#type == "system.backup.wake"),
        "expected backup wake on bus, got {events:?}"
    );
    assert!(events
        .iter()
        .all(|e| !e.data.to_string().contains("BEGIN RSA")));
}

#[tokio::test]
async fn tenant_session_cannot_access_host_global_backup() {
    let state = state().await;
    state
        .db
        .append_outbox("backup.resync", r#"{"reason":"requested"}"#)
        .await
        .unwrap();
    let headers = test_session_headers(
        &state,
        "principal:00000000-0000-4000-8000-000000000001",
        state.connection_organization,
        opensesame_domain::OrganizationRole::Owner,
    );
    let (status, body) = call(&state, "GET", "/api/v1/backup/target", Some(headers), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert!(state.db.count_unpublished_outbox().await.unwrap() >= 1);
}
