//! `POST /v1/mint` admission (ADR 0138 §2): peer credentials on the Unix
//! socket, the operator token over TCP.

use super::*;

/// A `/v1/mint` request as it arrives on the Unix socket: axum inserts the
/// peer's kernel-attested credentials per connection (`None` when the kernel
/// attested nothing).
#[cfg(unix)]
fn uds_request(uid: Option<u32>, with_token: bool, origin: Option<&str>) -> Request<Body> {
    let mut req = request(r#"{"connection_id":"conn_stub"}"#, with_token);
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

#[cfg(unix)]
async fn error_of(res: Response) -> Value {
    let bytes = to_bytes(res.into_body(), 4096).await.unwrap();
    serde_json::from_slice(&bytes).unwrap_or(Value::Null)
}

/// ADR 0138 §2: on the socket a helper is admitted by its peer credentials and
/// carries no bearer it could leak.
#[cfg(unix)]
#[tokio::test]
async fn a_same_uid_peer_on_the_socket_mints_without_a_token() {
    let (state, calls) = minting_gateway().await;
    let own = state.allowed_uids[0];
    let res = router(state)
        .oneshot(uds_request(Some(own), false, None))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(calls.lock().unwrap().len(), 1, "the mint was not forwarded");
}

#[cfg(unix)]
#[tokio::test]
async fn a_foreign_uid_on_the_socket_is_refused_even_with_a_valid_token() {
    let (state, calls) = minting_gateway().await;
    let foreign = state.allowed_uids[0] + 1;
    let res = router(state)
        .oneshot(uds_request(Some(foreign), true, None))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(error_of(res).await["error"], "uds_peer_unauthorized");
    assert!(calls.lock().unwrap().is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn an_unattested_peer_on_the_socket_is_503() {
    let (state, calls) = minting_gateway().await;
    let res = router(state)
        .oneshot(uds_request(None, true, None))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(error_of(res).await["error"], "uds_peer_unattested");
    assert!(calls.lock().unwrap().is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn a_browser_origin_on_the_socket_is_refused() {
    let (state, calls) = minting_gateway().await;
    let own = state.allowed_uids[0];
    let res = router(state)
        .oneshot(uds_request(Some(own), true, Some("https://evil.example")))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    assert!(calls.lock().unwrap().is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn the_socket_budget_is_per_peer_uid() {
    let state = test_state("http://127.0.0.1:1");
    let own = state.allowed_uids[0];
    let app = router(state);
    let first = app
        .clone()
        .oneshot(uds_request(Some(own), false, None))
        .await
        .unwrap();
    // Admitted and within budget; the unreachable gateway answers 502.
    assert_eq!(first.status(), StatusCode::BAD_GATEWAY);
    let second = app
        .oneshot(uds_request(Some(own), false, None))
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
    assert_eq!(calls.lock().unwrap().len(), 1);
}
