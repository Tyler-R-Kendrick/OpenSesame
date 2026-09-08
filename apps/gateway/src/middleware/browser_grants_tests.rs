use super::*;
use axum::{body::Body, middleware, routing::post, Router};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use opensesame_storage::browser_pairing::NewBrowserPairing;
use tower::ServiceExt;

#[path = "browser_metadata_tests.rs"]
mod metadata;

#[test]
fn ciphertext_grants_never_admit_administration_or_ambiguous_paths() {
    for path in [
        "/api/v1/session/local",
        "/api/v1/device/approve",
        "/api/v1/agent-runs/control",
        "/api/v1/sync/%70ull",
        "/api/v1/sync//pull",
    ] {
        assert!(required_capability("POST", path).is_none());
    }
    let required = required_capability("POST", "/api/v1/connections").unwrap();
    assert!(!["host.sync.read", "host.sync.write"].contains(&required));
    assert_eq!(
        required_capability("POST", "/api/v1/sync/pull"),
        Some("host.sync.read")
    );
    assert_eq!(
        required_capability("POST", "/api/v1/sync/push"),
        Some("host.sync.write")
    );
}

fn app(st: AppState) -> Router {
    Router::new()
        .route("/api/v1/sync/pull", post(|| async { StatusCode::OK }))
        .route("/api/v1/session/local", post(|| async { StatusCode::OK }))
        .route(
            "/api/v1/browser-pairings",
            post(|| async { StatusCode::OK }),
        )
        .layer(middleware::from_fn_with_state(st, guard))
}

fn preflight_request(path: &str, origin: &str, headers: &str) -> Request {
    Request::builder()
        .method("OPTIONS")
        .uri(path)
        .header(header::ORIGIN, origin)
        .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
        .header(header::ACCESS_CONTROL_REQUEST_HEADERS, headers)
        .header("access-control-request-private-network", "true")
        .body(Body::empty())
        .unwrap()
}

#[tokio::test]
async fn real_preflight_never_admits_shared_unpaired_or_operator_requests() {
    let state = crate::app_state::test_demo_state().await;
    let _lock = crate::app_state::test_env::lock();
    std::env::set_var(
        "OPENSESAME_BROWSER_PAIRABLE_ORIGINS",
        "https://paired.example",
    );
    let app = app(state);
    for (path, origin, headers) in [
        (
            "/api/v1/browser-pairings",
            "https://tyler-r-kendrick.github.io",
            "dpop",
        ),
        (
            "/api/v1/sync/pull",
            "https://paired.example",
            "authorization,dpop",
        ),
        (
            "/api/v1/session/local",
            "https://paired.example",
            "x-opensesame-operator",
        ),
        (
            "/api/v1/browser-pairings",
            "https://paired.example",
            "x-opensesame-operator",
        ),
        ("/api/v1/browser-pairings", "null", "dpop"),
    ] {
        let response = app
            .clone()
            .oneshot(preflight_request(path, origin, headers))
            .await
            .unwrap();
        assert!(!response
            .headers()
            .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
        assert!(!response
            .headers()
            .contains_key("access-control-allow-private-network"));
    }
    let response = app
        .oneshot(preflight_request(
            "/api/v1/browser-pairings",
            "https://paired.example",
            "dpop,content-type",
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
        "https://paired.example"
    );
    assert!(!response
        .headers()
        .contains_key(header::ACCESS_CONTROL_ALLOW_CREDENTIALS));
    std::env::remove_var("OPENSESAME_BROWSER_PAIRABLE_ORIGINS");
}

fn proof_key() -> (
    opensesame_proof::DpopPublicJwk,
    opensesame_proof::ProofSigningKey,
) {
    let pair = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
    let public = pair.public_key_raw();
    let jwk = serde_json::from_value(serde_json::json!({"kty":"EC","crv":"P-256",
        "x":URL_SAFE_NO_PAD.encode(&public[1..33]),"y":URL_SAFE_NO_PAD.encode(&public[33..65])}))
    .unwrap();
    (
        jwk,
        opensesame_proof::ProofSigningKey::from_ec_der(&pair.serialize_der()),
    )
}

#[tokio::test]
async fn every_actual_request_checks_key_replay_revocation_and_route_ceiling() {
    let state = crate::app_state::test_demo_state().await;
    let _lock = crate::app_state::test_env::lock();
    std::env::set_var(
        "OPENSESAME_BROWSER_PAIRABLE_ORIGINS",
        "https://paired.example",
    );
    let (jwk, key) = proof_key();
    let jkt = opensesame_proof::jwk_thumbprint(&jwk).unwrap();
    let now = chrono::Utc::now().timestamp();
    let raw = "a".repeat(64);
    let token = format!("opaque-session:{raw}");
    state
        .db
        .create_browser_pairing(&NewBrowserPairing {
            id: "client",
            device_digest: "device",
            user_code_digest: "code",
            origin: "https://paired.example",
            dpop_jkt: &jkt,
            audience: &state.resource,
            capabilities_json: "[\"host.sync.read\"]",
            now,
        })
        .await
        .unwrap();
    let principal = opensesame_domain::PrincipalId::new().to_string();
    let org = opensesame_domain::OrganizationId::new().to_string();
    state
        .db
        .decide_browser_pairing("code", &principal, &org, true, now)
        .await
        .unwrap();
    state
        .db
        .consume_browser_pairing(
            "device",
            "https://paired.example",
            &jkt,
            &hash_secret(&raw),
            now,
        )
        .await
        .unwrap()
        .unwrap();
    let claims = opensesame_proof::DpopClaims {
        jti: uuid::Uuid::new_v4().to_string(),
        htm: "POST".into(),
        htu: format!("{}/api/v1/sync/pull", state.resource),
        iat: now,
        ath: Some(opensesame_proof::access_token_hash(&token)),
    };
    let signed = opensesame_proof::sign_dpop_proof(&jwk, &key, &claims).unwrap();
    let request = || {
        Request::builder()
            .method("POST")
            .uri("/api/v1/sync/pull")
            .header(header::ORIGIN, "https://paired.example")
            .header(header::AUTHORIZATION, format!("DPoP {token}"))
            .header("dpop", &signed)
            .body(Body::empty())
            .unwrap()
    };
    let app = app(state.clone());
    assert_eq!(
        app.clone().oneshot(request()).await.unwrap().status(),
        StatusCode::OK
    );
    assert_eq!(
        app.clone().oneshot(request()).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    state
        .db
        .revoke_browser_client("client", &principal, &org, now)
        .await
        .unwrap();
    assert_eq!(
        app.oneshot(request()).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    std::env::remove_var("OPENSESAME_BROWSER_PAIRABLE_ORIGINS");
}
