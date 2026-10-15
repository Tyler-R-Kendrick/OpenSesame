use axum::body::Body;
use axum::extract::connect_info::ConnectInfo;
use axum::http::{header, Request, StatusCode};
use opensesame_cli_app_integration::{session_id_from_pid, test_support};
use opensesame_uds_authn::PeerCred;
use tower::ServiceExt;

use crate::peer_auth::UdsConnectInfo;
use crate::App;
use std::net::SocketAddr;

use super::now_unix;

fn ensure_body(terminal_session_id: &str) -> String {
    serde_json::json!({
        "terminalSessionId": terminal_session_id,
        "verb": "read",
    })
    .to_string()
}

fn pair_browser(app: &App, origin: &str) -> String {
    let now = now_unix();
    test_support::pair_browser_for_tests(
        &mut app.cli_app_integration.lock().unwrap().pairings,
        origin,
        now,
    )
}

#[cfg(unix)]
fn ensure_request(body: &str, cred: Option<PeerCred>) -> Request<Body> {
    let mut req = Request::builder()
        .method("POST")
        .uri("/v1/cli/app-integration/ensure")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    req.extensions_mut()
        .insert(ConnectInfo(UdsConnectInfo(cred)));
    req
}

#[cfg(unix)]
#[tokio::test]
async fn ensure_over_uds_ignores_body_terminal_session_id() {
    use crate::test_fixtures::test_router;

    let (app, state) = test_router("http://127.0.0.1:8787");
    let origin = "http://localhost:5180";
    let token = pair_browser(&state, origin);
    let pid = std::process::id();
    let derived = session_id_from_pid(pid).expect("derived session");
    let cred = PeerCred {
        pid,
        uid: 0,
        gid: 0,
    };
    let body = ensure_body("forged-terminal-id");
    let res = app
        .clone()
        .oneshot(ensure_request(&body, Some(cred)))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(parsed["status"], "pending");
    let request_id = parsed["requestId"].as_str().expect("request id");
    let pending = Request::builder()
        .method("GET")
        .uri("/v1/cli/app-integration/pending")
        .header(header::ORIGIN, origin)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(pending).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let nonce = parsed["pending"][0]["respondNonce"]
        .as_str()
        .expect("nonce");
    let human_proof = test_support::mint_test_human_proof(request_id, &derived, nonce, "read");
    let respond = Request::builder()
        .method("POST")
        .uri("/v1/cli/app-integration/respond")
        .header("content-type", "application/json")
        .header(header::ORIGIN, origin)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::from(
            serde_json::json!({
                "requestId": request_id,
                "terminalSessionId": derived,
                "decision": "approve",
                "respondNonce": nonce,
                "humanProof": human_proof,
            })
            .to_string(),
        ))
        .unwrap();
    let res = app.clone().oneshot(respond).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let res = app
        .clone()
        .oneshot(ensure_request(&body, Some(cred)))
        .await
        .unwrap();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(parsed["status"], "approved");
}

#[tokio::test]
async fn pending_without_pairing_is_unauthorized() {
    use crate::test_fixtures::test_router;

    let (app, _) = test_router("http://127.0.0.1:8787");
    let pending = Request::builder()
        .method("GET")
        .uri("/v1/cli/app-integration/pending")
        .header(header::ORIGIN, "http://localhost:5180")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(pending).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn tcp_ensure_never_reuses_approval() {
    use crate::test_fixtures::test_router;

    let (app, state) = test_router("http://127.0.0.1:8787");
    let origin = "http://localhost:5180";
    let token = pair_browser(&state, origin);
    let forged_id = "tcp-correlation-1";
    let body = ensure_body(forged_id);
    let tcp_peer = ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 4242)));
    let mut ensure_req = Request::builder()
        .method("POST")
        .uri("/v1/cli/app-integration/ensure")
        .header("content-type", "application/json")
        .body(Body::from(body.clone()))
        .unwrap();
    ensure_req.extensions_mut().insert(tcp_peer);
    let response = app.clone().oneshot(ensure_req).await.unwrap();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(parsed["status"], "pending");
    let request_id = parsed["requestId"].as_str().expect("request id");
    let pending = Request::builder()
        .method("GET")
        .uri("/v1/cli/app-integration/pending")
        .header(header::ORIGIN, origin)
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
        .expect("terminal session");
    assert_ne!(terminal_session_id, forged_id);
    let nonce = parsed["pending"][0]["respondNonce"]
        .as_str()
        .expect("nonce");
    let human_proof =
        test_support::mint_test_human_proof(request_id, terminal_session_id, nonce, "read");
    let respond = Request::builder()
        .method("POST")
        .uri("/v1/cli/app-integration/respond")
        .header("content-type", "application/json")
        .header(header::ORIGIN, origin)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::from(
            serde_json::json!({
                "requestId": request_id,
                "terminalSessionId": terminal_session_id,
                "decision": "approve",
                "respondNonce": nonce,
                "humanProof": human_proof,
            })
            .to_string(),
        ))
        .unwrap();
    let response = app.clone().oneshot(respond).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let mut ensure_req = Request::builder()
        .method("POST")
        .uri("/v1/cli/app-integration/ensure")
        .header("content-type", "application/json")
        .body(Body::from(body.clone()))
        .unwrap();
    ensure_req.extensions_mut().insert(tcp_peer);
    let response = app.clone().oneshot(ensure_req).await.unwrap();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(parsed["status"], "approved");
    let mut ensure_req = Request::builder()
        .method("POST")
        .uri("/v1/cli/app-integration/ensure")
        .header("content-type", "application/json")
        .body(Body::from(body.clone()))
        .unwrap();
    ensure_req.extensions_mut().insert(tcp_peer);
    let response = app.clone().oneshot(ensure_req).await.unwrap();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(parsed["status"], "pending");
}

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

