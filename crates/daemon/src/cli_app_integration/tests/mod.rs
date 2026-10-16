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

pub(super) fn ensure_body(terminal_session_id: &str) -> String {
    serde_json::json!({
        "terminalSessionId": terminal_session_id,
        "verb": "read",
    })
    .to_string()
}

pub(super) fn pair_browser(state: &App, origin: &str) -> String {
    let now = now_unix();
    test_support::pair_browser_for_tests(
        &mut state.cli_app_integration.lock().unwrap().pairings,
        origin,
        now,
    )
}

#[cfg(unix)]
pub(super) fn test_peer_cred() -> PeerCred {
    PeerCred {
        pid: std::process::id(),
        uid: 0,
        gid: 0,
    }
}
#[cfg(unix)]
fn with_uds_peer(mut req: Request<Body>, cred: Option<PeerCred>) -> Request<Body> {
    req.extensions_mut()
        .insert(ConnectInfo(UdsConnectInfo(cred)));
    req
}
#[cfg(unix)]
pub(super) fn ensure_request(body: &str, cred: Option<PeerCred>) -> Request<Body> {
    let req = Request::builder()
        .method("POST")
        .uri("/v1/cli/app-integration/ensure")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    with_uds_peer(req, cred)
}
#[cfg(unix)]
pub(super) fn respond_request(
    body: &str,
    origin: &str,
    token: &str,
    cred: Option<PeerCred>,
) -> Request<Body> {
    let req = Request::builder()
        .method("POST")
        .uri("/v1/cli/app-integration/respond")
        .header("content-type", "application/json")
        .header(header::ORIGIN, origin)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::from(body.to_string()))
        .unwrap();
    with_uds_peer(req, cred)
}

#[cfg(unix)]
#[tokio::test]
async fn ensure_over_uds_ignores_body_terminal_session_id() {
    use crate::test_fixtures::test_router;

    let (app, state) = test_router("http://127.0.0.1:8787");
    let origin = "http://localhost:5180";
    let token = pair_browser(&state, origin);
    let cred = test_peer_cred();
    let derived = session_id_from_pid(cred.pid).expect("derived session");
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
    let human_proof =
        test_support::mint_test_human_proof(request_id, &derived, nonce, "read", cred.pid, 0);
    let respond_body = serde_json::json!({"requestId": request_id,"terminalSessionId": derived,"decision": "approve","respondNonce": nonce,"humanProof": human_proof}).to_string();
    let respond = respond_request(&respond_body, origin, &token, Some(cred));
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
async fn tcp_ensure_and_respond_require_uds_peer() {
    use crate::test_fixtures::test_router;
    let (app, state) = test_router("http://127.0.0.1:8787");
    let origin = "http://localhost:5180";
    let token = pair_browser(&state, origin);
    let body = ensure_body("tcp-forged");
    let tcp_peer = ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 4242)));
    let mut ensure_req = Request::builder()
        .method("POST")
        .uri("/v1/cli/app-integration/ensure")
        .header("content-type", "application/json")
        .body(Body::from(body))
        .unwrap();
    ensure_req.extensions_mut().insert(tcp_peer);
    let response = app.clone().oneshot(ensure_req).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(parsed["error"], "uds_peer_required");
    let respond = Request::builder().method("POST").uri("/v1/cli/app-integration/respond").header("content-type", "application/json").header(header::ORIGIN, origin).header(header::AUTHORIZATION, format!("Bearer {token}")).body(Body::from(serde_json::json!({"requestId": "clr_1","terminalSessionId": "term-tcp","decision": "approve","respondNonce": "nonce","humanProof": "oschip2:passkey:{}"}).to_string())).unwrap();
    let response = app.clone().oneshot(respond).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}
