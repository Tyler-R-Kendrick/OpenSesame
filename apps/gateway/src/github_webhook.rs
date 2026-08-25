//! Verified GitHub App webhooks → durable outbox → `TaskBus` wake.

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use opensesame_connection_broker::github_webhook_hmac::verify_hub_signature_256;
use opensesame_task_bus::BusEvent;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::app_state::AppState;

const WEBHOOK_EVENT: &str = "github.webhook";
const WAKE_TYPE: &str = "system.github.webhook.wake";

fn well_formed_hub_signature(signature: &str) -> bool {
    let Some(hex) = signature
        .strip_prefix("sha256=")
        .or_else(|| signature.strip_prefix("SHA256="))
    else {
        return false;
    };
    hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit())
}

fn body_claim_key(body: &[u8]) -> String {
    let digest = Sha256::digest(body);
    format!("github.body.{digest:x}")
}

fn webhook_error(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({"error": code}))).into_response()
}

async fn configured_webhook_secret(st: &AppState) -> Result<String, Response> {
    let org = st.connection_organization;
    let integrations = st
        .connection_broker
        .list_integrations(&org)
        .await
        .map_err(|_| webhook_error(StatusCode::SERVICE_UNAVAILABLE, "integrations_unavailable"))?;
    let Some(integration) = integrations.iter().find(|row| {
        row.provider_id == "github"
            && row.enabled
            && row.source == opensesame_connection_broker::IntegrationSource::Organization
    }) else {
        return Err(webhook_error(
            StatusCode::NOT_FOUND,
            "github_app_not_configured",
        ));
    };
    match st
        .connection_broker
        .github_webhook_secret(&org, &integration.id)
        .await
    {
        Ok(Some(secret)) if !secret.is_empty() => Ok(secret),
        Ok(_) => Err((
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({"error":"webhook_secret_missing","hint":"recreate GitHub App with webhook secret"})),
        )
            .into_response()),
        Err(_) => Err(webhook_error(StatusCode::INTERNAL_SERVER_ERROR, "internal")),
    }
}

async fn claim_webhook_body(st: &AppState, body: &[u8]) -> Result<Option<String>, Response> {
    let claim_key = body_claim_key(body);
    match st.db.try_claim_host_kv(&claim_key, "pending").await {
        Ok(true) => Ok(Some(claim_key)),
        Ok(false) => Ok(None),
        Err(error) => {
            tracing::error!(%error, "webhook delivery claim failed");
            Err(webhook_error(StatusCode::INTERNAL_SERVER_ERROR, "internal"))
        }
    }
}

async fn append_webhook_outbox(
    st: &AppState,
    claim_key: &str,
    payload: &Value,
) -> Result<String, Response> {
    match st
        .db
        .append_outbox(WEBHOOK_EVENT, &payload.to_string())
        .await
    {
        Ok(id) => Ok(id),
        Err(error) => {
            tracing::error!(%error, "webhook outbox append failed");
            if let Err(release) = st.db.delete_host_kv(claim_key).await {
                tracing::error!(%release, "webhook claim rollback failed");
            }
            Err(webhook_error(StatusCode::INTERNAL_SERVER_ERROR, "internal"))
        }
    }
}

