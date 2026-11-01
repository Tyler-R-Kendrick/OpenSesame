use axum::body::Body;
use axum::extract::connect_info::ConnectInfo;
use axum::http::{header, Request, StatusCode};
use std::net::SocketAddr;
use tower::ServiceExt;

use opensesame_cli_app_integration::test_support::mint_test_pin_proof;

use super::{ensure_body, pair_browser};
#[cfg(unix)]
use super::{ensure_request, respond_request, test_peer_cred};
use crate::cli_app_integration::now_unix;

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
        host.pairings.enroll_root_key_for_tests();
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
    #[cfg(unix)]
    let response = app
        .clone()
        .oneshot(ensure_request(&body, Some(test_peer_cred())))
        .await
        .unwrap();
    #[cfg(not(unix))]
    let response = {
        let mut ensure_req = Request::builder()
            .method("POST")
            .uri("/v1/cli/app-integration/ensure")
            .header("content-type", "application/json")
            .body(Body::from(body))
            .unwrap();
        ensure_req
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 5151))));
        app.clone().oneshot(ensure_req).await.unwrap()
    };
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
        #[cfg(unix)]
        let respond_body = serde_json::json!({"requestId": request_id,"terminalSessionId": terminal_session_id,"decision": "approve","respondNonce": nonce,"humanProof": proof}).to_string();
        #[cfg(unix)]
        let respond = respond_request(&respond_body, legit_origin, &token, Some(test_peer_cred()));
        #[cfg(not(unix))]
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

/// Persona R7: operator-minted code → attacker device key confirm → exchange without arm →
/// `oschip2:pin` signed by the same attacker key must not approve. Second pairing also requires arm.
#[tokio::test]
async fn persona_r7_pairing_self_approve_chain_refused() {
    use crate::test_fixtures::test_router;
    use base64::Engine as _;
    use ecdsa::signature::Signer;
    use opensesame_cli_app_integration::{
        mint_test_signing_key, pairing_confirm_message,
        test_support::TEST_VAULT_SESSION_ROOT_DIGEST, verifying_key_spki_b64, PairingError,
    };
    let (app, state) = test_router("http://127.0.0.1:8787");
    let origin = "https://opensesame-labs.github.io";
    let now = now_unix();
    let attacker = mint_test_signing_key();
    let attacker_spki = verifying_key_spki_b64(attacker.verifying_key());

    state
        .cli_app_integration
        .lock()
        .unwrap()
        .pairings
        .enroll_root_key_for_tests();
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
    let message = pairing_confirm_message(&challenge, &code, origin);
    let sig: p256::ecdsa::Signature = attacker.sign(&message);
    let sig_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sig.to_bytes());

    let confirm = Request::builder()
        .method("POST")
        .uri("/v1/cli/app-integration/pairing/confirm")
        .header("content-type", "application/json")
        .header(header::ORIGIN, origin)
        .body(Body::from(
            serde_json::json!({
                "code": code,
                "devicePublicKeySpkiB64": attacker_spki,
                "pairingSignatureB64": sig_b64,
                "vaultSessionRootDigest": TEST_VAULT_SESSION_ROOT_DIGEST,
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
    let registration_code = confirm_json["registrationCode"]
        .as_str()
        .expect("registration code");

    let exchange = Request::builder()
        .method("POST")
        .uri("/v1/cli/app-integration/pairing")
        .header("content-type", "application/json")
        .header(header::ORIGIN, origin)
        .body(Body::from(serde_json::json!({ "code": code }).to_string()))
        .unwrap();
    let response = app.clone().oneshot(exchange).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    {
        let mut host = state.cli_app_integration.lock().unwrap();
        host.pairings
            .arm_registration(origin, registration_code, now)
            .expect("operator arm");
        let issued = host
            .pairings
            .exchange(&code, origin, now)
            .expect("attacker bearer");
        let pin_proof =
            mint_test_pin_proof(&attacker, "clr_attacker", "term-attacker", "nonce-attacker");
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

    let (code2, _) = state
        .cli_app_integration
        .lock()
        .unwrap()
        .pairings
        .issue(origin, now)
        .unwrap();
    let challenge2 = state
        .cli_app_integration
        .lock()
        .unwrap()
        .pairings
        .pairing_challenge_for_code(&code2, now)
        .expect("challenge2");
    let message2 = pairing_confirm_message(&challenge2, &code2, origin);
    let sig2: p256::ecdsa::Signature = attacker.sign(&message2);
    let sig2_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sig2.to_bytes());
    {
        let mut host = state.cli_app_integration.lock().unwrap();
        host.pairings
            .confirm(
                &code2,
                origin,
                &attacker_spki,
                &sig2_b64,
                Some(TEST_VAULT_SESSION_ROOT_DIGEST),
                now,
            )
            .expect("confirm2");
        assert!(matches!(
            host.pairings.exchange(&code2, origin, now),
            Err(PairingError::RegistrationRequired)
        ));
    }

    let token = pair_browser(&state, "http://localhost:5180");
    let body = ensure_body("persona-r7-attacker");
    #[cfg(unix)]
    let response = app
        .clone()
        .oneshot(ensure_request(&body, Some(test_peer_cred())))
        .await
        .unwrap();
    #[cfg(not(unix))]
    let response = {
        let mut ensure_req = Request::builder()
            .method("POST")
            .uri("/v1/cli/app-integration/ensure")
            .header("content-type", "application/json")
            .body(Body::from(body))
            .unwrap();
        ensure_req
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 5252))));
        app.clone().oneshot(ensure_req).await.unwrap()
    };
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let request_id = parsed["requestId"].as_str().expect("request id");
    let pending = Request::builder()
        .method("GET")
        .uri("/v1/cli/app-integration/pending")
        .header(header::ORIGIN, "http://localhost:5180")
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
    let pin_proof = mint_test_pin_proof(&attacker, request_id, terminal_session_id, nonce);
    #[cfg(unix)]
    let respond_body = serde_json::json!({"requestId": request_id,"terminalSessionId": terminal_session_id,"decision": "approve","respondNonce": nonce,"humanProof": pin_proof}).to_string();
    #[cfg(unix)]
    let respond = respond_request(
        &respond_body,
        "http://localhost:5180",
        &token,
        Some(test_peer_cred()),
    );
    #[cfg(not(unix))]
    let respond = Request::builder()
        .method("POST")
        .uri("/v1/cli/app-integration/respond")
        .header("content-type", "application/json")
        .header(header::ORIGIN, "http://localhost:5180")
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

mod root_enrollment;
