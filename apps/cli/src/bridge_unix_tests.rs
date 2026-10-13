//! Unix-domain socket refusal tests.

use super::serve;

#[test]
fn serve_refuses_a_live_socket_without_running_anything() {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("live.sock");
    let _listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
    let error = serve(Some(socket), false, None).unwrap_err().to_string();
    assert!(error.contains("refusing to take over"), "{error}");
}

#[test]
fn serve_refuses_a_stale_socket_unless_takeover_is_asked_for() {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("stale.sock");
    drop(std::os::unix::net::UnixListener::bind(&socket).unwrap());
    let error = serve(Some(socket), false, None).unwrap_err().to_string();
    assert!(error.contains("--takeover"), "{error}");
}
