//! Whatever answers at the helper's socket path must learn nothing that
//! authorizes anything (ADR 0138 §2).
//!
//! A process running as the operator's user can unlink the daemon's socket
//! and listen at the same path. A helper started from the operator's shell
//! inherits `OPENSESAME_OPERATOR_TOKEN`, the bearer that admits every operator
//! route. If the helper forwarded it, the impostor would hold the operator's
//! whole authority after one mint. This test stands in for that impostor: it
//! listens at the socket path, records the one request it is sent and refuses
//! it, and asserts the request carried no operator token and no credential
//! header of any kind.
#![cfg(unix)]

use std::io::{Read, Write};
use std::os::unix::net::UnixListener;
use std::path::Path;

/// A value no request may contain.
const OPERATOR_TOKEN: &str = "vtok_impostor_probe_operator_0123456789abcdef";

/// The whole request once its declared body has arrived.
fn read_request(stream: &mut impl Read) -> String {
    let mut raw = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let read = stream.read(&mut chunk).expect("impostor read");
        if read == 0 {
            break;
        }
        raw.extend_from_slice(&chunk[..read]);
        let Some(end) = raw.windows(4).position(|window| window == b"\r\n\r\n") else {
            continue;
        };
        let head = String::from_utf8_lossy(&raw[..end]).to_ascii_lowercase();
        let declared = head
            .lines()
            .find_map(|line| line.strip_prefix("content-length:"))
            .and_then(|value| value.trim().parse::<usize>().ok())
            .unwrap_or(0);
        if raw.len() >= end + 4 + declared {
            break;
        }
    }
    String::from_utf8_lossy(&raw).into_owned()
}

/// Listen at `sock`, take one request, answer `401`, and hand the request back.
fn impostor(sock: &Path) -> std::thread::JoinHandle<String> {
    let listener = UnixListener::bind(sock).expect("bind the impostor socket");
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept the helper");
        let request = read_request(&mut stream);
        stream
            .write_all(
                b"HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
            )
            .expect("impostor answer");
        request
    })
}

#[test]
fn an_impostor_at_the_socket_path_never_receives_the_operator_token() {
    let dir = tempfile::tempdir().expect("tempdir");
    let sock = dir.path().join("agent.sock");
    let seen = impostor(&sock);
    // The helper's environment holds the operator token, as it does when the
    // operator starts git or docker from their own shell. This binary runs
    // this one test, so nothing else reads the environment meanwhile.
    std::env::set_var("OPENSESAME_OPERATOR_TOKEN", OPERATOR_TOKEN);

    let refused = opensesame_credential_helpers::DaemonClient::new(sock)
        .mint("conn_probe", Some("777"))
        .is_err();
    let request = seen.join().expect("impostor thread");
    let lowered = request.to_ascii_lowercase();

    assert!(refused, "a 401 must not read as a mint");
    assert!(
        request.starts_with("POST /v1/mint "),
        "the impostor must have been asked to mint"
    );
    assert!(
        !request.contains(OPERATOR_TOKEN),
        "the operator token reached whatever answered at the socket path"
    );
    for header in ["x-opensesame-operator", "authorization", "cookie"] {
        assert!(
            !lowered.contains(&format!("\r\n{header}:")),
            "the helper sent a {header} header to the socket"
        );
    }
}
