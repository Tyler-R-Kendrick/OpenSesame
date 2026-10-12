use super::*;
use crate::app_state::{test_demo_state, test_session_headers};
use axum::{body::Body, http::Request};
use opensesame_connection_broker::{
    config_access::{self, PolicyActor, ProjectAccess},
    BrokerConfig, BrokerError, ConnectionBroker, CreateConnection, CreateSecretConfig,
};
use opensesame_domain::{OrganizationRole, PrincipalId, Shareability};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use tower::ServiceExt;

struct Fixture {
    st: AppState,
    principal: PrincipalId,
    headers: axum::http::HeaderMap,
    config: String,
    other_config: String,
    target: String,
    other_target: String,
    connection: String,
}

async fn fixture(delegated: bool) -> Fixture {
    let mut st = test_demo_state().await;
    st.connection_broker = Arc::new(
        ConnectionBroker::new(
            st.db.pool().clone(),
            BrokerConfig::in_memory(Some([42u8; 32]), "http://127.0.0.1:8787"),
        )
        .unwrap(),
    );
    let org = st.connection_organization;
    let principal = PrincipalId::new();
    config_access::set_role_ceiling(
        st.db.pool(), &org, &principal, Some(OrganizationRole::Admin), 0, 0,
    )
    .await
    .unwrap();
    let headers = test_session_headers(&st, &principal.to_string(), org, OrganizationRole::Admin);
    let connection = st.connection_broker.create_connection(
        &org,
        CreateConnection {
            provider_id: "vercel".into(),
            integration_id: None,
            owner_subject: Some(principal.to_string()),
            display_name: Some("security test".into()),
            logical_name: None,
            project_id: None,
            scopes: None,
            shareability: Some(Shareability::Private),
        },
    ).await.unwrap();
    st.connection_broker.set_api_key(&org, &connection.connection_id, "test-only-token")
        .await.unwrap();
    let actor = if delegated {
        PolicyActor::Session { principal, role: OrganizationRole::Admin }
    } else {
        PolicyActor::Operator
    };
    let mut configs = Vec::new();
    let mut targets = Vec::new();
    for project in ["allowed", "other"] {
        let config = st.connection_broker.create_secret_config(
            &org.to_string(),
            CreateSecretConfig {
                project_id: project.into(),
                slug: "production".into(),
                display_name: None,
                environment: "production".into(),
                parent_config_id: None,
            },
            None,
        ).await.unwrap();
        let target = st.connection_broker.create_sync_target_for_actor(
            &org,
            CreateSyncTarget {
                project_id: project.into(),
                config_id: config.id.clone(),
                connection_id: connection.connection_id.clone(),
                operation: None,
            },
            &actor,
        ).await.unwrap();
        configs.push(config.id);
        targets.push(target.id);
    }
    Fixture {
        st,
        principal,
        headers,
        config: configs[0].clone(),
        other_config: configs[1].clone(),
        target: targets[0].clone(),
        other_target: targets[1].clone(),
        connection: connection.connection_id,
    }
}

async fn request(f: &Fixture, method: &str, uri: &str, body: serde_json::Value) -> Response {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .header("authorization", f.headers.get("authorization").unwrap())
        .body(Body::from(body.to_string()))
        .unwrap();
    crate::routes::router(f.st.clone()).oneshot(request).await.unwrap()
}

async fn json_body(response: Response) -> serde_json::Value {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

async fn assert_denied_routes(f: &Fixture) {
    for (method, uri, body) in [
        ("GET", format!("/api/v1/sync-targets/{}", f.target), json!({})),
        ("DELETE", format!("/api/v1/sync-targets/{}", f.target), json!({})),
        ("POST", format!("/api/v1/sync-targets/{}/sync", f.target), json!({})),
        ("POST", "/api/v1/sync-targets/sync-all".into(), json!({"config_id": f.config})),
        ("POST", "/api/v1/sync-targets".into(), json!({
            "project_id": "allowed", "config_id": f.config, "connection_id": f.connection
        })),
        ("GET", "/api/v1/sync-targets?project_id=allowed".into(), json!({})),
    ] {
        assert_eq!(request(f, method, &uri, body).await.status(), StatusCode::NOT_FOUND, "{method} {uri}");
    }
    let response = request(f, "GET", "/api/v1/sync-targets", json!({})).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json_body(response).await["sync_targets"], json!([]));
    let target = f.st.connection_broker.get_sync_target(&f.st.connection_organization, &f.target).await.unwrap();
    assert!(target.last_synced_at.is_none());
    assert_eq!(target.status, opensesame_connection_broker::SyncTargetStatus::Idle);
}

#[tokio::test]
async fn revoked_host_role_cannot_use_still_valid_admin_session() {
    let f = fixture(true).await;
    config_access::set_role_ceiling(
        f.st.db.pool(), &f.st.connection_organization, &f.principal, None, 1, 0,
    ).await.unwrap();
    assert_denied_routes(&f).await;
}

#[tokio::test]
async fn missing_host_role_cannot_use_admin_session() {
    let mut f = fixture(false).await;
    f.headers = test_session_headers(
        &f.st, &PrincipalId::new().to_string(), f.st.connection_organization, OrganizationRole::Admin,
    );
    assert_denied_routes(&f).await;
}

