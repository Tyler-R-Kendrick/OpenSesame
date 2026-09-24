//! Route-level EST behaviour: the unauthenticated surface must not be an
//! existence oracle, the sealed passphrase is the credential, and the
//! operator surface never returns secret material. Issuance correctness lives
//! in `est_enrollment_tests` (policy, sign, wrap) and the interop suites.

use axum::body::{to_bytes, Body};
use axum::extract::DefaultBodyLimit;
use axum::http::{Request, StatusCode};
use axum::routing::{get, post};
use axum::Router;
use tower::ServiceExt;

use crate::app_state::{self, test_env, test_session_headers};
use crate::config::Args;

fn router(state: crate::app_state::AppState) -> Router {
    Router::new()
        .route("/.well-known/est/{profile_id}/cacerts", get(super::cacerts))
        .route(
            "/.well-known/est/{profile_id}/simpleenroll",
            post(super::simple_enroll).layer(DefaultBodyLimit::max(super::MAX_CSR_BODY)),
        )
        .route(
            "/.well-known/est/{profile_id}/simplereenroll",
            post(super::simple_reenroll).layer(DefaultBodyLimit::max(super::MAX_CSR_BODY)),
        )
        .route(
            "/api/v1/certmgr/profiles/{id}/est-config",
            get(super::get_config).put(super::put_config),
        )
        .with_state(state)
}

async fn sealed_state() -> crate::app_state::AppState {
    std::env::set_var(
        "OPENSESAME_CONNECTION_KEY",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    );
    std::env::set_var("OPENSESAME_TASKBUS", "memory");
    app_state::build_test(Args {
        listen: "127.0.0.1:0".parse().unwrap(),
        resource: "https://opensesame.local".into(),
        issuer: "https://issuer.local".into(),
        database_url: "sqlite::memory:".into(),
        task_database_url: String::new(),
    })
    .await
    .expect("test state")
}

fn basic(user: &str, password: &str) -> String {
    use base64::Engine as _;
    format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(format!("{user}:{password}"))
    )
}

#[tokio::test]
async fn an_unknown_profile_and_an_unconfigured_one_look_the_same() {
    let _guard = test_env::lock();
    let state = sealed_state().await;
    for (method, path) in [
        ("GET", "/.well-known/est/no-such-profile/cacerts"),
        ("POST", "/.well-known/est/no-such-profile/simpleenroll"),
    ] {
        let builder = match method {
            "GET" => Request::get(path),
            _ => Request::post(path),
        };
        let response = router(state.clone())
            .oneshot(builder.body(Body::from("AAAA")).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
        let text = String::from_utf8_lossy(&body);
        assert!(text.contains("\"unavailable\""), "{path}: {text}");
    }
}

#[tokio::test]
async fn enrollment_without_valid_credentials_is_refused_with_basic_auth() {
    let _guard = test_env::lock();
    let state = sealed_state().await;
    let profile_id = seed_self_signed_profile(&state, "correct horse").await;
    let app = router(state);

    // No credential at all.
    let response = app
        .clone()
        .oneshot(
            Request::post(format!("/.well-known/est/{profile_id}/simpleenroll"))
                .body(Body::from("not a csr"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(response
        .headers()
        .get(axum::http::header::WWW_AUTHENTICATE)
        .is_some());

    // The wrong passphrase never reaches the CSR decoder.
    let response = app
        .clone()
        .oneshot(
            Request::post(format!("/.well-known/est/{profile_id}/simpleenroll"))
                .header(axum::http::header::AUTHORIZATION, basic("est", "wrong"))
                .body(Body::from("not a csr"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    // The right passphrase passes authentication and reaches the CSR decoder,
    // which refuses the garbage body — proof the credential checked out.
    let response = app
        .oneshot(
            Request::post(format!("/.well-known/est/{profile_id}/simpleenroll"))
                .header(
                    axum::http::header::AUTHORIZATION,
                    basic("est", "correct horse"),
                )
                .body(Body::from("not a csr"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
    assert!(String::from_utf8_lossy(&body).contains("\"csr_invalid\""));
}

#[tokio::test]
async fn the_operator_surface_never_returns_the_passphrase() {
    let _guard = test_env::lock();
    let state = sealed_state().await;
    let profile_id = seed_self_signed_profile(&state, "correct horse").await;
    let headers = test_session_headers(
        &state,
        "principal:00000000-0000-4000-8000-000000000001",
        state.connection_organization,
        opensesame_domain::OrganizationRole::Owner,
    );
    let app = router(state);
    let mut request = Request::get(format!("/api/v1/certmgr/profiles/{profile_id}/est-config"))
        .body(Body::empty())
        .unwrap();
    *request.headers_mut() = headers;
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
    let text = String::from_utf8_lossy(&body);
    assert!(text.contains("\"passphrase_set\":true"), "{text}");
    assert!(!text.contains("correct horse"), "{text}");
}

/// Seeds a policy, a self-signed profile (no authority required) and a sealed
/// EST passphrase — the minimum an enrollment path needs to exist.
async fn seed_self_signed_profile(state: &crate::app_state::AppState, passphrase: &str) -> String {
    use opensesame_connection_broker::crypto::seal_scoped;
    use opensesame_storage::{
        seal_scopes, SealedCertificateMaterial, StoredCertificatePolicy, StoredCertificateProfile,
        StoredEstConfig,
    };
    let now = chrono::Utc::now().to_rfc3339();
    let organization = state.connection_organization.to_string();
    let policy_id = "policy-est-tests".to_owned();
    state
        .db
        .insert_certificate_policy(&StoredCertificatePolicy {
            id: policy_id.clone(),
            organization_id: organization.clone(),
            name: "est tests".into(),
            description: None,
            preset: "tls_client".into(),
            max_validity_seconds: None,
            rules_json: "{}".into(),
            version: 1,
            created_at: now.clone(),
            updated_at: now.clone(),
        })
        .await
        .expect("policy");
    let profile_id = "profile-est-tests".to_owned();
    state
        .db
        .insert_certificate_profile(&StoredCertificateProfile {
            id: profile_id.clone(),
            organization_id: organization.clone(),
            name: "est tests".into(),
            issuer_type: "self_signed".into(),
            certificate_authority_id: None,
            policy_id,
            defaults_json: "{}".into(),
            external_template: None,
            version: 1,
            created_at: now.clone(),
            updated_at: now.clone(),
        })
        .await
        .expect("profile");
    let sealing = super::sealing_key(state).expect("sealing key");
    let blob = seal_scoped(
        &sealing,
        seal_scopes::EST_PASSPHRASE,
        "est-config:profile-est-tests",
        &organization,
        passphrase.as_bytes(),
    )
    .expect("seal");
    state
        .db
        .insert_est_config(&StoredEstConfig {
            id: "est-config:profile-est-tests".into(),
            organization_id: organization.clone(),
            profile_id: profile_id.clone(),
            sealed_passphrase: Some(SealedCertificateMaterial {
                key_id: "opensesame-connection-key:v1".into(),
                ciphertext: blob.ciphertext,
                nonce: blob.nonce,
                aad_digest: blob.aad_digest,
            }),
            bootstrap_chain_pem: None,
            require_bootstrap: false,
            version: 1,
            created_at: now.clone(),
            updated_at: now,
        })
        .await
        .expect("est config");
    profile_id
}
