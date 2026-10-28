//! Unix-domain socket refusal tests.

use super::serve;

#[test]
fn serve_refuses_a_live_socket_without_running_anything() {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("live.sock");
    let _listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
    let error = serve::run(Some(socket), false, None)
        .unwrap_err()
        .to_string();
    assert!(error.contains("refusing to take over"), "{error}");
}

#[test]
fn bind_socket_for_stale_fixture() {
    let Some(socket) = std::env::var_os("OPENSESAME_TEST_SOCKET_CHILD") else {
        return;
    };
    drop(std::os::unix::net::UnixListener::bind(socket).unwrap());
}

#[test]
fn serve_refuses_a_stale_socket_unless_takeover_is_asked_for() {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("stale.sock");
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "bridge::unix_tests::bind_socket_for_stale_fixture",
            "--exact",
        ])
        .env("OPENSESAME_TEST_SOCKET_CHILD", &socket)
        .stdout(std::process::Stdio::null())
        .status()
        .unwrap();
    assert!(status.success(), "stale fixture child failed: {status}");
    let error = serve::run(Some(socket), false, None)
        .unwrap_err()
        .to_string();
    assert!(error.contains("--takeover"), "{error}");
}
