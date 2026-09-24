use super::*;
use crate::app_state::{test_demo_state, test_session_headers};
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use opensesame_connection_broker::config_access::{set_project_access, PolicyActor, ProjectAccess};
use opensesame_connection_broker::{BrokerConfig, ConnectionBroker};
use opensesame_domain::OrganizationRole;
use std::sync::Arc;
use tower::ServiceExt;

const PLAINTEXT: &str = "sw0rdf1sh-route-secret";

#[path = "secret_config_test_support.rs"]
mod support;
use support::{router, send, state_with_seal_key};

#[tokio::test]
async fn config_lifecycle_never_returns_a_value() {
    let st = state_with_seal_key().await;
    let org = st.connection_organization;
    let admin = test_session_headers(&st, P04, org, OrganizationRole::Admin);
    let app = router(st.clone());

    let (status, created) = send(
        &app,
        &admin,
        "POST",
        "/api/v1/projects/proj-1/configs",
        Some(json!({"slug": "development", "environment": "development"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let config_id = created["id"].as_str().unwrap().to_string();

    let (status, put) = send(
        &app,
        &admin,
        "PUT",
        &format!("/api/v1/configs/{config_id}/secrets"),
        Some(json!({"secrets": {"API_KEY": PLAINTEXT, "DB_URL": "postgres://u@h/db"}})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(!put.to_string().contains(PLAINTEXT));
    assert_eq!(put["keys"].as_array().unwrap().len(), 2);

    let (status, keys) = send(
        &app,
        &admin,
        "GET",
        &format!("/api/v1/configs/{config_id}/secrets"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(!keys.to_string().contains(PLAINTEXT));

    // Second write, then versions + rollback; every response stays blind.
    let (_, _) = send(
        &app,
        &admin,
        "PUT",
        &format!("/api/v1/configs/{config_id}/secrets"),
        Some(json!({"secrets": {"API_KEY": "replacement"}})),
    )
    .await;
    let (status, versions) = send(
        &app,
        &admin,
        "GET",
        &format!("/api/v1/configs/{config_id}/secrets/API_KEY/versions"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(versions["versions"].as_array().unwrap().len(), 2);
    assert!(!versions.to_string().contains(PLAINTEXT));

    let (status, rolled) = send(
        &app,
        &admin,
        "POST",
        &format!("/api/v1/configs/{config_id}/secrets/API_KEY/rollback"),
        Some(json!({"to_version": 1})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(rolled["version"].as_u64().unwrap(), 3);
    assert!(!rolled.to_string().contains(PLAINTEXT));

    assert_branch_metadata(&app, &admin, &config_id).await;

    let (status, _) = send(
        &app,
        &admin,
        "DELETE",
        &format!("/api/v1/configs/{config_id}/secrets/DB_URL"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn members_need_explicit_project_and_key_permissions_and_cannot_mutate() {
    let st = state_with_seal_key().await;
    let org = st.connection_organization;
    let admin = test_session_headers(&st, P04, org, OrganizationRole::Admin);
    let member = test_session_headers(&st, P05, org, OrganizationRole::Member);
    let app = router(st.clone());

    let (_, created) = send(
        &app,
        &admin,
        "POST",
        "/api/v1/projects/proj-1/configs",
        Some(json!({"slug": "staging", "environment": "staging"})),
    )
    .await;
    let config_id = created["id"].as_str().unwrap();

    let principal = crate::session_claims::parse_principal(P05).unwrap();
    permit_project_metadata(&st, &principal, false).await;
    let (status, _) = send(
        &app,
        &member,
        "GET",
        &format!("/api/v1/configs/{config_id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, hidden) = send(
        &app,
        &member,
        "GET",
        &format!("/api/v1/configs/{config_id}/secrets"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (_, missing) = send(
        &app,
        &member,
        "GET",
        "/api/v1/configs/nonexistent/secrets",
        None,
    )
    .await;
    assert_eq!(hidden, missing);
    permit_project_metadata(&st, &principal, true).await;

    let (status, _) = send(
        &app,
        &member,
        "GET",
        &format!("/api/v1/configs/{config_id}/secrets"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _) = send(
        &app,
        &member,
        "PUT",
        &format!("/api/v1/configs/{config_id}/secrets"),
        Some(json!({"secrets": {"K": "v"}})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, _) = send(
        &app,
        &member,
        "POST",
        "/api/v1/projects/proj-1/configs",
        Some(json!({"slug": "nope", "environment": "custom"})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    opensesame_connection_broker::config_access::set_role_ceiling(
        st.db.pool(),
        &org,
        &principal,
        None,
        1,
        10,
    )
    .await
    .unwrap();
    let (status, _) = send(
        &app,
        &member,
        "GET",
        &format!("/api/v1/configs/{config_id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn sync_with_stored_values_fails_closed_without_leaking() {
    use opensesame_connection_broker::{CreateConnection, CreateSyncTarget};
    let st = state_with_seal_key().await;
    let org = st.connection_organization;
    let admin = test_session_headers(&st, P04, org, OrganizationRole::Admin);
    let app = router(st.clone());

    let (_, created) = send(
        &app,
        &admin,
        "POST",
        "/api/v1/projects/proj-sync/configs",
        Some(json!({"slug": "production", "environment": "production"})),
    )
    .await;
    let config_id = created["id"].as_str().unwrap().to_string();
    let (_, _) = send(
        &app,
        &admin,
        "PUT",
        &format!("/api/v1/configs/{config_id}/secrets"),
        Some(json!({"secrets": {"API_KEY": PLAINTEXT}})),
    )
    .await;

    let connection = st
        .connection_broker
        .create_connection(
            &org,
            CreateConnection {
                provider_id: "vercel".into(),
                integration_id: None,
                owner_subject: Some(P04.into()),
                display_name: Some("Vercel".into()),
                logical_name: None,
                project_id: Some("proj-sync".into()),
                scopes: None,
                shareability: None,
            },
        )
        .await
        .unwrap();
    st.connection_broker
        .set_api_key(&org, &connection.connection_id, "vercel_live_token")
        .await
        .unwrap();
    let target = st
        .connection_broker
        .create_sync_target(
            &org,
            CreateSyncTarget {
                project_id: "proj-sync".into(),
                config_id: config_id.clone(),
                connection_id: connection.connection_id.clone(),
                operation: Some("env.set".into()),
            },
        )
        .await
        .unwrap();

    // Egress to api.vercel.com cannot succeed here; what matters is that
    // the failure surface — status detail, response body, bus events —
    // never carries the stored value or the connection token.
    let (status, outcome) = send(
        &app,
        &admin,
        "POST",
        &format!("/api/v1/sync-targets/{}/sync", target.id),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let text = outcome.to_string();
    assert!(!text.contains(PLAINTEXT));
    assert!(!text.contains("vercel_live_token"));

    let events = st.task_bus.read().await.drain(20).await.unwrap();
    for event in &events {
        let data = event.data.to_string();
        assert!(!data.contains(PLAINTEXT));
        assert!(!data.contains("vercel_live_token"));
    }
}

async fn assert_branch_metadata(app: &Router, admin: &axum::http::HeaderMap, config_id: &str) {
    // Branch inherits environment and parent linkage.
    let (status, child) = send(
        app,
        admin,
        "POST",
        &format!("/api/v1/configs/{config_id}/branch"),
        Some(json!({"slug": "dev-tyler"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(child["parent_config_id"].as_str().unwrap(), config_id);

    // Compare is presence + versions only.
    let child_id = child["id"].as_str().unwrap();
    let (status, diff) = send(
        app,
        admin,
        "GET",
        &format!("/api/v1/configs/{config_id}/compare/{child_id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(diff["only_in_a"].as_array().unwrap().len(), 2);
    assert!(!diff.to_string().contains(PLAINTEXT));
}

async fn permit_project_metadata(
    st: &AppState,
    principal: &opensesame_domain::PrincipalId,
    keys_read: bool,
) {
    set_project_access(
        st.db.pool(),
        &st.connection_organization,
        &PolicyActor::Operator,
        "proj-1",
        principal,
        ProjectAccess {
            metadata_read: true,
            keys_read,
        },
    )
    .await
    .unwrap();
}
