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
    state.helper_mints.grant("conn_stub", None).expect("allow");
    (state, calls)
}

/// A grant the operator made through the route outlives a restart: the file
/// is authenticated under the same token, and a helper mints with it.
#[cfg(unix)]
#[tokio::test]
async fn a_grant_made_through_the_route_survives_a_restart_and_mints() {
    use crate::helper_mints::HelperMints;
    let dir = tempfile::tempdir().unwrap();
    let token = crate::test_operator_token();
    let (mut state, calls) = minting_gateway().await;
    state.helper_mints = Arc::new(HelperMints::open(Some(dir.path()), token));
    let allow = Request::builder()
        .method("PUT")
        .uri("/v1/helper-mints/conn_stub")
        .header("x-opensesame-operator", token)
        .body(Body::empty())
        .unwrap();
    let allowed = router(state.clone()).oneshot(allow).await.unwrap();
    assert_eq!(allowed.status(), StatusCode::OK);

    // The restart: the same token, the grants read back from disk.
    state.helper_mints = Arc::new(HelperMints::open(Some(dir.path()), token));
    let own = state.allowed_uids[0];
    let res = router(state)
        .oneshot(uds_request(Some(own), None, None))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(calls.lock().unwrap().len(), 1);
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
    state.helper_mints.grant("conn_stub", None).expect("allow");
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

/// A token-less socket mint of `conn_stub`, for `installation`.
#[cfg(unix)]
fn uds_mint_for(uid: u32, installation: Option<&str>) -> Request<Body> {
    let body = match installation {
        Some(id) => json!({"connection_id": "conn_stub", "installation_id": id}),
        None => json!({"connection_id": "conn_stub"}),
    };
    let mut req = request(&body.to_string(), false);
    req.extensions_mut()
        .insert(ConnectInfo(crate::UdsConnectInfo(Some(
            opensesame_uds_authn::PeerCred {
                pid: 4242,
                uid,
                gid: uid,
            },
        ))));
    req
}

/// The operator allows `conn_stub` through the daemon's own route.
async fn allow_route(app: &axum::Router, body: Value) -> StatusCode {
    let req = Request::builder()
        .method("PUT")
        .uri("/v1/helper-mints/conn_stub")
        .header("x-opensesame-operator", crate::test_operator_token())
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    app.clone().oneshot(req).await.unwrap().status()
}

/// A GitHub App connection reaches every installation of the App, so a helper
/// grant names the one installation the operator meant; the caller cannot
/// choose another (each may be a different account's repositories).
#[cfg(unix)]
#[tokio::test]
async fn a_helper_grant_is_bound_to_the_installation_the_operator_named() {
    let (state, calls) = minting_gateway().await;
    let own = state.allowed_uids[0];
    let app = router(state);
    assert_eq!(
        allow_route(&app, json!({"installation_id": "777"})).await,
        StatusCode::OK
    );
    for other in [Some("778"), None] {
        let res = app.clone().oneshot(uds_mint_for(own, other)).await.unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN, "{other:?}");
        assert_eq!(error_of(res).await["error"], "helper_mint_not_allowed");
    }
    assert!(
        calls.lock().unwrap().is_empty(),
        "a mismatch reached the Host"
    );
    let res = app.oneshot(uds_mint_for(own, Some("777"))).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(calls.lock().unwrap()[0]["installation_id"], "777");
}

/// A grant that names no installation admits no installation either.
#[cfg(unix)]
#[tokio::test]
async fn a_grant_without_an_installation_refuses_a_caller_who_names_one() {
    let (state, calls) = minting_gateway().await;
    let own = state.allowed_uids[0];
    let app = router(state);
    assert_eq!(allow_route(&app, json!({})).await, StatusCode::OK);
    let res = app
        .clone()
        .oneshot(uds_mint_for(own, Some("777")))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    assert!(calls.lock().unwrap().is_empty());
    let res = app.oneshot(uds_mint_for(own, None)).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
}

/// The operator token still admits any installation, as it always has.
#[cfg(unix)]
#[tokio::test]
async fn the_operator_token_on_the_socket_admits_any_installation() {
    let (state, calls) = minting_gateway().await;
    let own = state.allowed_uids[0];
    let app = router(state);
    assert_eq!(
        allow_route(&app, json!({"installation_id": "777"})).await,
        StatusCode::OK
    );
    let mut mint = uds_mint_for(own, Some("778"));
    mint.headers_mut().insert(
        "x-opensesame-operator",
        crate::test_operator_token().parse().unwrap(),
    );
    let answer = app.oneshot(mint).await.unwrap();
    assert_eq!(answer.status(), StatusCode::OK);
    assert_eq!(calls.lock().unwrap()[0]["installation_id"], "778");
}