/// Persona R7: operator-minted code → attacker device key confirm → exchange without arm →
/// `oschip2:pin` signed by the same attacker key must not approve. Second pairing also requires arm.
#[tokio::test]
async fn persona_r7_pairing_self_approve_chain_refused() {
    use crate::test_fixtures::test_router;
    use base64::Engine as _;
    use ecdsa::signature::Signer;
    use opensesame_cli_app_integration::{
        mint_pin_human_proof, mint_test_signing_key, pairing_confirm_message,
        verifying_key_spki_b64, PairingError,
    };
    let (app, state) = test_router("http://127.0.0.1:8787");
    let origin = "https://tyler-r-kendrick.github.io";
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
                "vaultSessionRootDigest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
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
        let pin_proof = mint_pin_human_proof(
            &attacker,
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
                Some("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
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
    let pin_proof = mint_pin_human_proof(&attacker, request_id, terminal_session_id, nonce, "read");
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

async fn assert_root_key_not_enrolled(response: axum::response::Response) {
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(parsed["error"], "root_key_not_enrolled");
}

/// Confirm, exchange, arm, and WebAuthn register are HTTP 403 until the root trust key
/// is enrolled. Operator issue still returns a pairing code.
#[tokio::test]
async fn pairing_ops_refuse_until_root_key_enrolled() {
    use crate::test_fixtures::test_router;

    let (app, state) = test_router("http://127.0.0.1:8787");
    assert!(!state
        .cli_app_integration
        .lock()
        .unwrap()
        .pairings
        .is_root_key_enrolled());
    let origin = "http://localhost:5180";
    let issue = Request::builder()
        .method("POST")
        .uri("/v1/operator/cli-app-integration/pair")
        .header("content-type", "application/json")
        .header("x-opensesame-operator", crate::test_operator_token())
        .body(Body::from(
            serde_json::json!({ "origin": origin }).to_string(),
        ))
        .unwrap();
    let response = app.clone().oneshot(issue).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let issued: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(issued["pairingCode"].as_str().is_some());

    let confirm = Request::builder()
        .method("POST")
        .uri("/v1/cli/app-integration/pairing/confirm")
        .header("content-type", "application/json")
        .header(header::ORIGIN, origin)
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
    assert_root_key_not_enrolled(app.clone().oneshot(confirm).await.unwrap()).await;

    let exchange = Request::builder()
        .method("POST")
        .uri("/v1/cli/app-integration/pairing")
        .header("content-type", "application/json")
        .header(header::ORIGIN, origin)
        .body(Body::from(
            serde_json::json!({ "code": "unused" }).to_string(),
        ))
        .unwrap();
    assert_root_key_not_enrolled(app.clone().oneshot(exchange).await.unwrap()).await;

    let arm = Request::builder()
        .method("POST")
        .uri("/v1/operator/cli-app-integration/pair/registration")
        .header("content-type", "application/json")
        .header("x-opensesame-operator", crate::test_operator_token())
        .body(Body::from(
            serde_json::json!({
                "origin": origin,
                "registrationCode": "unused",
            })
            .to_string(),
        ))
        .unwrap();
    assert_root_key_not_enrolled(app.clone().oneshot(arm).await.unwrap()).await;

    let register = Request::builder()
        .method("POST")
        .uri("/v1/cli/app-integration/pairing/webauthn")
        .header("content-type", "application/json")
        .header(header::ORIGIN, origin)
        .header(header::AUTHORIZATION, "Bearer unused-token")
        .body(Body::from(
            serde_json::json!({
                "vaultSessionRootDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "humanProof": "oschip2:passkey:{}",
                "credentialIdB64": "cred",
                "publicKeySpkiB64": "unused",
                "signCount": 1,
            })
            .to_string(),
        ))
        .unwrap();
    assert_root_key_not_enrolled(app.oneshot(register).await.unwrap()).await;
    assert!(!state
        .cli_app_integration
        .lock()
        .unwrap()
        .pairings
        .is_root_key_enrolled());
}
