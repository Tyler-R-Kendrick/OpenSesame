use axum::body::Body;
use axum::extract::connect_info::ConnectInfo;
use axum::http::{header, Request, StatusCode};
use std::net::SocketAddr;
use tower::ServiceExt;

use super::{ensure_body, pair_browser};
use crate::cli_app_integration::now_unix;
use crate::App;

/// Persona D6: operator token → forged origin + random `root:` hex → fake PIN/passkey proofs.
#[tokio::test]
async fn persona_attack_chain_is_refused() {
    use crate::test_fixtures::test_router;
    use opensesame_cli_app_integration::PairingError;

    let (app, state) = test_router("http://127.0.0.1:8787");
    let legit_origin = "http://localhost:5180";
    let forged_origin = "https://attacker.github.io";
    let now = now_unix();
    let (code, _) = state
        .cli_app_integration
        .lock()
        .unwrap()
        .pairings
        .issue(legit_origin, now)
        .unwrap();
    let forged_device_key = "root:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    {
        let mut host = state.cli_app_integration.lock().unwrap();
        assert!(matches!(
            host.pairings.confirm(
                &code,
                forged_origin,
                forged_device_key,
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                None,
                now,
            ),
            Err(PairingError::Unknown | PairingError::InvalidProof | PairingError::WrongOrigin)
        ));
    }

    let token = pair_browser(&state, legit_origin);
    let body = ensure_body("persona-attacker");
    let mut ensure_req = Request::builder()
        .method("POST")
        .uri("/v1/cli/app-integration/ensure")
        .header("content-type", "application/json")
        .body(Body::from(body))
        .unwrap();
    ensure_req
        .extensions_mut()
        .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 5151))));
    let response = app.clone().oneshot(ensure_req).await.unwrap();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let request_id = parsed["requestId"].as_str().expect("request id");
    let pending = Request::builder()
        .method("GET")
        .uri("/v1/cli/app-integration/pending")
        .header(header::ORIGIN, legit_origin)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(pending).await.unwrap();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let terminal_session_id = parsed["pending"][0]["terminalSessionId"]
        .as_str()
        .expect("terminal");
    let nonce = parsed["pending"][0]["respondNonce"]
        .as_str()
        .expect("nonce");
    let fake_pin = "oschip2:pin:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    let fake_passkey = format!(
        "oschip2:passkey:{}",
        serde_json::json!({
            "credentialIdB64": "cred",
            "authenticatorDataB64": "AA",
            "clientDataJsonB64": "AA",
            "signatureB64": "AA",
        })
    );
    for proof in [fake_pin, fake_passkey.as_str()] {
        let respond = Request::builder()
            .method("POST")
            .uri("/v1/cli/app-integration/respond")
            .header("content-type", "application/json")
            .header(header::ORIGIN, legit_origin)
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::from(
                serde_json::json!({
                    "requestId": request_id,
                    "terminalSessionId": terminal_session_id,
                    "decision": "approve",
                    "respondNonce": nonce,
                    "humanProof": proof,
                })
                .to_string(),
            ))
            .unwrap();
        let response = app.clone().oneshot(respond).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed["status"], "wrongSession");
    }
}

fn pairing_confirm_signature_b64(
    signing_key: &p256::ecdsa::SigningKey,
    challenge: &[u8],
    code: &str,
    origin: &str,
) -> String {
    use base64::Engine as _;
    use ecdsa::signature::Signer;
    use opensesame_cli_app_integration::pairing_confirm_message;

    let message = pairing_confirm_message(challenge, code, origin);
    let signature: p256::ecdsa::Signature = signing_key.sign(&message);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(signature.to_bytes())
}

async fn post_pairing_confirm_registration_code(
    app: &axum::Router,
    origin: &str,
    code: &str,
    device_spki: &str,
    pairing_signature_b64: &str,
    vault_session_root_digest: &str,
) -> String {
    let confirm = Request::builder()
        .method("POST")
        .uri("/v1/cli/app-integration/pairing/confirm")
        .header("content-type", "application/json")
        .header(header::ORIGIN, origin)
        .body(Body::from(
            serde_json::json!({
                "code": code,
                "devicePublicKeySpkiB64": device_spki,
                "pairingSignatureB64": pairing_signature_b64,
                "vaultSessionRootDigest": vault_session_root_digest,
            })
            .to_string(),
        ))
        .unwrap();
    let response = app.clone().oneshot(confirm).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let confirm_bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let confirm_json: serde_json::Value = serde_json::from_slice(&confirm_bytes).unwrap();
    confirm_json["registrationCode"]
        .as_str()
        .expect("registration code")
        .to_string()
}

