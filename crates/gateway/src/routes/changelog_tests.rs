use axum::body::Body;
use axum::http::{HeaderMap, Request, StatusCode};
use opensesame_domain::OrganizationRole;
use tower::ServiceExt;

async fn app() -> (axum::Router, crate::app_state::AppState) {
    let state = crate::app_state::test_demo_state().await;
    let router = crate::routes::router(state.clone());
    (router, state)
}

fn with_headers(mut request: Request<Body>, headers: &HeaderMap) -> Request<Body> {
    for (name, value) in headers {
        request.headers_mut().insert(name, value.clone());
    }
    request
}

async fn post_record(
    router: axum::Router,
    headers: HeaderMap,
    project: String,
    key_name: &'static str,
    version: String,
) -> axum::response::Response {
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/changelog")
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::json!({
                "event_type": "secret.value.changed",
                "project_id": project,
                "key_names": [key_name],
                "version_id": version,
            })
            .to_string(),
        ))
        .unwrap();
    router
        .oneshot(with_headers(request, &headers))
        .await
        .unwrap()
}

#[tokio::test]
async fn list_returns_metadata_without_secret_values() {
    let (router, state) = app().await;
    let boot = state.bootstrap.lock().unwrap().clone().unwrap();
    let headers = policy_headers(
        &state,
        &format!("prn_{}", boot.principal.as_uuid()),
        boot.org,
        OrganizationRole::Owner,
    )
    .await;

    let mut record_headers = headers.clone();
    record_headers.insert(
        axum::http::header::CONTENT_TYPE,
        "application/json".parse().unwrap(),
    );
    let record_request = Request::builder()
        .method("POST")
        .uri("/api/v1/changelog")
        .body(Body::from(
            serde_json::json!({
                "event_type": "secret.value.changed",
                "project_id": boot.project.to_string(),
                "config_id": "cfg_1",
                "environment": "production",
                "key_names": ["API_TOKEN"],
                "version_id": "ver_1",
                "metadata": {
                    "value": "must-not-appear",
                    "password": "nope",
                    "token": "leak"
                }
            })
            .to_string(),
        ))
        .unwrap();
    let record_request = with_headers(record_request, &record_headers);
    let record_response = router.clone().oneshot(record_request).await.unwrap();
    assert_eq!(record_response.status(), StatusCode::CREATED);
    let record_body = axum::body::to_bytes(record_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let record_json: serde_json::Value = serde_json::from_slice(&record_body).unwrap();
    let record_text = record_json.to_string();
    assert!(!record_text.contains("must-not-appear"));
    assert!(!record_text.contains("nope"));
    assert!(!record_text.contains("leak"));

    let list_request = Request::builder()
        .method("GET")
        .uri(format!(
            "/api/v1/projects/{}/changelog?limit=10",
            boot.project
        ))
        .body(Body::empty())
        .unwrap();
    let list_request = with_headers(list_request, &headers);
    let list_response = router.oneshot(list_request).await.unwrap();
    assert_eq!(list_response.status(), StatusCode::OK);
    let list_body = axum::body::to_bytes(list_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let list_json: serde_json::Value = serde_json::from_slice(&list_body).unwrap();
    let events = list_json["events"].as_array().expect("events");
    assert!(!events.is_empty());
    let text = list_json.to_string();
    assert!(!text.contains("must-not-appear"));
    assert_eq!(events[0]["event_type"], "secret.value.changed");
    assert_eq!(events[0]["key_names"][0], "API_TOKEN");
}

#[tokio::test]
async fn list_requires_auth() {
    let (router, _) = app().await;
    let request = Request::builder()
        .method("GET")
        .uri("/api/v1/projects/project_x/changelog")
        .body(Body::empty())
        .unwrap();
    let response = router.oneshot(request).await.unwrap();
    assert!(
        response.status() == StatusCode::UNAUTHORIZED || response.status() == StatusCode::FORBIDDEN,
        "unexpected status {}",
        response.status()
    );
}

#[tokio::test]
async fn list_does_not_leak_another_organization_changelog() {
    let (router, state) = app().await;
    let boot = state.bootstrap.lock().unwrap().clone().unwrap();
    let owner = policy_headers(
        &state,
        &format!("prn_{}", boot.principal.as_uuid()),
        boot.org,
        OrganizationRole::Owner,
    )
    .await;
    let mut record_headers = owner.clone();
    record_headers.insert(
        axum::http::header::CONTENT_TYPE,
        "application/json".parse().unwrap(),
    );
    let record_request = Request::builder()
        .method("POST")
        .uri("/api/v1/changelog")
        .body(Body::from(
            serde_json::json!({
                "event_type": "secret.value.changed",
                "project_id": boot.project.to_string(),
                "key_names": ["DATABASE_URL"]
            })
            .to_string(),
        ))
        .unwrap();
    let record_request = with_headers(record_request, &record_headers);
    let record_response = router.clone().oneshot(record_request).await.unwrap();
    assert_eq!(record_response.status(), StatusCode::CREATED);

    let foreign = opensesame_domain::OrganizationId::new();
    let other = policy_headers(
        &state,
        "principal:00000000-0000-4000-8000-000000000017",
        foreign,
        OrganizationRole::Owner,
    )
    .await;
    let list_request = Request::builder()
        .method("GET")
        .uri(format!(
            "/api/v1/projects/{}/changelog?limit=10",
            boot.project
        ))
        .body(Body::empty())
        .unwrap();
    let list_request = with_headers(list_request, &other);
    let list_response = router.oneshot(list_request).await.unwrap();
    assert_eq!(list_response.status(), StatusCode::OK);
    let list_body = axum::body::to_bytes(list_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let list_json: serde_json::Value = serde_json::from_slice(&list_body).unwrap();
    let events = list_json["events"].as_array().expect("events");
    assert!(events.is_empty(), "cross-tenant changelog must be empty");
    assert!(!list_json.to_string().contains("DATABASE_URL"));
}

#[tokio::test]
async fn record_rejects_unknown_event_types() {
    let (router, state) = app().await;
    let boot = state.bootstrap.lock().unwrap().clone().unwrap();
    let mut headers = policy_headers(
        &state,
        &format!("prn_{}", boot.principal.as_uuid()),
        boot.org,
        OrganizationRole::Owner,
    )
    .await;
    headers.insert(
        axum::http::header::CONTENT_TYPE,
        "application/json".parse().unwrap(),
    );
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/changelog")
        .body(Body::from(
            serde_json::json!({
                "event_type": "secret.value.exfiltrated",
                "project_id": boot.project.to_string()
            })
            .to_string(),
        ))
        .unwrap();
    let request = with_headers(request, &headers);
    let response = router.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn concurrent_records_from_two_orgs_never_mix() {
    let (router, state) = app().await;
    let project = state
        .bootstrap
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .project
        .to_string();
    let org_a = policy_headers(
        &state,
        "principal:00000000-0000-4000-8000-000000000018",
        opensesame_domain::OrganizationId::new(),
        OrganizationRole::Owner,
    )
    .await;
    let org_b = policy_headers(
        &state,
        "principal:00000000-0000-4000-8000-000000000019",
        opensesame_domain::OrganizationId::new(),
        OrganizationRole::Owner,
    )
    .await;
    let mut joins = Vec::new();
    for i in 0..16 {
        joins.push(tokio::spawn(post_record(
            router.clone(),
            org_a.clone(),
            project.clone(),
            "ORG_A_KEY",
            format!("v{i}"),
        )));
        joins.push(tokio::spawn(post_record(
            router.clone(),
            org_b.clone(),
            project.clone(),
            "ORG_B_KEY",
            format!("v{i}"),
        )));
    }
    for join in joins {
        assert_eq!(join.await.unwrap().status(), StatusCode::CREATED);
    }
    for (headers, forbidden) in [(&org_a, "ORG_B_KEY"), (&org_b, "ORG_A_KEY")] {
        let list_request = Request::builder()
            .method("GET")
            .uri(format!("/api/v1/projects/{project}/changelog?limit=200"))
            .body(Body::empty())
            .unwrap();
        let list_request = with_headers(list_request, headers);
        let response = router.clone().oneshot(list_request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let text = json.to_string();
        assert!(!text.contains(forbidden), "{text}");
        assert_eq!(json["events"].as_array().unwrap().len(), 16);
    }
}
async fn policy_headers(
    state: &crate::app_state::AppState,
    subject: &str,
    org: opensesame_domain::OrganizationId,
    role: OrganizationRole,
) -> HeaderMap {
    let principal = crate::middleware::auth::parse_principal(subject).unwrap();
    opensesame_connection_broker::config_access::set_role_ceiling(
        state.db.pool(),
        &org,
        &principal,
        Some(role),
        0,
        0,
    )
    .await
    .unwrap();
    crate::app_state::test_session_headers(state, subject, org, role)
}
