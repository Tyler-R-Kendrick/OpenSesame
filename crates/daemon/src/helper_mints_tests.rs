//! The helper-mint allowlist: written only with the operator token, kept
//! owner-only across a restart, and empty whenever it cannot be read.

use super::*;
use crate::{router, tests::test_state};
use axum::body::{to_bytes, Body};
use axum::http::Request;
use serde_json::Value;
use tower::ServiceExt;

fn call(method: &str, uri: &str, token: Option<&str>) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        builder = builder.header("x-opensesame-operator", token);
    }
    builder.body(Body::empty()).unwrap()
}

/// The same request as it arrives on the Unix socket from `uid`.
#[cfg(unix)]
fn on_socket(mut req: Request<Body>, uid: u32) -> Request<Body> {
    req.extensions_mut()
        .insert(axum::extract::ConnectInfo(crate::UdsConnectInfo(Some(
            opensesame_uds_authn::PeerCred {
                pid: 4242,
                uid,
                gid: uid,
            },
        ))));
    req
}

async fn json_of(res: Response) -> Value {
    let bytes = to_bytes(res.into_body(), 4096).await.unwrap();
    serde_json::from_slice(&bytes).unwrap_or(Value::Null)
}

#[tokio::test]
async fn allow_list_and_revoke_need_the_operator_token() {
    let state = test_state("http://127.0.0.1:1");
    let app = router(state.clone());
    let token = Some(crate::test_operator_token());
    for (method, uri) in [
        ("PUT", "/v1/helper-mints/conn_stub"),
        ("DELETE", "/v1/helper-mints/conn_stub"),
        ("GET", "/v1/helper-mints"),
    ] {
        let res = app.clone().oneshot(call(method, uri, None)).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED, "{method} {uri}");
    }
    assert!(state.helper_mints.list().is_empty());

    let res = app
        .clone()
        .oneshot(call("PUT", "/v1/helper-mints/conn_stub", token))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert!(state.helper_mints.allows("conn_stub"));
    let listed = app
        .clone()
        .oneshot(call("GET", "/v1/helper-mints", token))
        .await
        .unwrap();
    assert_eq!(json_of(listed).await["connections"], json!(["conn_stub"]));

    let res = app
        .oneshot(call("DELETE", "/v1/helper-mints/conn_stub", token))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert!(!state.helper_mints.allows("conn_stub"));
}

/// A same-UID process on the socket, which may mint an allowed connection,
/// cannot allow one: that needs the operator token on every transport.
#[cfg(unix)]
#[tokio::test]
async fn a_socket_peer_cannot_allow_a_connection_without_the_token() {
    let state = test_state("http://127.0.0.1:1");
    let own = state.allowed_uids[0];
    let res = router(state.clone())
        .oneshot(on_socket(
            call("PUT", "/v1/helper-mints/conn_stub", None),
            own,
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    assert!(!state.helper_mints.allows("conn_stub"));
}

#[tokio::test]
async fn an_unsafe_connection_id_is_never_allowed() {
    let state = test_state("http://127.0.0.1:1");
    let res = router(state.clone())
        .oneshot(call(
            "PUT",
            "/v1/helper-mints/a%2Fb",
            Some(crate::test_operator_token()),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert!(state.helper_mints.list().is_empty());
}

#[test]
fn the_list_survives_a_restart_owner_only() {
    let dir = tempfile::tempdir().unwrap();
    let mints = HelperMints::open(Some(dir.path()));
    assert!(mints.list().is_empty(), "the list starts empty");
    mints.set("conn_one", true).unwrap();
    mints.set("conn_two", true).unwrap();
    mints.set("conn_one", false).unwrap();
    let reopened = HelperMints::open(Some(dir.path()));
    assert_eq!(reopened.list(), ["conn_two"]);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(dir.path().join(FILE_NAME))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}

#[test]
fn an_unreadable_list_admits_nothing() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(FILE_NAME), "{not json").unwrap();
    let mints = HelperMints::open(Some(dir.path()));
    assert!(mints.list().is_empty());
    assert!(!mints.allows("conn_stub"));
}
