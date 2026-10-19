//! HTTP coverage for root-trust PAKE enrollment.

use std::path::Path;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use base64::Engine as _;
use opensesame_cli_app_integration::{
    fingerprint_of_spki, generate_root_signing_key, root_spki_der, RootEnrollClient,
    RootTrustRecord, ROOT_ENROLL_BEGIN_PATH, ROOT_ENROLL_FINISH_PATH,
};
use tower::ServiceExt;

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn decode_b64(value: &str) -> Vec<u8> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(value)
        .expect("b64")
}

fn router_at(dir: Option<&Path>) -> (axum::Router, crate::App) {
    let mut state = crate::test_fixtures::test_state("http://127.0.0.1:8787");
    state.cli_root_trust_dir = dir.map(Path::to_path_buf);
    let app = crate::router(state.clone());
    (app, state)
}

fn begin_request(operator: bool, origin: bool) -> Request<Body> {
    let mut builder = Request::builder()
        .method("POST")
        .uri(ROOT_ENROLL_BEGIN_PATH);
    if operator {
        builder = builder.header("x-opensesame-operator", crate::test_operator_token());
    }
    if origin {
        builder = builder.header(header::ORIGIN, "http://localhost:5180");
    }
    builder.body(Body::empty()).unwrap()
}

async fn read_json(response: axum::response::Response) -> (StatusCode, serde_json::Value, String) {
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let text = String::from_utf8(bytes.to_vec()).unwrap();
    let parsed = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    (status, parsed, text)
}

struct Started {
    session_id: String,
    secret: Vec<u8>,
    daemon_message: Vec<u8>,
    secret_b64: String,
}

async fn begin(app: &axum::Router) -> Started {
    let response = app
        .clone()
        .oneshot(begin_request(true, false))
        .await
        .unwrap();
    let (status, parsed, _) = read_json(response).await;
    assert_eq!(status, StatusCode::OK);
    let secret_b64 = parsed["enrollmentSecretB64"].as_str().unwrap().to_string();
    Started {
        session_id: parsed["sessionId"].as_str().unwrap().to_string(),
        secret: decode_b64(&secret_b64),
        daemon_message: decode_b64(parsed["messageB64"].as_str().unwrap()),
        secret_b64,
    }
}

fn proof(started: &Started, spki: &[u8], confirm: &[u8], message: &[u8]) -> String {
    serde_json::json!({
        "sessionId": started.session_id,
        "messageB64": b64(message),
        "confirmB64": b64(confirm),
        "rootPublicKeySpkiB64": b64(spki),
    })
    .to_string()
}

fn finish_request(body: String, origin: bool) -> Request<Body> {
    finish_request_with_entry(body, origin, "secure-prompt")
}

fn finish_request_with_entry(body: String, origin: bool, enroll_entry: &str) -> Request<Body> {
    let mut builder = Request::builder()
        .method("POST")
        .uri(ROOT_ENROLL_FINISH_PATH)
        .header("content-type", "application/json")
        .header("x-opensesame-enroll-entry", enroll_entry);
    if origin {
        builder = builder.header(header::ORIGIN, "http://localhost:5180");
    }
    builder.body(Body::from(body)).unwrap()
}

fn honest(
    started: &Started,
    spki: &[u8],
) -> (Vec<u8>, opensesame_cli_app_integration::EnrollmentConfirm) {
    let client = RootEnrollClient::start(&started.secret).expect("client");
    let confirm = client
        .confirm(&started.daemon_message, spki)
        .expect("confirm");
    (client.message().to_vec(), confirm)
}

#[tokio::test]
async fn begin_requires_the_operator_and_rejects_origin() {
    let dir = tempfile::tempdir().unwrap();
    let (app, _) = router_at(Some(dir.path()));
    let missing = app
        .clone()
        .oneshot(begin_request(false, false))
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::UNAUTHORIZED);
    let browser = app.oneshot(begin_request(true, true)).await.unwrap();
    assert_eq!(browser.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn begin_without_a_state_dir_is_unavailable_and_does_not_enroll() {
    let (app, state) = router_at(None);
    let response = app.oneshot(begin_request(true, false)).await.unwrap();
    let (status, parsed, _) = read_json(response).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(parsed["error"], "root_trust_store_unavailable");
    assert!(!state
        .cli_app_integration
        .lock()
        .unwrap()
        .pairings
        .is_root_key_enrolled());
}

#[tokio::test]
async fn round_trip_persists_and_unblocks_pairing() {
    let dir = tempfile::tempdir().unwrap();
    let (app, state) = router_at(Some(dir.path()));
    let started = begin(&app).await;
    assert_eq!(started.secret.len(), 32);
    assert_eq!(started.daemon_message.len(), 65);
    let spki = root_spki_der(&generate_root_signing_key());
    let (message, confirm) = honest(&started, &spki);
    let response = app
        .clone()
        .oneshot(finish_request(
            proof(&started, &spki, confirm.client_confirm(), &message),
            false,
        ))
        .await
        .unwrap();
    let (status, parsed, text) = read_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parsed["enrolled"], true);
    assert_eq!(parsed["enrollmentEpoch"], 1);
    assert_eq!(parsed["spkiFingerprint"], fingerprint_of_spki(&spki));
    assert!(!text.contains(&started.secret_b64));
    let standard = base64::engine::general_purpose::STANDARD.encode(&started.secret);
    assert!(!text.contains(&standard));
    confirm
        .verify_daemon(&decode_b64(parsed["confirmB64"].as_str().unwrap()))
        .unwrap();

    let seal = std::fs::read(dir.path().join("cli-app-integration/root-trust.osseal")).unwrap();
    assert!(!seal
        .windows(started.secret.len())
        .any(|window| window == started.secret));
    let key = std::fs::read(dir.path().join("cli-app-integration/root-trust.key")).unwrap();
    assert!(!key
        .windows(started.secret.len())
        .any(|window| window == started.secret));

    {
        let reloaded = super::open_store(Some(dir.path()));
        let reloaded = reloaded.lock().unwrap();
        assert!(reloaded.pairings.is_root_key_enrolled());
        assert_eq!(
            reloaded.pairings.root_trust().unwrap().enrollment_epoch(),
            1
        );
        assert_eq!(
            reloaded.pairings.root_trust().unwrap().spki_fingerprint(),
            fingerprint_of_spki(&spki)
        );
    }

    let confirm_http = Request::builder()
        .method("POST")
        .uri("/v1/cli/app-integration/pairing/confirm")
        .header("content-type", "application/json")
        .header(header::ORIGIN, "http://localhost:5180")
        .body(Body::from(
            serde_json::json!({
                "code": "unused",
                "devicePublicKeySpkiB64": "unused",
                "pairingSignatureB64": "unused",
                "vaultSessionRootDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            })
            .to_string(),
        ))
        .unwrap();
    let response = app.oneshot(confirm_http).await.unwrap();
    let (status, parsed, _) = read_json(response).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(parsed["error"], "invalid_proof");
    assert!(state
        .cli_app_integration
        .lock()
        .unwrap()
        .pairings
        .is_root_key_enrolled());
}

mod finish;