async fn post_pairing_exchange_expect_forbidden(app: &axum::Router, origin: &str, code: &str) {
    let exchange = Request::builder()
        .method("POST")
        .uri("/v1/cli/app-integration/pairing")
        .header("content-type", "application/json")
        .header(header::ORIGIN, origin)
        .body(Body::from(serde_json::json!({ "code": code }).to_string()))
        .unwrap();
    let response = app.clone().oneshot(exchange).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

fn armed_exchange_pin_approve_is_wrong_session(
    state: &App,
    origin: &str,
    code: &str,
    registration_code: &str,
    signing_key: &p256::ecdsa::SigningKey,
    now: u64,
) {
    use opensesame_cli_app_integration::mint_pin_human_proof;

    let mut host = state.cli_app_integration.lock().unwrap();
    host.pairings
        .arm_registration(origin, registration_code, now)
        .expect("operator arm");
    let issued = host
        .pairings
        .exchange(code, origin, now)
        .expect("attacker bearer");
    let pin_proof = mint_pin_human_proof(
        signing_key,
        "clr_attacker",
        "term-attacker",
        "nonce-attacker",
        "read",
    );
    let binding = host
        .pairings
        .binding_for(&issued.token, origin)
        .expect("bind");
    assert!(binding.webauthn.is_none());
    let (status, _) = host.store.approve(
        "clr_attacker",
        "term-attacker",
        "nonce-attacker",
        &pin_proof,
        &binding,
    );
    assert_eq!(status, "wrongSession");
}

fn second_pairing_still_requires_registration(
    state: &App,
    origin: &str,
    device_spki: &str,
    signing_key: &p256::ecdsa::SigningKey,
    now: u64,
) {
    use opensesame_cli_app_integration::{
        test_support::TEST_VAULT_SESSION_ROOT_DIGEST, PairingError,
    };

    let (follow_up_code, _) = state
        .cli_app_integration
        .lock()
        .unwrap()
        .pairings
        .issue(origin, now)
        .unwrap();
    let follow_up_challenge = state
        .cli_app_integration
        .lock()
        .unwrap()
        .pairings
        .pairing_challenge_for_code(&follow_up_code, now)
        .expect("follow-up challenge");
    let follow_up_signature_b64 =
        pairing_confirm_signature_b64(signing_key, &follow_up_challenge, &follow_up_code, origin);
    let mut host = state.cli_app_integration.lock().unwrap();
    host.pairings
        .confirm(
            &follow_up_code,
            origin,
            device_spki,
            &follow_up_signature_b64,
            Some(TEST_VAULT_SESSION_ROOT_DIGEST),
            now,
        )
        .expect("follow-up confirm");
    assert!(matches!(
        host.pairings.exchange(&follow_up_code, origin, now),
        Err(PairingError::RegistrationRequired)
    ));
}

async fn localhost_attacker_pin_respond_is_wrong_session(
    app: &axum::Router,
    state: &App,
    signing_key: &p256::ecdsa::SigningKey,
) {
    use opensesame_cli_app_integration::mint_pin_human_proof;

    let localhost = "http://localhost:5180";
    let token = pair_browser(state, localhost);
    let body = ensure_body("persona-r7-attacker");
    let mut ensure_req = Request::builder()
        .method("POST")
        .uri("/v1/cli/app-integration/ensure")
        .header("content-type", "application/json")
        .body(Body::from(body))
        .unwrap();
    ensure_req
        .extensions_mut()
        .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 5252))));
    let response = app.clone().oneshot(ensure_req).await.unwrap();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let request_id = parsed["requestId"].as_str().expect("request id");
    let pending = Request::builder()
        .method("GET")
        .uri("/v1/cli/app-integration/pending")
        .header(header::ORIGIN, localhost)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(pending).await.unwrap();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let terminal_session_id = parsed["pending"][0]["terminalSessionId"]
        .as_str()
        .expect("terminal");
    let nonce = parsed["pending"][0]["respondNonce"]
        .as_str()
        .expect("nonce");
    let pin_proof =
        mint_pin_human_proof(signing_key, request_id, terminal_session_id, nonce, "read");
    let respond = Request::builder()
        .method("POST")
        .uri("/v1/cli/app-integration/respond")
        .header("content-type", "application/json")
        .header(header::ORIGIN, localhost)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::from(
            serde_json::json!({
                "requestId": request_id,
                "terminalSessionId": terminal_session_id,
                "decision": "approve",
                "respondNonce": nonce,
                "humanProof": pin_proof,
            })
            .to_string(),
        ))
        .unwrap();
    let response = app.clone().oneshot(respond).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(parsed["status"], "wrongSession");
}

/// Persona R7: operator-minted code → attacker device key confirm → exchange without arm →
/// `oschip2:pin` signed by the same attacker key must not approve. Second pairing also requires arm.
#[tokio::test]
async fn persona_r7_pairing_self_approve_chain_refused() {
    use crate::test_fixtures::test_router;
    use opensesame_cli_app_integration::{
        mint_test_signing_key, test_support::TEST_VAULT_SESSION_ROOT_DIGEST, verifying_key_spki_b64,
    };

    let (app, state) = test_router("http://127.0.0.1:8787");
    let origin = "https://tyler-r-kendrick.github.io";
    let now = now_unix();
    let attacker = mint_test_signing_key();
    let attacker_spki = verifying_key_spki_b64(attacker.verifying_key());

    let (code, _) = state
        .cli_app_integration
        .lock()
        .unwrap()
        .pairings
        .issue(origin, now)
        .unwrap();
    let challenge = state
        .cli_app_integration
        .lock()
        .unwrap()
        .pairings
        .pairing_challenge_for_code(&code, now)
        .expect("challenge");
    let pairing_signature_b64 = pairing_confirm_signature_b64(&attacker, &challenge, &code, origin);
    let registration_code = post_pairing_confirm_registration_code(
        &app,
        origin,
        &code,
        &attacker_spki,
        &pairing_signature_b64,
        TEST_VAULT_SESSION_ROOT_DIGEST,
    )
    .await;

    post_pairing_exchange_expect_forbidden(&app, origin, &code).await;
    armed_exchange_pin_approve_is_wrong_session(
        &state,
        origin,
        &code,
        &registration_code,
        &attacker,
        now,
    );
    second_pairing_still_requires_registration(&state, origin, &attacker_spki, &attacker, now);
    localhost_attacker_pin_respond_is_wrong_session(&app, &state, &attacker).await;
}
