use super::*;
use crate::app_state::{test_demo_state, test_session_headers};
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use opensesame_connection_broker::{
    BrokerConfig, BrokerError, ConnectionBroker, CreateConnection, CreateSecretConfig,
    MapSecretSource,
};
use opensesame_domain::{OrganizationRole, Shareability};
use std::collections::BTreeMap;
use tower::ServiceExt;

fn router(state: AppState) -> Router {
    crate::routes::router(state)
}

fn auth_headers(st: &AppState) -> axum::http::HeaderMap {
    let org = st.connection_organization;
    test_session_headers(st, P06, org, OrganizationRole::Admin)
}

struct SecretLeakFixture {
    st: AppState,
    headers: axum::http::HeaderMap,
    config_id: String,
    connection_id: String,
}

async fn secret_leak_fixture() -> SecretLeakFixture {
    let mut st = test_demo_state().await;
    st.connection_broker = Arc::new(
        ConnectionBroker::new(
            st.db.pool().clone(),
            BrokerConfig::in_memory(Some([42u8; 32]), "http://127.0.0.1:8787"),
        )
        .unwrap(),
    );
    let org = st.connection_organization;
    let connection = st
        .connection_broker
        .create_connection(
            &org,
            CreateConnection {
                provider_id: "vercel".into(),
                integration_id: None,
                owner_subject: Some(P06.into()),
                display_name: Some("Vercel".into()),
                logical_name: None,
                project_id: None,
                scopes: None,
                shareability: Some(Shareability::Private),
            },
        )
        .await
        .unwrap();
    st.connection_broker
        .set_api_key(&org, &connection.connection_id, "vercel_live_token")
        .await
        .unwrap();
    let config = st
        .connection_broker
        .create_secret_config(
            &org.to_string(),
            CreateSecretConfig {
                project_id: "project:1".into(),
                slug: "production".into(),
                display_name: None,
                environment: "production".into(),
                parent_config_id: None,
            },
            None,
        )
        .await
        .unwrap();
    let principal = crate::middleware::auth::parse_principal(P06).unwrap();
    opensesame_connection_broker::config_access::provision_native_role(
        st.db.pool(),
        &org,
        &principal,
        OrganizationRole::Admin,
    )
    .await
    .unwrap();
    let headers = auth_headers(&st);
    SecretLeakFixture {
        st,
        headers,
        config_id: config.id,
        connection_id: connection.connection_id,
    }
}

fn authorized_request(
    headers: &axum::http::HeaderMap,
    method: &str,
    uri: &str,
    body: String,
) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .header(
            "authorization",
            headers.get("authorization").unwrap().as_bytes(),
        )
        .body(Body::from(body))
        .unwrap()
}

async fn create_sync_target(app: &Router, fixture: &SecretLeakFixture) -> String {
    let res = app
        .clone()
        .oneshot(
            authorized_request(
                &fixture.headers,
                "POST",
                "/api/v1/sync-targets",
                json!({
                    "project_id": "project:1",
                    "config_id": fixture.config_id,
                    "connection_id": fixture.connection_id,
                    "operation": "env.set"
                })
                .to_string(),
            ),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let created: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let text = created.to_string();
    assert!(!text.contains("vercel_live_token"));
    assert!(created.get("access_token").is_none());
    created["id"].as_str().unwrap().to_string()
}

async fn sync_target(app: &Router, fixture: &SecretLeakFixture, id: &str) {
    let uri = format!("/api/v1/sync-targets/{id}/sync");
    let res = app
        .clone()
        .oneshot(
            authorized_request(&fixture.headers, "POST", &uri, "{}".into()),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let outcome: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(!outcome.to_string().contains("vercel_live_token"));
    assert!(outcome["ok"].as_bool().unwrap());
}

#[tokio::test]
async fn sync_target_crud_and_bus_without_secret_leak() {
    let fixture = secret_leak_fixture().await;
    let app = router(fixture.st.clone());
    let id = create_sync_target(&app, &fixture).await;
    sync_target(&app, &fixture, &id).await;
    let events = fixture.st.task_bus.read().await.drain(20).await.unwrap();
    assert!(events.iter().any(|e| e.r#type == "sync.target.created"));
    assert!(events.iter().any(|e| e.r#type == "sync.target.synced"));
    for event in &events {
        assert!(!event.data.to_string().contains("vercel_live_token"));
    }
    assert_host_only_secret_source_compiles();
}

/// `MapSecretSource` is Host-only; keep its trait-object boundary compiled.
fn assert_host_only_secret_source_compiles() {
    let _host_only: Arc<dyn SyncSecretSource> = Arc::new(MapSecretSource {
        entries: BTreeMap::default(),
    });
    let _ = BrokerError::SyncTargetNotFound;
}