#[tokio::test]
async fn member_ceiling_without_project_grants_cannot_sync_or_administer() {
    let f = fixture(false).await;
    config_access::set_role_ceiling(
        f.st.db.pool(), &f.st.connection_organization, &f.principal, Some(OrganizationRole::Member), 1, 0,
    ).await.unwrap();
    assert_denied_routes(&f).await;
}

#[tokio::test]
async fn project_keys_do_not_grant_manage_or_access_to_other_projects() {
    let f = fixture(false).await;
    let org = f.st.connection_organization;
    config_access::set_role_ceiling(
        f.st.db.pool(), &org, &f.principal, Some(OrganizationRole::Member), 1, 0,
    ).await.unwrap();
    config_access::set_project_access(
        f.st.db.pool(), &org, &PolicyActor::Operator, "allowed", &f.principal,
        ProjectAccess { metadata_read: true, keys_read: true },
    ).await.unwrap();
    let response = request(&f, "POST", &format!("/api/v1/sync-targets/{}/sync", f.target), json!({})).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json_body(response).await["ok"], true);
    for method in ["GET", "DELETE"] {
        assert_eq!(request(&f, method, &format!("/api/v1/sync-targets/{}", f.target), json!({})).await.status(), StatusCode::NOT_FOUND);
    }
    assert_eq!(request(&f, "POST", &format!("/api/v1/sync-targets/{}/sync", f.other_target), json!({})).await.status(), StatusCode::NOT_FOUND);
    assert_eq!(request(&f, "POST", "/api/v1/sync-targets/sync-all", json!({"config_id": f.other_config})).await.status(), StatusCode::NOT_FOUND);
    let list = request(&f, "GET", "/api/v1/sync-targets", json!({})).await;
    assert_eq!(json_body(list).await["sync_targets"], json!([]));
    assert_eq!(request(&f, "POST", "/api/v1/sync-targets", json!({
        "project_id": "allowed", "config_id": f.config, "connection_id": f.connection
    })).await.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn create_rejects_config_project_mismatch() {
    let f = fixture(false).await;
    assert_eq!(request(&f, "POST", "/api/v1/sync-targets", json!({
        "project_id": "allowed", "config_id": f.other_config, "connection_id": f.connection
    })).await.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn policy_lookup_failure_is_not_a_successful_empty_list() {
    let f = fixture(false).await;
    sqlx::query("DROP TABLE config_project_access").execute(f.st.db.pool()).await.unwrap();
    for (method, uri, body) in [
        ("GET", "/api/v1/sync-targets".to_string(), json!({})),
        ("POST", format!("/api/v1/sync-targets/{}/sync", f.target), json!({})),
        ("POST", "/api/v1/sync-targets/sync-all".into(), json!({"config_id": f.config})),
    ] {
        assert_eq!(request(&f, method, &uri, body).await.status(), StatusCode::SERVICE_UNAVAILABLE);
    }
}

struct CountingSource {
    calls: Arc<AtomicUsize>,
    revoke: Option<(sqlx::SqlitePool, OrganizationId, PrincipalId)>,
}

#[async_trait::async_trait]
impl SyncSecretSource for CountingSource {
    async fn load_config_secrets(
        &self, _: &str, _: &str, _: &str,
    ) -> Result<BTreeMap<String, String>, BrokerError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if let Some((pool, org, principal)) = &self.revoke {
            config_access::set_role_ceiling(pool, org, principal, None, 1, 0).await.unwrap();
        }
        Ok(BTreeMap::new())
    }
}

#[tokio::test]
async fn caller_source_rechecks_on_reuse_and_rejects_other_organizations() {
    let f = fixture(false).await;
    let org = f.st.connection_organization;
    let calls = Arc::new(AtomicUsize::new(0));
    let source = access::CallerSecretSource::new(
        f.st.db.pool().clone(), org,
        PolicyActor::Session { principal: f.principal, role: OrganizationRole::Admin },
        Arc::new(CountingSource { calls: calls.clone(), revoke: None }),
    );
    assert!(source.load_config_secrets(&org.to_string(), "allowed", &f.config).await.is_ok());
    assert!(source.load_config_secrets(&OrganizationId::new().to_string(), "allowed", &f.config).await.is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    config_access::set_role_ceiling(f.st.db.pool(), &org, &f.principal, None, 1, 0).await.unwrap();
    assert!(source.load_config_secrets(&org.to_string(), "allowed", &f.config).await.is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 1, "revoked retry must not reach the inner loader");
}

#[tokio::test]
async fn caller_revocation_during_load_discards_the_snapshot() {
    let f = fixture(false).await;
    let org = f.st.connection_organization;
    let calls = Arc::new(AtomicUsize::new(0));
    let source = access::CallerSecretSource::new(
        f.st.db.pool().clone(), org,
        PolicyActor::Session { principal: f.principal, role: OrganizationRole::Admin },
        Arc::new(CountingSource {
            calls: calls.clone(), revoke: Some((f.st.db.pool().clone(), org, f.principal)),
        }),
    );
    assert!(source.load_config_secrets(&org.to_string(), "allowed", &f.config).await.is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}
