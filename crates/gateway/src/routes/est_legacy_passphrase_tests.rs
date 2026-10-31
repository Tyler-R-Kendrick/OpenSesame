//! Legacy weak enrollment passwords cannot remain a persistent authenticator.
use super::{basic, router, sealed_state, seed_self_signed_profile};
use crate::app_state::{test_env, test_session_headers};
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use tower::ServiceExt;

#[tokio::test]
async fn weak_stored_passwords_fail_on_the_first_attempt_while_certificates_still_work() {
    let _guard = test_env::lock();
    for passphrase in ["", "1858", "123456789012345"] {
        let state = sealed_state().await;
        let profile_id = seed_self_signed_profile(&state, passphrase).await;
        let app = router(state);
        for endpoint in ["simpleenroll", "simplereenroll"] {
            let response = app
                .clone()
                .oneshot(
                    Request::post(format!("/.well-known/est/{profile_id}/{endpoint}"))
                        .header(axum::http::header::AUTHORIZATION, basic("est", passphrase))
                        .body(Body::from("not a csr"))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
            assert!(!response
                .headers()
                .contains_key(axum::http::header::RETRY_AFTER));
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
}

#[tokio::test]
async fn an_operator_can_rotate_a_disabled_legacy_password_to_a_supported_credential() {
    let _guard = test_env::lock();
    let state = sealed_state().await;
    let profile_id = seed_self_signed_profile(&state, "1858").await;
    let headers = test_session_headers(
        &state,
        "principal:00000000-0000-4000-8000-000000000001",
        state.connection_organization,
        opensesame_domain::OrganizationRole::Owner,
    );
    let app = router(state);
    let refused = app
        .clone()
        .oneshot(
            Request::post(format!("/.well-known/est/{profile_id}/simpleenroll"))
                .header(axum::http::header::AUTHORIZATION, basic("est", "1858"))
                .body(Body::from("not a csr"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(refused.status(), StatusCode::UNAUTHORIZED);
    let mut request = Request::put(format!("/api/v1/certmgr/profiles/{profile_id}/est-config"))
        .body(Body::from(r#"{"passphrase":"random-value-16b"}"#))
        .unwrap();
    *request.headers_mut() = headers;
    request.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        "application/json".parse().unwrap(),
    );
    assert_eq!(
        app.clone().oneshot(request).await.unwrap().status(),
        StatusCode::OK
    );
    let admitted = app
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
    assert_eq!(admitted.status(), StatusCode::BAD_REQUEST);
    let body = to_bytes(admitted.into_body(), 64 * 1024).await.unwrap();
    assert!(String::from_utf8_lossy(&body).contains("\"csr_invalid\""));
}
