use super::*;

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
