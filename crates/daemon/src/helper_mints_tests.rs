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
    let mints = HelperMints::open(Some(dir.path()), crate::test_operator_token());
    assert!(mints.list().is_empty(), "the list starts empty");
    mints.grant("conn_one", None).unwrap();
    mints.grant("conn_two", Some("777")).unwrap();
    mints.revoke("conn_one").unwrap();
    let reopened = HelperMints::open(Some(dir.path()), crate::test_operator_token());
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
    let mints = HelperMints::open(Some(dir.path()), crate::test_operator_token());
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
    let mints = HelperMints::open(Some(dir.path()), crate::test_operator_token());
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

/// A token other than the one the daemon runs with.
const OTHER_TOKEN: &str = "another-operator-token-0123456789abcdefghij";

fn grant_file(dir: &std::path::Path) -> Value {
    serde_json::from_slice(&std::fs::read(dir.join(FILE_NAME)).unwrap()).unwrap()
}

fn rewrite(dir: &std::path::Path, file: &Value) {
    std::fs::write(dir.join(FILE_NAME), serde_json::to_vec(file).unwrap()).unwrap();
}

/// A same-UID process can write the daemon's state directory. A grant it adds
/// by hand is not one the operator made, so after a restart nothing in the
/// edited file is in force, the grant the operator did make included.
#[test]
fn a_grant_added_by_hand_admits_nothing_after_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let token = crate::test_operator_token();
    HelperMints::open(Some(dir.path()), token)
        .grant("conn_one", None)
        .unwrap();
    let mut file = grant_file(dir.path());
    file["grants"]
        .as_array_mut()
        .unwrap()
        .push(json!({"connection_id": "conn_forged", "installation_id": null}));
    rewrite(dir.path(), &file);
    let reopened = HelperMints::open(Some(dir.path()), token);
    assert!(!reopened.admits("conn_forged", None));
    assert!(!reopened.admits("conn_one", None));
    assert!(reopened.list().is_empty());
}

#[test]
fn a_tampered_installation_admits_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let token = crate::test_operator_token();
    HelperMints::open(Some(dir.path()), token)
        .grant("conn_app", Some("777"))
        .unwrap();
    let mut file = grant_file(dir.path());
    file["grants"][0]["installation_id"] = json!("778");
    rewrite(dir.path(), &file);
    let reopened = HelperMints::open(Some(dir.path()), token);
    assert!(!reopened.admits("conn_app", Some("778")));
    assert!(!reopened.admits("conn_app", Some("777")));
}

/// The file's key comes from the operator token, so grants written under one
/// token admit nothing under the next: rotating the token invalidates them.
#[test]
fn grants_written_under_another_token_admit_nothing() {
    let dir = tempfile::tempdir().unwrap();
    HelperMints::open(Some(dir.path()), OTHER_TOKEN)
        .grant("conn_one", Some("777"))
        .unwrap();
    let reopened = HelperMints::open(Some(dir.path()), crate::test_operator_token());
    assert!(!reopened.admits("conn_one", Some("777")));
    assert!(reopened.list().is_empty());
}

/// The list says why it is empty when the stored grants were refused, and a
/// grant written afterwards is authenticated again.
#[tokio::test]
async fn the_list_says_when_stored_grants_were_refused() {
    let dir = tempfile::tempdir().unwrap();
    HelperMints::open(Some(dir.path()), OTHER_TOKEN)
        .grant("conn_one", None)
        .unwrap();
    let mut state = test_state("http://127.0.0.1:1");
    state.helper_mints = std::sync::Arc::new(HelperMints::open(
        Some(dir.path()),
        crate::test_operator_token(),
    ));
    let app = router(state);
    let token = Some(crate::test_operator_token());
    let listed = app
        .clone()
        .oneshot(call("GET", "/v1/helper-mints", token))
        .await
        .unwrap();
    let listed = json_of(listed).await;
    assert_eq!(listed["grants"], json!([]));
    assert_eq!(listed["stored"], "unauthenticated", "{listed}");

    let allowed = app
        .clone()
        .oneshot(call("PUT", "/v1/helper-mints/conn_two", token))
        .await
        .unwrap();
    assert_eq!(allowed.status(), StatusCode::OK);
    let listed = json_of(
        app.oneshot(call("GET", "/v1/helper-mints", token))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(listed["stored"], "authenticated", "{listed}");
}

/// The grant file the previous build wrote carries no MAC: it admits nothing.
#[test]
fn a_grant_file_without_a_mac_admits_nothing() {
    let dir = tempfile::tempdir().unwrap();
    rewrite(
        dir.path(),
        &json!({"version": 2, "grants": [{"connection_id": "conn_stub", "installation_id": null}]}),
    );
    let mints = HelperMints::open(Some(dir.path()), crate::test_operator_token());
    assert!(!mints.admits("conn_stub", None));
}