/// `POST /api/v1/webhooks/github` — verify, enqueue, wake. Fast 2xx after durable write.
pub async fn webhook(State(st): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let signature = headers
        .get("x-hub-signature-256")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    // Fail closed on a missing/malformed MAC before any DB or secret lookup.
    if !well_formed_hub_signature(signature) {
        return webhook_error(StatusCode::UNAUTHORIZED, "invalid_signature");
    }

    let delivery = headers
        .get("x-github-delivery")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let event_name = headers
        .get("x-github-event")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let secret = match configured_webhook_secret(&st).await {
        Ok(secret) => secret,
        Err(response) => return response,
    };

    if !verify_hub_signature_256(&secret, &body, signature) {
        return webhook_error(StatusCode::UNAUTHORIZED, "invalid_signature");
    }

    if delivery.is_empty() {
        return webhook_error(StatusCode::BAD_REQUEST, "missing_delivery_id");
    }

    // HMAC covers the body, not x-github-delivery. Dedup on the verified body
    // so an attacker cannot replay the same payload under a fresh delivery id.
    let claim_key = match claim_webhook_body(&st, &body).await {
        Ok(Some(claim_key)) => claim_key,
        Ok(None) => return StatusCode::NO_CONTENT.into_response(),
        Err(response) => return response,
    };

    let payload: Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let action = payload
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let installation_id = payload
        .pointer("/installation/id")
        .and_then(serde_json::Value::as_u64)
        .map(|n| n.to_string());

    let outbox_payload = json!({
        "delivery_id": delivery,
        "event": event_name,
        "action": action,
        "installation_id": installation_id,
    });

    let outbox_id = match append_webhook_outbox(&st, &claim_key, &outbox_payload).await {
        Ok(id) => id,
        Err(response) => return response,
    };

    let _ = st.db.set_host_kv(&claim_key, &outbox_id).await;

    apply_installation_side_effects(&st, &event_name, &action, installation_id.as_deref()).await;

    publish_webhook_wake(&st, &outbox_id, &delivery).await;
    st.backup_notify.notify_one();

    StatusCode::NO_CONTENT.into_response()
}

async fn apply_installation_side_effects(
    st: &AppState,
    event: &str,
    action: &str,
    installation_id: Option<&str>,
) {
    let org = st.connection_organization.to_string();
    let Ok(Some(mut target)) = st.db.get_backup_target(&org).await else {
        return;
    };
    if let Some(id) = installation_id {
        if !target.installation_id.is_empty() && target.installation_id != id {
            return;
        }
    }
    match (event, action) {
        ("installation", "deleted" | "suspend") => {
            let _ = st
                .db
                .record_backup_outcome(&org, "suspended", None, Some("github_app_uninstalled"))
                .await;
        }
        ("installation", "unsuspend" | "created" | "new_permissions_accepted") => {
            target.status = "pending".into();
            target.last_error = None;
            let _ = st.db.upsert_backup_target(&target).await;
        }
        _ => {}
    }
}

async fn publish_webhook_wake(st: &AppState, outbox_id: &str, delivery_id: &str) {
    let event = BusEvent::cloud_event(
        uuid::Uuid::now_v7().to_string(),
        "opensesame/gateway/github-webhook",
        WAKE_TYPE,
        chrono::Utc::now().to_rfc3339(),
        json!({
            "outbox_id": outbox_id,
            "delivery_id": delivery_id,
        }),
    );
    let bus = st.task_bus.read().await;
    if let Err(error) = bus.publish(event).await {
        tracing::warn!(%error, "github webhook TaskBus wake failed");
    }
}

/// GET health for webhook endpoint (GitHub ping may use GET in some setups).
pub async fn webhook_get() -> Response {
    StatusCode::NO_CONTENT.into_response()
}

