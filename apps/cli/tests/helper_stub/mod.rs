//! The scripted daemon and the helper runner the credential-helper tests
//! share: a stub on a temporary Unix socket that records each request body
//! and answers a canned status and body.
#![allow(dead_code)]

use std::io::{Read, Write};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Mutex};

/// A scripted daemon: accepts `requests` connections, records each request
/// body, and answers with the canned status/body.
pub struct StubDaemon {
    pub sock: PathBuf,
    pub requests: Arc<Mutex<Vec<String>>>,
    /// The request line and headers of each request, in arrival order.
    pub heads: Arc<Mutex<Vec<String>>>,
    _dir: tempfile::TempDir,
}

#[expect(
    clippy::excessive_nesting,
    reason = "the cohesive stub keeps one scripted HTTP exchange readable in place"
)]
pub fn spawn_stub_daemon(status: u16, body: &str, requests: usize) -> StubDaemon {
    let dir = tempfile::tempdir().expect("tempdir");
    let sock = dir.path().join("agent.sock");
    let listener = UnixListener::bind(&sock).expect("bind stub uds");
    let recorded = Arc::new(Mutex::new(Vec::new()));
    let recorded_task = recorded.clone();
    let heads = Arc::new(Mutex::new(Vec::new()));
    let heads_task = heads.clone();
    let body = body.to_string();
    std::thread::spawn(move || {
        for stream in listener.incoming().take(requests) {
            let mut stream = stream.expect("accept");
            let mut raw = Vec::new();
            let mut chunk = [0u8; 4096];
            // Read until the request body is complete; the helpers send one
            // small POST and half-close nothing, so read with a deadline.
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .ok();
            loop {
                match stream.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        raw.extend_from_slice(&chunk[..n]);
                        let text = String::from_utf8_lossy(&raw);
                        let Some((head, body)) = text.split_once("\r\n\r\n") else {
                            continue;
                        };
                        let len = head
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length: ")
                                    .and_then(|v| v.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if body.len() >= len {
                            break;
                        }
                    }
                }
            }
            let text = String::from_utf8_lossy(&raw).to_string();
            let request_body = text
                .split_once("\r\n\r\n")
                .map(|(_, body)| body.to_string())
                .unwrap_or_default();
            recorded_task.lock().unwrap().push(request_body);
            heads_task.lock().unwrap().push(
                text.split_once("\r\n\r\n")
                    .map(|(head, _)| head.to_string())
                    .unwrap_or_default(),
            );
            let response = format!(
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream
                .write_all(response.as_bytes())
                .expect("write response");
        }
    });
    StubDaemon {
        sock,
        requests: recorded,
        heads,
        _dir: dir,
    }
}

/// Drop every `OPENSESAME_*` variable `command` would inherit, so what a
/// child sees is only what the test sets. A shell configured as the operator
/// guide documents exports `OPENSESAME_GITHUB_INSTALLATION_ID`, a connection
/// id or a socket path, and any of them would change what a helper asks for.
pub fn without_inherited_opensesame_env(command: &mut Command) -> &mut Command {
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("OPENSESAME_") {
            command.env_remove(key);
        }
    }
    command
}

pub fn run_helper(bin: &str, args: &[&str], stdin: &str, envs: &[(&str, &str)]) -> Output {
    let mut command = Command::new(bin);
    without_inherited_opensesame_env(&mut command)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in envs {
        command.env(key, value);
    }
    let mut child = command.spawn().expect("spawn helper");
    // store/erase exit without reading stdin; a broken pipe there is fine.
    if let Some(mut pipe) = child.stdin.take() {
        let _ = pipe.write_all(stdin.as_bytes());
    }
    child.wait_with_output().expect("wait")
}
