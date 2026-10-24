//! `POST /v1/mint` admission (ADR 0138 §2, as amended): on the Unix socket,
//! the attested peer and then the operator token or a connection the operator
//! allowed for helper minting; over TCP, the operator token.

use super::*;

/// A `/v1/mint` request as it arrives on the Unix socket: axum inserts the
/// peer's kernel-attested credentials per connection (`None` when the kernel
/// attested nothing).
#[cfg(unix)]
fn uds_request(uid: Option<u32>, token: Option<&str>, origin: Option<&str>) -> Request<Body> {
    let mut req = request(r#"{"connection_id":"conn_stub"}"#, false);
    if let Some(token) = token {
        req.headers_mut()
            .insert("x-opensesame-operator", token.parse().expect("token"));
    }
    if let Some(origin) = origin {
        req.headers_mut()
            .insert("origin", origin.parse().expect("origin header"));
    }
    let cred = uid.map(|uid| opensesame_uds_authn::PeerCred {
        pid: 4242,
        uid,
        gid: uid,
    });
    req.extensions_mut()
        .insert(ConnectInfo(crate::UdsConnectInfo(cred)));
    req
}

/// A mint the gateway answers, and the daemon state that forwards to it.
async fn minting_gateway() -> (App, Arc<Mutex<Vec<Value>>>) {
    let (gateway, calls) = spawn_gateway(
        StatusCode::OK,
        json!({"derived_token": "ghs_derived-token"}),
    )
    .await;
    (test_state(&gateway), calls)
}

/// The same, with `conn_stub` allowed for helper minting.
#[cfg(unix)]
async fn allowed_gateway() -> (App, Arc<Mutex<Vec<Value>>>) {
    let (state, calls) = minting_gateway().await;
    state.helper_mints.set("conn_stub", true).expect("allow");
    (state, calls)
}

#[cfg(unix)]
async fn error_of(res: Response) -> Value {
    let bytes = to_bytes(res.into_body(), 4096).await.unwrap();
    serde_json::from_slice(&bytes).unwrap_or(Value::Null)
}

/// ADR 0138 §2: a helper carries no bearer; its peer credentials and the
/// operator's allowlist admit it, and the Host learns which process asked.
#[cfg(unix)]
#[tokio::test]
async fn a_same_uid_peer_mints_an_allowed_connection_without_a_token() {
    let (state, calls) = allowed_gateway().await;
    let own = state.allowed_uids[0];
    let res = router(state)
        .oneshot(uds_request(Some(own), None, None))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let calls = calls.lock().unwrap();
    assert_eq!(calls.len(), 1, "the mint was not forwarded");
    assert_eq!(
        calls[0]["on_behalf_of"],
        json!({"uid": own, "pid": 4242}),
        "{}",
        calls[0]
    );
}

#[cfg(unix)]
#[tokio::test]
async fn a_connection_the_operator_did_not_allow_is_refused_on_the_socket() {
    let (state, calls) = minting_gateway().await;
    let own = state.allowed_uids[0];
    let res = router(state)
        .oneshot(uds_request(Some(own), None, None))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    assert_eq!(error_of(res).await["error"], "helper_mint_not_allowed");
    assert!(calls.lock().unwrap().is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn the_operator_token_on_the_socket_admits_any_connection() {
    let (state, calls) = minting_gateway().await;
    let own = state.allowed_uids[0];
    let res = router(state)
        .oneshot(uds_request(
            Some(own),
            Some(crate::test_operator_token()),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let calls = calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["on_behalf_of"]["pid"], 4242);
}

#[cfg(unix)]
#[tokio::test]
async fn a_wrong_token_on_the_socket_is_refused_not_sent_to_the_allowlist() {
    let (state, calls) = allowed_gateway().await;
    let own = state.allowed_uids[0];
    let res = router(state)
        .oneshot(uds_request(Some(own), Some("not-the-operator-token"), None))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    assert!(calls.lock().unwrap().is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn a_foreign_uid_on_the_socket_is_refused_even_with_a_valid_token() {
    let (state, calls) = allowed_gateway().await;
    let foreign = state.allowed_uids[0] + 1;
    let res = router(state)
        .oneshot(uds_request(
            Some(foreign),
            Some(crate::test_operator_token()),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(error_of(res).await["error"], "uds_peer_unauthorized");
    assert!(calls.lock().unwrap().is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn an_unattested_peer_on_the_socket_is_503() {
    let (state, calls) = allowed_gateway().await;
    let res = router(state)
        .oneshot(uds_request(None, None, None))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(error_of(res).await["error"], "uds_peer_unattested");
    assert!(calls.lock().unwrap().is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn a_browser_origin_on_the_socket_is_refused() {
    let (state, calls) = allowed_gateway().await;
    let own = state.allowed_uids[0];
    let res = router(state)
        .oneshot(uds_request(Some(own), None, Some("https://evil.example")))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    assert!(calls.lock().unwrap().is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn the_socket_budget_is_per_peer_uid() {
    let state = test_state("http://127.0.0.1:1");
    state.helper_mints.set("conn_stub", true).expect("allow");
    let own = state.allowed_uids[0];
    let app = router(state);
    let first = app
        .clone()
        .oneshot(uds_request(Some(own), None, None))
        .await
        .unwrap();
    // Admitted and within budget; the unreachable gateway answers 502.
    assert_eq!(first.status(), StatusCode::BAD_GATEWAY);
    let second = app
        .oneshot(uds_request(Some(own), None, None))
        .await
        .unwrap();
    assert_eq!(second.status(), StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn over_tcp_the_operator_token_is_still_required() {
    let (state, calls) = minting_gateway().await;
    let app = router(state);
    let refused = app
        .clone()
        .oneshot(request(r#"{"connection_id":"conn_stub"}"#, false))
        .await
        .unwrap();
    assert_eq!(refused.status(), StatusCode::UNAUTHORIZED);
    assert!(calls.lock().unwrap().is_empty());
    let admitted = app
        .oneshot(request(r#"{"connection_id":"conn_stub"}"#, true))
        .await
        .unwrap();
    assert_eq!(admitted.status(), StatusCode::OK);
    let calls = calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    // Over TCP the daemon knows no process to name.
    assert!(calls[0].get("on_behalf_of").is_none(), "{}", calls[0]);
}