#[cfg(test)]
mod tests {
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
        let mut state = app_state::build(Args {
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

        sqlx::query(
            "INSERT OR IGNORE INTO organizations (id, name, created_at) VALUES (?, 'Org', ?)",
        )
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
                        "-----BEGIN RSA PRIVATE KEY-----\nstub\n-----END RSA PRIVATE KEY-----"
                            .into(),
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
        let subject = opensesame_task_bus::event_subject(
            opensesame_task_bus::DEFAULT_SUBJECT_PREFIX,
            WAKE_TYPE,
        );
        assert!(subject.starts_with(opensesame_task_bus::SYSTEM_SUBJECT_PREFIX));
    }

    #[tokio::test]
    async fn missing_app_returns_not_found() {
        let _guard = crate::app_state::test_env::lock();
        std::env::set_var("OPENSESAME_TASKBUS", "memory");
        let state = app_state::build(Args {
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
        let mut state = app_state::build(Args {
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
        sqlx::query(
            "INSERT OR IGNORE INTO organizations (id, name, created_at) VALUES (?, 'Org', ?)",
        )
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
                        "-----BEGIN RSA PRIVATE KEY-----\nstub\n-----END RSA PRIVATE KEY-----"
                            .into(),
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

    #[tokio::test]
    async fn installation_deleted_marks_backup_suspended() {
        use opensesame_storage::BackupTarget;

        let secret = "whsec_e2e";
        let state = state_with_webhook_secret(secret).await;
        let org = state.connection_organization.to_string();
        state
            .db
            .upsert_backup_target(&BackupTarget {
                organization_id: org.clone(),
                integration_id: "int".into(),
                installation_id: "7".into(),
                owner: "acme".into(),
                repo: "r".into(),
                branch: "env/production".into(),
                enabled: true,
                status: "ok".into(),
                last_commit_sha: None,
                last_synced_at: None,
                last_error: None,
            })
            .await
            .unwrap();

        let body = br#"{"action":"deleted","installation":{"id":7}}"#;
        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/webhooks/github")
            .header("content-type", "application/json")
            .header("x-github-delivery", "del-suspend")
            .header("x-github-event", "installation")
            .header(
                "x-hub-signature-256",
                sign_hub_signature_256(secret, body).unwrap(),
            )
            .body(Body::from(body.to_vec()))
            .unwrap();
        let response = crate::routes::router(state.clone())
            .oneshot(request)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);

        let target = state.db.get_backup_target(&org).await.unwrap().unwrap();
        assert_eq!(target.status, "suspended");
        assert_eq!(target.last_error.as_deref(), Some("github_app_uninstalled"));
    }

    /// Chaos: TaskBus publish failures must not discard a verified durable enqueue.
    #[tokio::test]
    async fn webhook_survives_taskbus_publish_partition() {
        let secret = "whsec_chaos";
        let mut state = state_with_webhook_secret(secret).await;
        state.task_bus = Arc::new(RwLock::new(
            Arc::new(PartitionedBus) as Arc<dyn opensesame_task_bus::TaskBus>
        ));
        let body = br#"{"action":"created","installation":{"id":3}}"#;
        let status = post_webhook(&state, secret, "del-chaos", body, true).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert_eq!(state.db.count_unpublished_outbox().await.unwrap(), 1);
        // Idempotent retry after partition still 204 and still one outbox row.
        let status2 = post_webhook(&state, secret, "del-chaos", body, true).await;
        assert_eq!(status2, StatusCode::NO_CONTENT);
        assert_eq!(state.db.count_unpublished_outbox().await.unwrap(), 1);
    }

    /// Mutation oracle: claim-before-append stays exclusive under interleaving.
    /// A check-then-set mutant of this algorithm would allow double claim.
    #[test]
    fn delivery_claim_algorithm_kills_check_then_set_mutant() {
        opensesame_host_core::pact::exclusive_claim_is_single_winner();
        opensesame_host_core::pact::check_then_set_admits_double_claim();
    }

    #[test]
    fn production_webhook_claims_before_outbox_append() {
        let src = include_str!("github_webhook.rs");
        opensesame_host_core::pact::assert_source_order(
            src,
            &["try_claim_host_kv", "append_outbox", "delete_host_kv"],
        );
        let production = src.split("#[cfg(test)]").next().unwrap_or(src);
        assert!(
            production.contains("github.body."),
            "claim key must bind the HMAC-verified body, not unsigned x-github-delivery"
        );
    }

    #[tokio::test]
    async fn same_body_under_fresh_delivery_id_does_not_double_enqueue() {
        let secret = "whsec_e2e";
        let state = state_with_webhook_secret(secret).await;
        let body = br#"{"action":"created","installation":{"id":7}}"#;
        assert_eq!(
            post_webhook(&state, secret, "del-a", body, true).await,
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            post_webhook(&state, secret, "del-b", body, true).await,
            StatusCode::NO_CONTENT
        );
        assert_eq!(state.db.count_unpublished_outbox().await.unwrap(), 1);
    }

    #[tokio::test]
    async fn malformed_signature_is_rejected_before_app_lookup() {
        let _guard = crate::app_state::test_env::lock();
        std::env::set_var("OPENSESAME_TASKBUS", "memory");
        let state = app_state::build(Args {
            listen: "127.0.0.1:0".parse().unwrap(),
            resource: "https://opensesame.local".into(),
            issuer: "https://issuer.local".into(),
            database_url: "sqlite::memory:".into(),
            task_database_url: String::new(),
        })
        .await
        .unwrap();
        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/webhooks/github")
            .header("content-type", "application/json")
            .header("x-github-delivery", "x")
            .body(Body::from("{}"))
            .unwrap();
        let response = crate::routes::router(state).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
}
