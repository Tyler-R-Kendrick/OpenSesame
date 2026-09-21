
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
                    id: 99,
                    name: "App".into(),
                    client_id: "Iv1.x".into(),
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
            .unwrap()
            .id
    }

    #[tokio::test]
    async fn a_member_cannot_configure_backup() {
        let state = state().await;
        let headers = test_session_headers(
            &state,
            "principal:00000000-0000-4000-8000-000000000002",
            state.connection_organization,
            opensesame_domain::OrganizationRole::Member,
        );
        let (status, _) = call(&state, "GET", "/api/v1/backup/target", Some(headers), None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn target_requires_signing_material_then_round_trips() {
        let state = state().await;
        // No registered app: refused with the fix named.
        let (status, body) = call(
            &state,
            "PUT",
            "/api/v1/backup/target",
            None,
            Some(json!({
                "integration_id": "missing",
                "installation_id": "1",
                "owner": "acme",
                "repo": "opensesame-passwords",
            })),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");

        let integration = register_app(&state).await;
        let (status, body) = call(
            &state,
            "PUT",
            "/api/v1/backup/target",
            None,
            Some(json!({
                "integration_id": integration,
                "installation_id": "12345",
                "owner": "acme",
                "repo": "opensesame-passwords",
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["target"]["repo"], "opensesame-passwords");

        // Configuring queued a resync event for the actor.
        assert!(state.db.count_unpublished_outbox().await.unwrap() >= 1);

        let (status, body) = call(&state, "GET", "/api/v1/backup/target", None, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["target"]["installation_id"], "12345");
        assert!(body["pending_events"].as_i64().unwrap() >= 1);

        let (status, _) = call(&state, "POST", "/api/v1/backup/resync", None, None).await;
        assert_eq!(status, StatusCode::ACCEPTED);

        let (status, _) = call(&state, "DELETE", "/api/v1/backup/target", None, None).await;
        assert_eq!(status, StatusCode::OK);
        let (_, body) = call(&state, "GET", "/api/v1/backup/target", None, None).await;
        assert!(body["target"].is_null());
    }

    #[tokio::test]
    async fn owner_and_repo_names_are_validated() {
        let state = state().await;
        let integration = register_app(&state).await;
        let (status, _) = call(
            &state,
            "PUT",
            "/api/v1/backup/target",
            None,
            Some(json!({
                "integration_id": integration,
                "installation_id": "12345",
                "owner": "acme/../etc",
                "repo": "x",
            })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn put_target_defaults_to_env_production_branch() {
        let state = state().await;
        let integration = register_app(&state).await;
        let (status, body) = call(
            &state,
            "PUT",
            "/api/v1/backup/target",
            None,
            Some(json!({
                "integration_id": integration,
                "installation_id": "99",
                "owner": "acme",
                "repo": "opensesame-passwords",
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["target"]["branch"], "env/production");
    }

    #[tokio::test]
    async fn put_target_accepts_connection_id_for_github_only() {
        let state = state().await;
        let integration = register_app(&state).await;
        let connection = state
            .connection_broker
            .create_connection(
                &state.connection_organization,
                opensesame_connection_broker::CreateConnection {
                    provider_id: "github".into(),
                    integration_id: Some(integration.clone()),
                    owner_subject: Some("user:demo".into()),
                    display_name: Some("History".into()),
                    logical_name: None,
                    project_id: None,
                    scopes: None,
                    shareability: None,
                },
            )
            .await
            .unwrap();

        let (status, body) = call(
            &state,
            "PUT",
            "/api/v1/backup/target",
            None,
            Some(json!({
                "connection_id": connection.connection_id,
                "installation_id": "4242",
                "owner": "acme",
                "repo": "opensesame-passwords",
                "branch": "env/staging",
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["target"]["integration_id"], integration);
        assert_eq!(body["target"]["branch"], "env/staging");

        let (status, body) = call(
            &state,
            "PUT",
            "/api/v1/backup/target",
            None,
            Some(json!({
                "connection_id": "connection:missing",
                "installation_id": "1",
                "owner": "acme",
                "repo": "r",
            })),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    }

    #[tokio::test]
    async fn installations_route_refuses_integrations_without_app_material() {
        let state = state().await;
        let (status, body) = call(
            &state,
            "GET",
            "/api/v1/integrations/missing/github/installations",
            None,
            None,
        )
        .await;
        assert!(
            status == StatusCode::NOT_FOUND || status == StatusCode::UNPROCESSABLE_ENTITY,
            "{status} {body}"
        );
    }

