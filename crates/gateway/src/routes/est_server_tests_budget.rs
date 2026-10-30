//! Attempt limits are shared by both public EST password-verification routes.
use super::{basic, router, sealed_state, seed_self_signed_profile};
use crate::app_state::test_env;
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use tower::ServiceExt;

#[tokio::test]
async fn parallel_enroll_and_reenroll_guesses_share_one_budget() {
    let _guard = test_env::lock();
    let state = sealed_state().await;
    let profile_id = seed_self_signed_profile(&state, "random-value-16b").await;
    let app = router(state.clone());
    let attempts = (0..16).map(|index| {
        let app = app.clone();
        let profile_id = profile_id.clone();
        let route = ["simpleenroll", "simplereenroll"][index % 2];
        async move {
            app.oneshot(
                Request::post(format!("/.well-known/est/{profile_id}/{route}"))
                    .header(
                        axum::http::header::AUTHORIZATION,
                        basic("rotating-user", "wrong"),
                    )
                    .header("x-forwarded-for", format!("192.0.2.{index}"))
                    .body(Body::from("not a csr"))
                    .unwrap(),
            )
            .await
            .unwrap()
            .status()
        }
    });
    let statuses = futures::future::join_all(attempts).await;
    assert_eq!(
        statuses
            .iter()
            .filter(|status| **status == StatusCode::UNAUTHORIZED)
            .count(),
        5
    );
    assert_eq!(
        statuses
            .iter()
            .filter(|status| **status == StatusCode::TOO_MANY_REQUESTS)
            .count(),
        11
    );
    let events = state.task_bus.read().await.drain(100).await.unwrap();
    let exhausted: Vec<_> = events
        .iter()
        .filter(|event| event.r#type == "certmgr.est.verification_budget_exhausted")
        .collect();
    assert_eq!(exhausted.len(), 1);
    assert_eq!(exhausted[0].data["secrets_returned"], false);
    let payload = exhausted[0].data.to_string();
    assert!(!payload.contains("random-value-16b"));
    assert!(!payload.contains("wrong"));
    // Reconstructing the router and guessing the actual password cannot
    // bypass the shared durable reservation or reach CSR parsing.
    let response = router(state)
        .oneshot(
            Request::post(format!("/.well-known/est/{profile_id}/simpleenroll"))
                .header(
                    axum::http::header::AUTHORIZATION,
                    basic("est", "random-value-16b"),
                )
                .body(Body::from("not a csr"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(response.headers()[axum::http::header::RETRY_AFTER], "600");
}

#[tokio::test]
async fn exhausted_password_budget_does_not_block_bootstrap_certificates() {
    let _guard = test_env::lock();
    let state = sealed_state().await;
    let profile_id = seed_self_signed_profile(&state, "1858").await;
    let organization = state.connection_organization.to_string();
    let mut config = state
        .db
        .get_est_config(&organization, &profile_id)
        .await
        .unwrap()
        .unwrap();
    config.require_bootstrap = true;
    assert!(state.db.update_est_config(&config).await.unwrap());
    let app = router(state.clone());
    for _ in 0..8 {
        let response = app
            .clone()
            .oneshot(
                Request::post(format!("/.well-known/est/{profile_id}/simpleenroll"))
                    .header(axum::http::header::AUTHORIZATION, basic("est", "1858"))
                    .body(Body::from("not a csr"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    // A password is never examined without the mandatory certificate.
    let now = chrono::Utc::now().timestamp();
    for attempt in 1..=5 {
        assert_eq!(
            state
                .db
                .admit_est_passphrase_attempt(&organization, &config.id, now)
                .await
                .unwrap(),
            Some(attempt)
        );
    }
    let verified = crate::transport::test_support::peer(
        "enrollee.test",
        crate::transport::test_support::THUMB_A,
        1,
    );
    let mut request = Request::post(format!("/.well-known/est/{profile_id}/simpleenroll"))
        .body(Body::from("not a csr"))
        .unwrap();
    request
        .extensions_mut()
        .insert(opensesame_transport_security::PeerExtension(
            std::sync::Arc::new(verified),
        ));
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
    assert!(String::from_utf8_lossy(&body).contains("\"csr_invalid\""));
}

#[tokio::test]
async fn password_verification_fails_closed_when_budget_storage_fails() {
    let _guard = test_env::lock();
    let state = sealed_state().await;
    let profile_id = seed_self_signed_profile(&state, "random-value-16b").await;
    sqlx::query("CREATE TRIGGER reject_est_attempt BEFORE UPDATE OF passphrase_attempts ON est_configs BEGIN SELECT RAISE(ABORT, 'budget unavailable'); END")
        .execute(state.db.pool()).await.unwrap();
    let response = router(state)
        .oneshot(
            Request::post(format!("/.well-known/est/{profile_id}/simpleenroll"))
                .header(
                    axum::http::header::AUTHORIZATION,
                    basic("est", "random-value-16b"),
                )
                .body(Body::from("not a csr"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
}

#[tokio::test]
async fn newly_configured_passwords_cannot_be_empty_or_short_and_omission_keeps_the_budget() {
    let _guard = test_env::lock();
    let state = sealed_state().await;
    let profile_id = seed_self_signed_profile(&state, "1858").await;
    let headers = crate::app_state::test_session_headers(
        &state,
        "principal:00000000-0000-4000-8000-000000000001",
        state.connection_organization,
        opensesame_domain::OrganizationRole::Owner,
    );
    let app = router(state.clone());
    for passphrase in ["", "1858", "123456789012345", "random-value-16b"] {
        let mut request = Request::put(format!("/api/v1/certmgr/profiles/{profile_id}/est-config"))
            .body(Body::from(
                serde_json::json!({"passphrase":passphrase}).to_string(),
            ))
            .unwrap();
        *request.headers_mut() = headers.clone();
        request.headers_mut().insert(
            axum::http::header::CONTENT_TYPE,
            "application/json".parse().unwrap(),
        );
        let response = app.clone().oneshot(request).await.unwrap();
        let expected = if passphrase.len() < 16 {
            StatusCode::BAD_REQUEST
        } else {
            StatusCode::OK
        };
        assert_eq!(response.status(), expected);
    }
    let organization = state.connection_organization.to_string();
    let config = state
        .db
        .get_est_config(&organization, &profile_id)
        .await
        .unwrap()
        .unwrap();
    let now = chrono::Utc::now().timestamp();
    for _ in 0..5 {
        assert!(state
            .db
            .admit_est_passphrase_attempt(&organization, &config.id, now)
            .await
            .unwrap()
            .is_some());
    }
    let mut request = Request::put(format!("/api/v1/certmgr/profiles/{profile_id}/est-config"))
        .body(Body::from("{}"))
        .unwrap();
    *request.headers_mut() = headers;
    request.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        "application/json".parse().unwrap(),
    );
    assert_eq!(app.oneshot(request).await.unwrap().status(), StatusCode::OK);
    let updated = state
        .db
        .get_est_config(&organization, &profile_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(config.sealed_passphrase, updated.sealed_passphrase);
    assert_eq!(
        state
            .db
            .admit_est_passphrase_attempt(&organization, &config.id, now)
            .await
            .unwrap(),
        None
    );
}

#[tokio::test]
async fn password_rotation_never_silently_removes_required_certificate_authentication() {
    let _guard = test_env::lock();
    let state = sealed_state().await;
    let profile_id = seed_self_signed_profile(&state, "1858").await;
    let organization = state.connection_organization.to_string();
    let mut config = state
        .db
        .get_est_config(&organization, &profile_id)
        .await
        .unwrap()
        .unwrap();
    config.require_bootstrap = true;
    assert!(state.db.update_est_config(&config).await.unwrap());
    let headers = crate::app_state::test_session_headers(
        &state,
        "principal:00000000-0000-4000-8000-000000000001",
        state.connection_organization,
        opensesame_domain::OrganizationRole::Owner,
    );
    let app = router(state.clone());
    for newly_created in [false, true] {
        if newly_created {
            assert!(state
                .db
                .delete_est_config(&organization, &config.id)
                .await
                .unwrap());
        }
        let mut request = Request::put(format!("/api/v1/certmgr/profiles/{profile_id}/est-config"))
            .body(Body::from(r#"{"passphrase":"random-value-16b"}"#))
            .unwrap();
        *request.headers_mut() = headers.clone();
        request.headers_mut().insert(
            axum::http::header::CONTENT_TYPE,
            "application/json".parse().unwrap(),
        );
        assert_eq!(
            app.clone().oneshot(request).await.unwrap().status(),
            StatusCode::OK
        );
        let stored = state
            .db
            .get_est_config(&organization, &profile_id)
            .await
            .unwrap()
            .unwrap();
        assert!(stored.require_bootstrap);
        let response = app
            .clone()
            .oneshot(
                Request::post(format!("/.well-known/est/{profile_id}/simpleenroll"))
                    .header(
                        axum::http::header::AUTHORIZATION,
                        basic("est", "random-value-16b"),
                    )
                    .body(Body::from("not a csr"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    let mut request = Request::put(format!("/api/v1/certmgr/profiles/{profile_id}/est-config"))
        .body(Body::from(r#"{"require_bootstrap":false}"#))
        .unwrap();
    *request.headers_mut() = headers;
    request.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        "application/json".parse().unwrap(),
    );
    assert_eq!(app.oneshot(request).await.unwrap().status(), StatusCode::OK);
    assert!(
        !state
            .db
            .get_est_config(&organization, &profile_id)
            .await
            .unwrap()
            .unwrap()
            .require_bootstrap
    );
}
