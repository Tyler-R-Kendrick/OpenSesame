
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
    async fn webhook_binds_organization_for_backup_actor_when_target_matches() {
        use opensesame_storage::BackupTarget;

        let secret = "whsec_bind";
        let state = state_with_webhook_secret(secret).await;
        let org = state.connection_organization.to_string();
        state
            .db
            .upsert_backup_target(&BackupTarget {
                organization_id: org.clone(),
                integration_id: "int".into(),
                installation_id: "42".into(),
                owner: "acme".into(),
                repo: "vault".into(),
                branch: "env/production".into(),
                enabled: true,
                status: "ok".into(),
                last_commit_sha: None,
                last_synced_at: None,
                last_error: None,
                kind: "github_app".into(),
                provider_id: None,
                connection_id: None,
                config: None,
            })
            .await
            .unwrap();

        let body = br#"{"action":"created","installation":{"id":42}}"#;
        let status = post_webhook(&state, secret, "del-bind", body, true).await;
        assert_eq!(status, StatusCode::NO_CONTENT);

        let events = state.db.claim_outbox_batch(8, 60).await.unwrap();
        let webhook = events
            .iter()
            .find(|e| e.event_type == "github.webhook")
            .expect("github.webhook outbox row");
        let payload: serde_json::Value = serde_json::from_str(&webhook.payload_json).unwrap();
        assert_eq!(payload["organization_id"], org);
        assert_eq!(payload["installation_id"], "42");
    }

    #[tokio::test]
    async fn webhook_without_backup_target_omits_organization_id() {
        let secret = "whsec_nobind";
        let state = state_with_webhook_secret(secret).await;
        let body = br#"{"action":"created","installation":{"id":9}}"#;
        let status = post_webhook(&state, secret, "del-nobind", body, true).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let events = state.db.claim_outbox_batch(8, 60).await.unwrap();
        let webhook = events
            .iter()
            .find(|e| e.event_type == "github.webhook")
            .expect("github.webhook outbox row");
        let payload: serde_json::Value = serde_json::from_str(&webhook.payload_json).unwrap();
        assert!(payload.get("organization_id").is_none());
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
                kind: "github_app".into(),
                provider_id: None,
                connection_id: None,
                config: None,
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
        let state = app_state::build_test(Args {
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
