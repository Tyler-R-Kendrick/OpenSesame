use std::collections::BTreeMap;

use crate::app_state::{self, test_env, test_session_headers, AppState};
use crate::config::Args;
use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use serde_json::{json, Value};
use tower::ServiceExt;

fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    test_env::lock()
}

async fn memory_state() -> AppState {
    app_state::build_test(Args {
        listen: "127.0.0.1:0".parse().unwrap(),
        resource: "https://opensesame.local".into(),
        issuer: "https://issuer.local".into(),
        database_url: "sqlite::memory:".into(),
        task_database_url: String::new(),
    })
    .await
    .unwrap()
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
    let response = crate::routes::router(state.clone())
        .oneshot(request)
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value)
}

#[tokio::test]
async fn owner_session_issues_a_localhost_dev_cert() {
    let _guard = env_lock();
    let state = memory_state().await;
    let headers = test_session_headers(
        &state,
        "principal:00000000-0000-4000-8000-000000000001",
        state.connection_organization,
        opensesame_domain::OrganizationRole::Owner,
    );
    let (status, body) = call(
        &state,
        "POST",
        "/api/v1/certs/issue",
        Some(headers.clone()),
        Some(json!({
            "common_name": "localhost",
            "dns_names": ["localhost"],
            "ip_addrs": ["127.0.0.1"],
            "ttl_hours": 24
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["certificate"]
        .as_str()
        .unwrap()
        .contains("BEGIN CERTIFICATE"));
    assert!(body["private_key"].as_str().unwrap().contains("BEGIN"));
    assert_eq!(body["common_name"], "localhost");
    assert_eq!(body["purpose"], "local_tls");
    assert_eq!(body["trust_scope"], "private_local");
    assert_eq!(body["persistent"], false);

    let (status, ca) = call(
        &state,
        "GET",
        "/api/v1/certs/ca",
        Some(headers.clone()),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{ca}");
    assert_eq!(ca["ca"]["certificate"], body["ca_certificate"]);

    let (status, list) = call(&state, "GET", "/api/v1/certs", Some(headers), None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(list["certificates"][0]["common_name"], "localhost");
    assert!(list["certificates"][0]["private_key"].is_null());
}

#[tokio::test]
async fn adversarial_ephemeral_history_isolated_between_organizations() {
    let _guard = env_lock();
    let state = memory_state().await;
    let issuing_headers = test_session_headers(
        &state,
        "principal:00000000-0000-4000-8000-000000000005",
        state.connection_organization,
        opensesame_domain::OrganizationRole::Owner,
    );
    let (status, body) = call(
        &state,
        "POST",
        "/api/v1/certs/issue",
        Some(issuing_headers),
        Some(json!({"common_name": "tenant-a.local"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let foreign_headers = test_session_headers(
        &state,
        "principal:00000000-0000-4000-8000-000000000004",
        opensesame_domain::OrganizationId::new(),
        opensesame_domain::OrganizationRole::Owner,
    );
    let (status, list) = call(&state, "GET", "/api/v1/certs", Some(foreign_headers), None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(list["certificates"], json!([]));
}

#[tokio::test]
async fn member_cannot_issue() {
    let _guard = env_lock();
    let state = memory_state().await;
    let headers = test_session_headers(
        &state,
        "principal:00000000-0000-4000-8000-000000000002",
        state.connection_organization,
        opensesame_domain::OrganizationRole::Member,
    );
    let (status, _) = call(
        &state,
        "POST",
        "/api/v1/certs/issue",
        Some(headers),
        Some(json!({"common_name": "localhost"})),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn contract_persisted_delivery_retries_until_ack_without_plaintext_ca() {
    let _guard = env_lock();
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();
    std::env::set_var(
        "OPENSESAME_CONNECTION_KEY",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    );
    let state = memory_state().await;
    std::env::remove_var("OPENSESAME_CONNECTION_KEY");
    let mut headers = test_session_headers(
        &state,
        "principal:00000000-0000-4000-8000-000000000001",
        state.connection_organization,
        opensesame_domain::OrganizationRole::Owner,
    );
    headers.insert("idempotency-key", "cert-test-one".parse().unwrap());
    let request = json!({
        "common_name": "localhost",
        "dns_names": ["localhost"],
        "ip_addrs": ["127.0.0.1"],
        "ttl_hours": 24
    });
    let (status, first) = call(
        &state,
        "POST",
        "/api/v1/certs/issue",
        Some(headers.clone()),
        Some(request.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(first["persistent"], true);
    let delivery_id = first["delivery_id"].as_str().unwrap();

    let (status, retry) = call(
        &state,
        "POST",
        "/api/v1/certs/issue",
        Some(headers.clone()),
        Some(request.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{retry}");
    assert_eq!(retry["private_key"], first["private_key"]);

    let other_headers = test_session_headers(
        &state,
        "principal:00000000-0000-4000-8000-000000000006",
        state.connection_organization,
        opensesame_domain::OrganizationRole::Owner,
    );
    let (status, _) = call(
        &state,
        "POST",
        &format!("/api/v1/certs/deliveries/{delivery_id}/ack"),
        Some(other_headers),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, _) = call(
        &state,
        "POST",
        &format!("/api/v1/certs/deliveries/{delivery_id}/ack"),
        Some(headers.clone()),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, body) = call(
        &state,
        "POST",
        "/api/v1/certs/issue",
        Some(headers),
        Some(request),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert!(state.db.get_host_kv(super::KV_CA).await.unwrap().is_none());
}

#[tokio::test]
async fn adversarial_external_issuer_failure_never_downgrades_to_private_ca() {
    let _guard = env_lock();
    std::env::set_var(
        "OPENSESAME_CONNECTION_KEY",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    );
    let state = memory_state().await;
    std::env::remove_var("OPENSESAME_CONNECTION_KEY");
    let connection = state
        .connection_broker
        .create_connection(
            &state.connection_organization,
            opensesame_connection_broker::CreateConnection {
                provider_id: "letsencrypt".into(),
                integration_id: None,
                owner_subject: None,
                display_name: None,
                logical_name: None,
                project_id: None,
                scopes: None,
                shareability: None,
            },
        )
        .await
        .unwrap();
    state
        .connection_broker
        .set_connection_configuration(
            &state.connection_organization,
            &connection.connection_id,
            BTreeMap::from([
                ("accept_terms".into(), "true".into()),
                ("environment".into(), "staging".into()),
            ]),
            Vec::new(),
        )
        .await
        .unwrap();
    let headers = test_session_headers(
        &state,
        "principal:00000000-0000-4000-8000-000000000001",
        state.connection_organization,
        opensesame_domain::OrganizationRole::Owner,
    );
    let (status, body) = call(
        &state,
        "POST",
        "/api/v1/certs/issue",
        Some(headers),
        Some(json!({"common_name":"www.example.com"})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"], "dns01_unavailable");
    assert!(state
        .db
        .list_certificate_authorities(&state.connection_organization.to_string())
        .await
        .unwrap()
        .is_empty());
}

/// Registry rows and the IssuerKind-level vocabulary must agree: the
/// registry names/labels are what the wire and receipts carry.
#[test]
fn registry_rows_agree_with_kind_names_and_labels() {
    for descriptor in crate::cert_issuers::EXTERNAL_ISSUERS {
        assert_eq!(
            super::external_issuer_label(descriptor.kind),
            descriptor.label
        );
        // Kind names are snake_case spellings of the provider id.
        assert_eq!(
            super::issuer_kind_name(descriptor.kind),
            descriptor.provider_id.replace('-', "_"),
            "kind name and provider id must stay in lockstep for {}",
            descriptor.provider_id
        );
    }
}
