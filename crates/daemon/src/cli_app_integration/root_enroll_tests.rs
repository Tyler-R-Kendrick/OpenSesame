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
    assert_eq!(parsed["error"], "pairing_refused");
    assert!(state
        .cli_app_integration
        .lock()
        .unwrap()
        .pairings
        .is_root_key_enrolled());
}

#[tokio::test]
async fn finish_origin_does_not_burn_the_session() {
    let dir = tempfile::tempdir().unwrap();
    let (app, _) = router_at(Some(dir.path()));
    let started = begin(&app).await;
    let spki = root_spki_der(&generate_root_signing_key());
    let (message, confirm) = honest(&started, &spki);
    let body = proof(&started, &spki, confirm.client_confirm(), &message);
    let blocked = app
        .clone()
        .oneshot(finish_request(body.clone(), true))
        .await
        .unwrap();
    let (status, parsed, _) = read_json(blocked).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(parsed["error"], "origin_forbidden");
    let response = app.oneshot(finish_request(body, false)).await.unwrap();
    let (status, parsed, _) = read_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parsed["enrollmentEpoch"], 1);
}

#[tokio::test]
async fn finish_without_enroll_entry_header_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let (app, _) = router_at(Some(dir.path()));
    let started = begin(&app).await;
    let spki = root_spki_der(&generate_root_signing_key());
    let (message, confirm) = honest(&started, &spki);
    let body = proof(&started, &spki, confirm.client_confirm(), &message);
    let builder = Request::builder()
        .method("POST")
        .uri(ROOT_ENROLL_FINISH_PATH)
        .header("content-type", "application/json");
    let refused = app
        .oneshot(builder.body(Body::from(body)).unwrap())
        .await
        .unwrap();
    let (status, parsed, _) = read_json(refused).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(parsed["error"], "root_enroll_refused");
}

#[tokio::test]
async fn malformed_finish_can_be_retried_and_unknown_id_is_not_found() {
    let dir = tempfile::tempdir().unwrap();
    let (app, state) = router_at(Some(dir.path()));
    let started = begin(&app).await;
    let spki = root_spki_der(&generate_root_signing_key());
    let (message, confirm) = honest(&started, &spki);
    let confirm_bytes = confirm.client_confirm().to_vec();
    let empty = app
        .clone()
        .oneshot(finish_request(String::new(), false))
        .await
        .unwrap();
    let (status, parsed, _) = read_json(empty).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(parsed["error"], "root_enroll_refused");

    let mut bad = serde_json::json!({
        "sessionId": started.session_id,
        "messageB64": "!!!",
        "confirmB64": b64(&confirm_bytes),
        "rootPublicKeySpkiB64": b64(&spki),
    });
    let refused = app
        .clone()
        .oneshot(finish_request(bad.to_string(), false))
        .await
        .unwrap();
    let (status, parsed, _) = read_json(refused).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(parsed["error"], "root_enroll_refused");

    bad["sessionId"] = serde_json::Value::String("ab".repeat(16));
    bad["messageB64"] = serde_json::Value::String(b64(&message));
    let unknown = app
        .clone()
        .oneshot(finish_request(bad.to_string(), false))
        .await
        .unwrap();
    let (status, parsed, _) = read_json(unknown).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(parsed["error"], "root_enroll_unknown");

    let ok = app
        .oneshot(finish_request(
            proof(&started, &spki, &confirm_bytes, &message),
            false,
        ))
        .await
        .unwrap();
    assert_eq!(ok.status(), StatusCode::OK);
    assert!(state
        .cli_app_integration
        .lock()
        .unwrap()
        .pairings
        .is_root_key_enrolled());
}

#[tokio::test]
async fn wrong_confirm_does_not_write_the_store() {
    let dir = tempfile::tempdir().unwrap();
    let (app, state) = router_at(Some(dir.path()));
    let started = begin(&app).await;
    let spki = root_spki_der(&generate_root_signing_key());
    let (message, confirm) = honest(&started, &spki);
    let mut bad = confirm.client_confirm().to_vec();
    bad[0] ^= 0xff;
    let response = app
        .oneshot(finish_request(
            proof(&started, &spki, &bad, &message),
            false,
        ))
        .await
        .unwrap();
    let (status, parsed, _) = read_json(response).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(parsed["error"], "root_enroll_refused");
    assert!(!dir
        .path()
        .join("cli-app-integration/root-trust.osseal")
        .exists());
    assert!(!state
        .cli_app_integration
        .lock()
        .unwrap()
        .pairings
        .is_root_key_enrolled());
}

#[tokio::test]
async fn a_second_enrollment_increments_the_epoch() {
    let dir = tempfile::tempdir().unwrap();
    let (app, _) = router_at(Some(dir.path()));
    for epoch in [1_u64, 2] {
        let started = begin(&app).await;
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
        let (status, parsed, _) = read_json(response).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(parsed["enrollmentEpoch"], epoch);
    }
    let reloaded = super::open_store(Some(dir.path()));
    assert_eq!(
        reloaded
            .lock()
            .unwrap()
            .pairings
            .root_trust()
            .unwrap()
            .enrollment_epoch(),
        2
    );
}

#[tokio::test]
async fn epoch_exhaustion_is_a_conflict_and_keeps_the_session() {
    let dir = tempfile::tempdir().unwrap();
    let stored = RootTrustRecord::new(fingerprint_of_spki(&[9u8; 8]), u64::MAX).unwrap();
    super::root_trust::save(dir.path(), &stored).unwrap();
    let mut state = crate::test_fixtures::test_state("http://127.0.0.1:8787");
    state.cli_app_integration = super::open_store(Some(dir.path()));
    state.cli_root_trust_dir = Some(dir.path().to_path_buf());
    let app = crate::router(state.clone());
    let started = begin(&app).await;
    let spki = root_spki_der(&generate_root_signing_key());
    let (message, confirm) = honest(&started, &spki);
    let body = proof(&started, &spki, confirm.client_confirm(), &message);
    let response = app
        .clone()
        .oneshot(finish_request(body.clone(), false))
        .await
        .unwrap();
    let (status, parsed, _) = read_json(response).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(parsed["error"], "root_enroll_epoch_exhausted");
    state
        .cli_app_integration
        .lock()
        .unwrap()
        .pairings
        .mark_root_key_enrolled(RootTrustRecord::new(fingerprint_of_spki(&spki), 3).unwrap());
    let response = app.oneshot(finish_request(body, false)).await.unwrap();
    let (status, parsed, _) = read_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parsed["enrollmentEpoch"], 4);
}

#[tokio::test]
async fn oversized_body_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let (app, _) = router_at(Some(dir.path()));
    let response = app
        .oneshot(finish_request("x".repeat(3000), false))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
}
