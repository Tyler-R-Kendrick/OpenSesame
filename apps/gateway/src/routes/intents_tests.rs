use super::*;
use axum::http::{HeaderMap, HeaderValue};
use opensesame_domain::{OrganizationId, OrganizationRole};

fn body() -> InvokeBody {
    InvokeBody {
        connection_ref: None,
        connection: None,
        operation: "read".into(),
        resource: "doc:1".into(),
        audience: None,
        parameters: None,
        idempotency_key: None,
        invoke_level: None,
        task_run_id: None,
        intent_digest: None,
    }
}

#[test]
fn a_plain_invoke_is_not_task_bound() {
    assert!(!claims_task_authority(&body(), &HeaderMap::new()));
}

#[test]
fn task_fields_in_the_body_are_detected() {
    let mut b = body();
    b.task_run_id = Some("tsk_1".into());
    assert!(claims_task_authority(&b, &HeaderMap::new()));
    let mut b = body();
    b.intent_digest = Some("sha256:abc".into());
    assert!(claims_task_authority(&b, &HeaderMap::new()));
}

#[test]
fn task_headers_cannot_smuggle_past_the_body_check() {
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-opensesame-intent-digest",
        HeaderValue::from_static("sha256:abc"),
    );
    assert!(claims_task_authority(&body(), &headers));
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-opensesame-task-run-id",
        HeaderValue::from_static("tsk_1"),
    );
    assert!(claims_task_authority(&body(), &headers));
}

#[test]
fn constrained_http_accepts_only_the_host_owned_request_shape() {
    let input = constrained_http_input(&json!({
        "url": "https://api.example.test/items",
        "method": "POST",
        "body": {"name": "one"}
    }))
    .expect("valid constrained request");
    assert_eq!(input.method, "POST");
    assert_eq!(input.url, "https://api.example.test/items");
    assert!(constrained_http_input(&json!({
        "url": "https://api.example.test/items",
        "headers": {"authorization": "attacker-owned"}
    }))
    .is_err());
}

#[tokio::test]
async fn bootstrap_intent_is_hidden_from_another_organization() {
    let state = crate::app_state::test_demo_state().await;
    let headers = crate::app_state::test_session_headers(
        &state,
        &state
            .bootstrap
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .principal
            .to_string(),
        OrganizationId::new(),
        OrganizationRole::Member,
    );

    let response = create(State(state), headers, Json(body())).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn bootstrap_intent_requires_proven_assurance_even_in_its_organization() {
    let state = crate::app_state::test_demo_state().await;
    let organization_id = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let headers = crate::app_state::test_session_headers(
        &state,
        &state
            .bootstrap
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .principal
            .to_string(),
        organization_id,
        OrganizationRole::Member,
    );
    let mut request = body();
    request.operation = "repository.read".into();
    request.resource = "repo:acme/catalog".into();
    request.audience = Some("https://api.github.com".into());
    request.parameters = Some(json!({}));

    let response = create(State(state.clone()), headers.clone(), Json(request)).await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let principal = state
        .bootstrap
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .principal
        .to_string();
    let mut state = state;
    std::sync::Arc::get_mut(&mut state.broker)
        .unwrap()
        .policy
        .assurance
        .insert(principal, "mfa".into());
    let mut request = body();
    request.operation = "repository.read".into();
    request.resource = "repo:acme/catalog".into();
    request.audience = Some("https://api.github.com".into());
    request.parameters = Some(json!({}));
    let response = create(State(state), headers, Json(request)).await;
    assert_eq!(response.status(), StatusCode::OK);
}
