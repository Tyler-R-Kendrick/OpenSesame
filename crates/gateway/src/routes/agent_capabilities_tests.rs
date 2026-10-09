use super::*;
use crate::app_state::{test_demo_state, AppState};
use crate::test_principals::P23;
use axum::body::Body;
use axum::http::Request;
use tower::ServiceExt;

const RAW: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/// What the guard caches after one accepted agent request: agent claims under a
/// narrow ceiling, keyed by the token digest.
fn cache_agent_claims(st: &AppState) {
    let mut claims = crate::session_claims::fixture(
        parse_principal(P23).unwrap(),
        st.connection_organization,
        OrganizationRole::Member,
        &st.resource,
    );
    claims.credential_kind = CredentialKind::AgentCapability;
    claims.capability_ceiling = vec!["host.tasks.read".into()];
    st.sessions.lock().unwrap().insert(hash_secret(RAW), claims);
}

async fn status(st: &AppState, method: &str, uri: &str, authorization: &str) -> StatusCode {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .header("authorization", authorization)
        .body(Body::from("{}"))
        .unwrap();
    crate::routes::router(st.clone())
        .oneshot(request)
        .await
        .unwrap()
        .status()
}

#[tokio::test]
async fn a_cached_agent_token_never_passes_as_a_session_under_another_spelling() {
    let st = test_demo_state().await;
    cache_agent_claims(&st);
    for scheme in ["bearer", "BEARER", "Bearer ", "DPoP"] {
        let authorization = format!("{scheme} agent-capability:{RAW}");
        for (method, uri) in [
            ("GET", "/api/v1/connections"),
            ("POST", "/api/v1/delegations"),
            ("POST", "/api/v1/relay/requests/x/approve"),
            ("GET", "/api/v1/tasks"),
        ] {
            assert_eq!(
                status(&st, method, uri, &authorization).await,
                StatusCode::UNAUTHORIZED,
                "{authorization} {method} {uri}"
            );
        }
    }
}

#[tokio::test]
async fn session_authenticator_refuses_non_canonical_agent_spelling() {
    let st = test_demo_state().await;
    cache_agent_claims(&st);
    let mut headers = HeaderMap::new();
    headers.insert(
        "authorization",
        format!("bearer agent-capability:{RAW}").parse().unwrap(),
    );
    assert!(crate::middleware::auth::require_session(&st, &headers).is_err());
    headers.insert(
        "authorization",
        format!("Bearer agent-capability:{RAW}").parse().unwrap(),
    );
    assert!(crate::middleware::auth::require_session(&st, &headers).is_ok());
}
