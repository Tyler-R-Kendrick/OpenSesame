use super::*;
use axum::body::Body;
use axum::extract::connect_info::ConnectInfo;
use axum::http::{header, Request, StatusCode};
use opensesame_cli_app_integration::session_id_from_pid;
use opensesame_uds_authn::PeerCred;
use tower::ServiceExt;

use crate::peer_auth::UdsConnectInfo;
use crate::App;

fn ensure_body(terminal_session_id: &str) -> String {
    serde_json::json!({
        "terminalSessionId": terminal_session_id,
        "verb": "read",
    })
    .to_string()
}

fn pair_browser(app: &App, origin: &str) -> String {
    let now = chrono::Utc::now().timestamp() as u64;
    let (code, _) = app
        .cli_app_integration
        .lock()
        .unwrap()
        .pairings
        .issue(origin, now)
        .unwrap();
    app.cli_app_integration
        .lock()
        .unwrap()
        .pairings
        .exchange(&code, origin, now)
        .unwrap()
        .token
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
                "humanProof": "oschip1:passkey:0000000000000000000000000000000000000000000000000000000000000000",
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
    let correlation = "tcp-correlation-1";
    let body = ensure_body(correlation);
    let req = Request::builder()
        .method("POST")
        .uri("/v1/cli/app-integration/ensure")
        .header("content-type", "application/json")
        .body(Body::from(body))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
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
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let nonce = parsed["pending"][0]["respondNonce"]
        .as_str()
        .expect("nonce");
    let respond = Request::builder()
        .method("POST")
        .uri("/v1/cli/app-integration/respond")
        .header("content-type", "application/json")
        .header(header::ORIGIN, origin)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::from(
            serde_json::json!({
                "requestId": request_id,
                "terminalSessionId": correlation,
                "decision": "approve",
                "respondNonce": nonce,
                "humanProof": "oschip1:passkey:0000000000000000000000000000000000000000000000000000000000000000",
            })
            .to_string(),
        ))
        .unwrap();
    let res = app.clone().oneshot(respond).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let req = Request::builder()
        .method("POST")
        .uri("/v1/cli/app-integration/ensure")
        .header("content-type", "application/json")
        .body(Body::from(ensure_body(correlation)))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(parsed["status"], "approved");
    let req = Request::builder()
        .method("POST")
        .uri("/v1/cli/app-integration/ensure")
        .header("content-type", "application/json")
        .body(Body::from(ensure_body(correlation)))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(parsed["status"], "pending");
}
