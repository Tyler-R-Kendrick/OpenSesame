//! Who may reach the lifecycle routes. Trust profiles and revocation by
//! thumbprint are deployment-scoped: an owner or admin of one organization
//! gets `403`, and only the deployment operator gets through. Revoking an
//! organization's own certificate by id, and reading trust, stay with the
//! organization's configurators.

use axum::body::Body;
use axum::http::{HeaderMap, Request, StatusCode};
use opensesame_domain::{OrganizationId, OrganizationRole};
use serde_json::{json, Value};
use tower::ServiceExt as _;

use crate::app_state::AppState;
use crate::transport_lifecycle::test_support as support;

const TRUST: &str = "/api/v1/operator/transport/trust";
const REVOKE: &str = "/api/v1/operator/transport/certificates/revoke";

fn admin(state: &AppState, role: OrganizationRole) -> HeaderMap {
    crate::app_state::test_session_headers(
        state,
        crate::test_principals::P01,
        OrganizationId::new(),
        role,
    )
}

fn operator(state: &AppState) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-opensesame-operator",
        state.operator_token.parse().expect("header"),
    );
    headers
}

async fn call(
    state: &AppState,
    method: &str,
    path: &str,
    headers: HeaderMap,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(path);
    for (name, value) in &headers {
        builder = builder.header(name, value);
    }
    let body = match body {
        Some(body) => {
            builder = builder.header("content-type", "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    let response = super::routes::routes()
        .with_state(state.clone())
        .oneshot(builder.body(body).expect("request"))
        .await
        .expect("response");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 128 * 1024)
        .await
        .expect("body");
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn thumbprint_revoke() -> Value {
    json!({ "thumbprint": "a".repeat(64), "reason": "key_compromise" })
}

fn empty_trust() -> Value {
    json!({ "revision": 0, "profiles": [] })
}

#[tokio::test]
async fn an_organization_admin_cannot_write_deployment_scoped_trust_or_revoke_by_thumbprint() {
    let state = support::state().await;
    for role in [OrganizationRole::Admin, OrganizationRole::Owner] {
        let (status, body) = call(
            &state,
            "PUT",
            TRUST,
            admin(&state, role),
            Some(empty_trust()),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "trust PUT as {role:?}");
        assert_eq!(body["error"], "forbidden");

        let (status, body) = call(
            &state,
            "POST",
            REVOKE,
            admin(&state, role),
            Some(thumbprint_revoke()),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::FORBIDDEN,
            "thumbprint revoke as {role:?}"
        );
        assert_eq!(body["error"], "forbidden");
    }
    // Nothing was denied and nothing was stored on their say-so.
    assert!(!state.transport_lifecycle.is_denied(&"a".repeat(64)));
    assert_eq!(
        crate::transport_lifecycle::trust::load(&state)
            .await
            .expect("load")
            .revision,
        0
    );
}

#[tokio::test]
async fn the_deployment_operator_may_write_trust_and_revoke_by_thumbprint() {
    let state = support::state().await;
    let (status, body) = call(&state, "PUT", TRUST, operator(&state), Some(empty_trust())).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["trust"]["revision"], 1);

    let (status, body) = call(
        &state,
        "POST",
        REVOKE,
        operator(&state),
        Some(thumbprint_revoke()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(state.transport_lifecycle.is_denied(&"a".repeat(64)));
}

/// The organization-scoped half is unchanged: an admin still reads trust and
/// still reaches revocation of its own certificate by id (absent here, so a
/// 404 from the organization-fenced lookup — not a 403 from the gate).
#[tokio::test]
async fn an_organization_admin_keeps_its_organization_scoped_routes() {
    let state = support::state().await;
    let (status, _) = call(
        &state,
        "GET",
        TRUST,
        admin(&state, OrganizationRole::Admin),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _) = call(
        &state,
        "POST",
        REVOKE,
        admin(&state, OrganizationRole::Admin),
        Some(json!({ "certificate_id": "cert:absent", "reason": "superseded" })),
    )
    .await;
    assert_ne!(status, StatusCode::FORBIDDEN);
    assert_ne!(status, StatusCode::UNAUTHORIZED);
}
