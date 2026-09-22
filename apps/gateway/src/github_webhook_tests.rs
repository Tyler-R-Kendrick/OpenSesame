
use super::*;
use crate::app_state::{self, AppState};
use crate::config::Args;
use async_trait::async_trait;
use axum::body::{to_bytes, Body};
use axum::http::Request;
use opensesame_connection_broker::github_app::GithubAppCredentials;
use opensesame_connection_broker::github_webhook_hmac::sign_hub_signature_256;
use opensesame_connection_broker::{BrokerConfig, ConnectionBroker};
use opensesame_task_bus::InMemoryTaskBus;
use std::sync::Arc;
use tokio::sync::RwLock;
use tower::ServiceExt;

struct PartitionedBus;

#[async_trait]
impl opensesame_task_bus::TaskBus for PartitionedBus {
    async fn publish(&self, _event: BusEvent) -> anyhow::Result<()> {
        anyhow::bail!("simulated JetStream partition");
    }

    async fn drain(&self, _max: usize) -> anyhow::Result<Vec<BusEvent>> {
        Ok(vec![])
    }
}

async fn post_shared_webhook(
    state: Arc<AppState>,
    secret: &'static str,
    delivery: &'static str,
    body: &'static [u8],
) -> StatusCode {
    post_webhook(&state, secret, delivery, body, true).await
}

async fn state_with_webhook_secret(secret: &str) -> AppState {
    let _guard = crate::app_state::test_env::lock();
    std::env::set_var("OPENSESAME_TASKBUS", "memory");
    let mut state = app_state::build_test(Args {
        listen: "127.0.0.1:0".parse().unwrap(),
        resource: "https://opensesame.local".into(),
        issuer: "https://issuer.local".into(),
        database_url: "sqlite::memory:".into(),
        task_database_url: String::new(),
    })
    .await
    .unwrap();
    let config = BrokerConfig::in_memory(Some([9u8; 32]), "http://127.0.0.1:8787");
    state.connection_broker =
        Arc::new(ConnectionBroker::new(state.db.pool().clone(), config).unwrap());
    state.task_bus = Arc::new(RwLock::new(Arc::new(InMemoryTaskBus::default())));

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
                id: 42,
                name: "App".into(),
                client_id: "Iv1.x".into(),
                client_secret: "s".into(),
                html_url: None,
                pem: Some(
                    "-----BEGIN RSA PRIVATE KEY-----\nstub\n-----END RSA PRIVATE KEY-----".into(),
                ),
                webhook_secret: Some(secret.into()),
            },
            "test",
        )
        .await
        .unwrap();
    state
}

async fn post_webhook(
    state: &AppState,
    secret: &str,
    delivery: &str,
    body: &[u8],
    signed: bool,
) -> StatusCode {
    let sig = if signed {
        sign_hub_signature_256(secret, body).unwrap()
    } else {
        "sha256=deadbeef".into()
    };
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/webhooks/github")
        .header("content-type", "application/json")
        .header("x-github-delivery", delivery)
        .header("x-github-event", "installation")
        .header("x-hub-signature-256", sig)
        .body(Body::from(body.to_vec()))
        .unwrap();
    let response = crate::routes::router(state.clone())
        .oneshot(request)
        .await
        .unwrap();
    response.status()
}

#[tokio::test]
async fn rejects_invalid_signature() {
    let secret = "whsec_e2e";
    let state = state_with_webhook_secret(secret).await;
    let body = br#"{"action":"created","installation":{"id":7}}"#;
    let status = post_webhook(&state, secret, "del-bad", body, false).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(state.db.count_unpublished_outbox().await.unwrap(), 0);
}

