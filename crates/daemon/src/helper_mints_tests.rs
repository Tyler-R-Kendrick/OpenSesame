//! The helper-mint grants: written only with the operator token, a connection
//! and the one installation named, kept owner-only across a restart, and empty
//! whenever they cannot be read or are of another shape.

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
    assert!(state.helper_mints.admits("conn_stub", None));
    let listed = app
        .clone()
        .oneshot(call("GET", "/v1/helper-mints", token))
        .await
        .unwrap();
    assert_eq!(
        json_of(listed).await["grants"],
        json!([{"connection_id": "conn_stub", "installation_id": null}])
    );

    let res = app
        .oneshot(call("DELETE", "/v1/helper-mints/conn_stub", token))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert!(!state.helper_mints.admits("conn_stub", None));
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
    assert!(!state.helper_mints.admits("conn_stub", None));
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
    mints.grant("conn_one", None).unwrap();
    mints.grant("conn_two", Some("777")).unwrap();
    mints.revoke("conn_one").unwrap();
    let reopened = HelperMints::open(Some(dir.path()));
    assert!(reopened.admits("conn_two", Some("777")));
    assert!(!reopened.admits("conn_two", Some("778")));
    assert!(!reopened.admits("conn_two", None));
    assert!(!reopened.admits("conn_one", None));
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
    assert!(!mints.admits("conn_stub", None));
}

/// The connection-only list an earlier build wrote names no installation, so
/// it is refused rather than read as "any installation".
#[test]
fn a_list_of_another_shape_admits_nothing() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join(FILE_NAME),
        r#"{"connections":["conn_stub"]}"#,
    )
    .unwrap();
    let mints = HelperMints::open(Some(dir.path()));
    assert!(mints.list().is_empty());
    assert!(!mints.admits("conn_stub", None));
    assert!(!mints.admits("conn_stub", Some("777")));
}

#[tokio::test]
async fn an_installation_is_digits_or_refused() {
    let state = test_state("http://127.0.0.1:1");
    let app = router(state.clone());
    for body in [
        r#"{"installation_id":"77a"}"#,
        r#"{"installation_id":""}"#,
        r#"{"installation_id":"777","scopes":["repo"]}"#,
        "not json",
    ] {
        let req = Request::builder()
            .method("PUT")
            .uri("/v1/helper-mints/conn_stub")
            .header("x-opensesame-operator", crate::test_operator_token())
            .body(Body::from(body))
            .unwrap();
        let answer = app.clone().oneshot(req).await.unwrap();
        assert_eq!(answer.status(), StatusCode::BAD_REQUEST, "{body}");
    }
    assert!(state.helper_mints.list().is_empty());
}
