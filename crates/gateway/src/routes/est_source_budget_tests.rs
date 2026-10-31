//! An unauthenticated network peer cannot lock every client of an EST profile.
use super::{basic, router, router_without_source, sealed_state, seed_self_signed_profile};
use crate::app_state::{test_env, AppState};
use axum::{
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode},
};
use std::net::SocketAddr;
use tower::ServiceExt;

async fn password_request(
    state: &AppState,
    profile: &str,
    endpoint: &str,
    address: &str,
    password: &str,
) -> StatusCode {
    let mut request = Request::post(format!("/.well-known/est/{profile}/{endpoint}"))
        .header(axum::http::header::AUTHORIZATION, basic("est", password))
        .body(Body::from("not a csr"))
        .unwrap();
    request
        .extensions_mut()
        .insert(ConnectInfo(address.parse::<SocketAddr>().unwrap()));
    router(state.clone())
        .oneshot(request)
        .await
        .unwrap()
        .status()
}

#[tokio::test]
async fn exhausted_attacker_does_not_lock_a_distinct_legitimate_network_peer() {
    let _guard = test_env::lock();
    let state = sealed_state().await;
    let profile = seed_self_signed_profile(&state, "random-value-16b").await;
    for index in 0..5 {
        let endpoint = ["simpleenroll", "simplereenroll"][index % 2];
        assert_eq!(
            password_request(&state, &profile, endpoint, "192.0.2.1:4000", "wrong").await,
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        password_request(&state, &profile, "simpleenroll", "192.0.2.1:5000", "wrong").await,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        password_request(
            &state,
            &profile,
            "simplereenroll",
            "192.0.2.2:6000",
            "random-value-16b"
        )
        .await,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn concurrent_sources_have_separate_budgets_and_nat_clients_share_them() {
    let _guard = test_env::lock();
    let state = sealed_state().await;
    let profile = seed_self_signed_profile(&state, "random-value-16b").await;
    let attempts = (0..32).map(|index| {
        let state = state.clone();
        let profile = profile.clone();
        async move {
            let address = format!("192.0.2.{}:{}", index % 2 + 1, index + 3000);
            password_request(
                &state,
                &profile,
                ["simpleenroll", "simplereenroll"][index % 2],
                &address,
                "wrong",
            )
            .await
        }
    });
    let responses = futures::future::join_all(attempts).await;
    assert_eq!(
        responses
            .iter()
            .filter(|status| **status == StatusCode::UNAUTHORIZED)
            .count(),
        10
    );
    assert_eq!(
        responses
            .iter()
            .filter(|status| **status == StatusCode::TOO_MANY_REQUESTS)
            .count(),
        22
    );
    // Ports and IPv4-mapped IPv6 spellings cannot give clients sharing this
    // NAT a new allowance, even when they know the correct password.
    assert_eq!(
        password_request(
            &state,
            &profile,
            "simpleenroll",
            "[::ffff:192.0.2.1]:9000",
            "random-value-16b"
        )
        .await,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        password_request(
            &state,
            &profile,
            "simpleenroll",
            "192.0.2.3:9000",
            "random-value-16b"
        )
        .await,
        StatusCode::BAD_REQUEST
    );
    let tags: Vec<String> = sqlx::query_scalar("SELECT source_tag FROM est_source_attempt_budgets")
        .fetch_all(state.db.pool())
        .await
        .unwrap();
    assert_eq!(tags.len(), 3);
    assert!(tags
        .iter()
        .all(|tag| tag.len() == 64 && !tag.contains("192.0.2")));
}

#[tokio::test]
async fn missing_socket_evidence_and_forged_headers_cannot_create_a_budget() {
    let _guard = test_env::lock();
    let state = sealed_state().await;
    let profile = seed_self_signed_profile(&state, "random-value-16b").await;
    for endpoint in ["simpleenroll", "simplereenroll"] {
        let request = Request::post(format!("/.well-known/est/{profile}/{endpoint}"))
            .header(
                axum::http::header::AUTHORIZATION,
                basic("est", "random-value-16b"),
            )
            .header("x-forwarded-for", "192.0.2.1")
            .header("forwarded", "for=192.0.2.2")
            .header("x-real-ip", "192.0.2.3")
            .header("client-cert", "forged-client")
            .body(Body::from("not a csr"))
            .unwrap();
        assert_eq!(
            router_without_source(state.clone())
                .oneshot(request)
                .await
                .unwrap()
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM est_source_attempt_budgets")
        .fetch_one(state.db.pool())
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn requests_without_a_password_never_consume_password_attempts() {
    let _guard = test_env::lock();
    let state = sealed_state().await;
    let profile = seed_self_signed_profile(&state, "random-value-16b").await;
    for _ in 0..8 {
        let request = Request::post(format!("/.well-known/est/{profile}/simpleenroll"))
            .body(Body::from("not a csr"))
            .unwrap();
        assert_eq!(
            router(state.clone())
                .oneshot(request)
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        password_request(
            &state,
            &profile,
            "simpleenroll",
            "192.0.2.10:4000",
            "random-value-16b"
        )
        .await,
        StatusCode::BAD_REQUEST
    );
    let attempts: i64 = sqlx::query_scalar("SELECT attempts FROM est_source_attempt_budgets")
        .fetch_one(state.db.pool())
        .await
        .unwrap();
    assert_eq!(attempts, 1);
}