#[tokio::test]
async fn valid_signature_enqueues_once_and_publishes_wake() {
    let secret = "whsec_e2e";
    let state = state_with_webhook_secret(secret).await;
    let body = br#"{"action":"created","installation":{"id":7}}"#;

    let status = post_webhook(&state, secret, "del-1", body, true).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(state.db.count_unpublished_outbox().await.unwrap(), 1);

    let status2 = post_webhook(&state, secret, "del-1", body, true).await;
    assert_eq!(status2, StatusCode::NO_CONTENT);
    assert_eq!(
        state.db.count_unpublished_outbox().await.unwrap(),
        1,
        "duplicate delivery must not double-enqueue"
    );

    let events = state.task_bus.read().await.drain(10).await.unwrap();
    assert!(
        events.iter().any(|e| e.r#type == WAKE_TYPE),
        "expected system webhook wake, got {events:?}"
    );
    assert!(events.iter().all(|e| !e.data.to_string().contains("whsec")));
}

#[tokio::test]
async fn wake_type_is_system_prefixed() {
    assert!(WAKE_TYPE.starts_with("system."));
    let subject =
        opensesame_task_bus::event_subject(opensesame_task_bus::DEFAULT_SUBJECT_PREFIX, WAKE_TYPE);
    assert!(subject.starts_with(opensesame_task_bus::SYSTEM_SUBJECT_PREFIX));
}

#[tokio::test]
async fn missing_app_returns_not_found() {
    let _guard = crate::app_state::test_env::lock();
    std::env::set_var("OPENSESAME_TASKBUS", "memory");
    let state = app_state::build_test(Args {
        listen: "127.0.0.1:0".parse().unwrap(),
        resource: "https://opensesame.local".into(),
        issuer: "https://issuer.local".into(),
        database_url: "sqlite::memory:".into(),
        task_database_url: String::new(),
    })
    .await
    .unwrap();
    let body = br"{}";
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/webhooks/github")
        .header("content-type", "application/json")
        .header("x-github-delivery", "x")
        .header(
            "x-hub-signature-256",
            "sha256=0000000000000000000000000000000000000000000000000000000000000000",
        )
        .body(Body::from(body.to_vec()))
        .unwrap();
    let response = crate::routes::router(state).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let _ = to_bytes(response.into_body(), 1024).await;
}

async fn state_without_webhook_secret() -> AppState {
    let _guard = crate::app_state::test_env::lock();
    std::env::set_var("OPENSESAME_TASKBUS", "memory");
    let mut state = app_state::build_test(Args {
        listen: "127.0.0.1:0".parse().unwrap(),
        resource: "https://opensesame.local".into(),
        issuer: "https://issuer.local".into(),
        database_url: "sqlite::memory:".into(),
        task_database_url: String::new(),
    })
    .await
    .unwrap();
    let config = BrokerConfig::in_memory(Some([9u8; 32]), "http://127.0.0.1:8787");
    state.connection_broker =
        Arc::new(ConnectionBroker::new(state.db.pool().clone(), config).unwrap());
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
                id: 43,
                name: "App".into(),
                client_id: "Iv1.y".into(),
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
        .unwrap();
    state
}

#[tokio::test]
async fn rejects_when_webhook_secret_not_configured() {
    let secret = "whsec_e2e";
    let state = state_without_webhook_secret().await;
    let body = br#"{"action":"created"}"#;
    let status = post_webhook(&state, secret, "del-nosecret", body, true).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn rejects_missing_delivery_id() {
    let secret = "whsec_e2e";
    let state = state_with_webhook_secret(secret).await;
    let body = br#"{"action":"created"}"#;
    let sig = sign_hub_signature_256(secret, body).unwrap();
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/webhooks/github")
        .header("content-type", "application/json")
        .header("x-github-event", "installation")
        .header("x-hub-signature-256", sig)
        .body(Body::from(body.to_vec()))
        .unwrap();
    let response = crate::routes::router(state).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn concurrent_duplicate_deliveries_enqueue_once() {
    let secret = "whsec_e2e";
    let state = Arc::new(state_with_webhook_secret(secret).await);
    let body: &'static [u8] = br#"{"action":"created","installation":{"id":99}}"#;
    let mut handles = Vec::new();
    for _ in 0..12 {
        handles.push(tokio::spawn(post_shared_webhook(
            state.clone(),
            secret,
            "del-concurrent",
            body,
        )));
    }
    for handle in handles {
        assert_eq!(handle.await.unwrap(), StatusCode::NO_CONTENT);
    }
    assert_eq!(state.db.count_unpublished_outbox().await.unwrap(), 1);
}
