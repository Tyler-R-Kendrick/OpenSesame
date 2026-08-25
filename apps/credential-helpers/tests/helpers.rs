//! End-to-end helper tests: each binary runs as a subprocess against a stub
//! daemon on a temporary Unix socket. Asserts the exact stdout protocol
//! shape on success, and non-zero exit with empty stdout on any daemon
//! refusal.
#![cfg(unix)]

use std::io::{Read, Write};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Mutex};

const CANARY: &str = "ghs_CANARY-derived-token";

/// A scripted daemon: accepts `requests` connections, records each request
/// body, and answers with the canned status/body.
struct StubDaemon {
    sock: PathBuf,
    requests: Arc<Mutex<Vec<String>>>,
    _dir: tempfile::TempDir,
}

fn spawn_stub_daemon(status: u16, body: &str, requests: usize) -> StubDaemon {
    let dir = tempfile::tempdir().expect("tempdir");
    let sock = dir.path().join("agent.sock");
    let listener = UnixListener::bind(&sock).expect("bind stub uds");
    let recorded = Arc::new(Mutex::new(Vec::new()));
    let recorded_task = recorded.clone();
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
        _dir: dir,
    }
}

fn run_helper(bin: &str, args: &[&str], stdin: &str, envs: &[(&str, &str)]) -> Output {
    let mut command = Command::new(bin);
    command
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

fn mint_body() -> String {
    format!(
        r#"{{"connection_id":"conn_test","provider_id":"github","kind":"github_app_installation","derived_token":"{CANARY}","expires_at":"2026-08-20T03:00:00Z","subject":"user:alice","actor":"operator","issued_at":"2026-08-20T02:00:00Z"}}"#
    )
}

// ——— git-credential-opensesame ————————————————————————————————————

const GIT_BIN: &str = env!("CARGO_BIN_EXE_git-credential-opensesame");

#[test]
fn git_get_prints_the_credential_protocol_shape() {
    let stub = spawn_stub_daemon(200, &mint_body(), 1);
    let out = run_helper(
        GIT_BIN,
        &["get"],
        "protocol=https\nhost=github.com\n\n",
        &[
            ("OPENSESAME_AGENT_SOCK", stub.sock.to_str().unwrap()),
            ("OPENSESAME_GIT_CONNECTION_ID", "conn_test"),
            ("OPENSESAME_GITHUB_INSTALLATION_ID", "12345678"),
        ],
    );
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert_eq!(
        stdout,
        format!("username=x-access-token\npassword={CANARY}\n\n")
    );
    // The daemon saw the mint request for the configured connection.
    let requests = stub.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    let body: serde_json::Value = serde_json::from_str(&requests[0]).unwrap();
    assert_eq!(body["connection_id"], "conn_test");
    assert_eq!(body["installation_id"], "12345678");
}

#[test]
fn git_store_and_erase_are_noop_success() {
    for op in ["store", "erase"] {
        let out = run_helper(GIT_BIN, &[op], "protocol=https\nhost=github.com\n\n", &[]);
        assert!(out.status.success(), "{op}");
        assert!(out.stdout.is_empty(), "{op}");
    }
}

#[test]
fn git_daemon_denial_exits_nonzero_with_empty_stdout() {
    let stub = spawn_stub_daemon(403, r#"{"error":"materialization_denied"}"#, 1);
    let out = run_helper(
        GIT_BIN,
        &["get"],
        "protocol=https\nhost=github.com\n\n",
        &[
            ("OPENSESAME_AGENT_SOCK", stub.sock.to_str().unwrap()),
            ("OPENSESAME_GIT_CONNECTION_ID", "conn_test"),
        ],
    );
    assert!(!out.status.success());
    assert!(out.stdout.is_empty());
    let stderr = String::from_utf8(out.stderr).unwrap();
    assert!(stderr.contains("denied"), "{stderr}");
    assert!(!stderr.contains(CANARY), "{stderr}");
}

#[test]
fn git_without_connection_id_fails_closed() {
    let out = run_helper(GIT_BIN, &["get"], "host=github.com\n\n", &[]);
    assert!(!out.status.success());
    assert!(out.stdout.is_empty());
    assert!(String::from_utf8_lossy(&out.stderr).contains("OPENSESAME_GIT_CONNECTION_ID"));
}

// ——— docker-credential-opensesame —————————————————————————————————

const DOCKER_BIN: &str = env!("CARGO_BIN_EXE_docker-credential-opensesame");

#[test]
fn docker_get_prints_the_json_shape() {
    let stub = spawn_stub_daemon(200, &mint_body(), 1);
    let out = run_helper(
        DOCKER_BIN,
        &["get"],
        "ghcr.io",
        &[
            ("OPENSESAME_AGENT_SOCK", stub.sock.to_str().unwrap()),
            ("OPENSESAME_DOCKER_CONNECTION_ID", "conn_test"),
        ],
    );
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(stdout["ServerURL"], "ghcr.io");
    assert_eq!(stdout["Username"], "x-access-token");
    assert_eq!(stdout["Secret"], CANARY);
}

#[test]
fn docker_list_is_empty_and_store_erase_noop() {
    let out = run_helper(DOCKER_BIN, &["list"], "", &[]);
    assert!(out.status.success());
    assert_eq!(String::from_utf8(out.stdout).unwrap().trim(), "{}");
    for op in ["store", "erase"] {
        let out = run_helper(DOCKER_BIN, &[op], "ghcr.io", &[]);
        assert!(out.status.success(), "{op}");
        assert!(out.stdout.is_empty(), "{op}");
    }
}

#[test]
fn docker_daemon_5xx_exits_nonzero_with_empty_stdout() {
    let stub = spawn_stub_daemon(502, r#"{"error":"host_api_unreachable"}"#, 1);
    let out = run_helper(
        DOCKER_BIN,
        &["get"],
        "ghcr.io",
        &[
            ("OPENSESAME_AGENT_SOCK", stub.sock.to_str().unwrap()),
            ("OPENSESAME_DOCKER_CONNECTION_ID", "conn_test"),
        ],
    );
    assert!(!out.status.success());
    assert!(out.stdout.is_empty());
}

// ——— opensesame-credential-process ————————————————————————————————

const AWS_BIN: &str = env!("CARGO_BIN_EXE_opensesame-credential-process");

#[test]
fn aws_unmintable_fails_closed_with_a_clear_message() {
    let stub = spawn_stub_daemon(422, r#"{"error":"unmintable"}"#, 1);
    let out = run_helper(
        AWS_BIN,
        &[],
        "",
        &[
            ("OPENSESAME_AGENT_SOCK", stub.sock.to_str().unwrap()),
            ("OPENSESAME_AWS_CONNECTION_ID", "conn_aws"),
        ],
    );
    assert!(!out.status.success());
    assert!(out.stdout.is_empty());
    let stderr = String::from_utf8(out.stderr).unwrap();
    assert!(stderr.contains("unmintable"), "{stderr}");
}

#[test]
fn aws_sts_shaped_mint_prints_the_credential_process_shape() {
    // When the aws mint arm lands, the daemon answer carries STS fields and
    // this binary must light up without a code change.
    let body = r#"{"connection_id":"conn_aws","provider_id":"aws","kind":"aws_sts_session","derived_token":"unused","access_key_id":"AKIATEST","secret_access_key":"secret","session_token":"session","expires_at":"2026-08-20T03:00:00Z"}"#;
    let stub = spawn_stub_daemon(200, body, 1);
    let out = run_helper(
        AWS_BIN,
        &[],
        "",
        &[
            ("OPENSESAME_AGENT_SOCK", stub.sock.to_str().unwrap()),
            ("OPENSESAME_AWS_CONNECTION_ID", "conn_aws"),
        ],
    );
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(stdout["Version"], 1);
    assert_eq!(stdout["AccessKeyId"], "AKIATEST");
    assert_eq!(stdout["SessionToken"], "session");
    assert_eq!(stdout["Expiration"], "2026-08-20T03:00:00Z");
}

// ——— opensesame-kube-exec —————————————————————————————————————————

const KUBE_BIN: &str = env!("CARGO_BIN_EXE_opensesame-kube-exec");

#[test]
fn kube_mint_prints_the_exec_credential_shape() {
    let stub = spawn_stub_daemon(200, &mint_body(), 1);
    let out = run_helper(
        KUBE_BIN,
        &[],
        "",
        &[
            ("OPENSESAME_AGENT_SOCK", stub.sock.to_str().unwrap()),
            ("OPENSESAME_KUBE_CONNECTION_ID", "conn_kube"),
        ],
    );
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(stdout["apiVersion"], "client.authentication.k8s.io/v1");
    assert_eq!(stdout["kind"], "ExecCredential");
    assert_eq!(stdout["status"]["token"], CANARY);
    assert_eq!(
        stdout["status"]["expirationTimestamp"],
        "2026-08-20T03:00:00Z"
    );
}

#[test]
fn kube_unmintable_fails_closed_with_a_clear_message() {
    let stub = spawn_stub_daemon(422, r#"{"error":"unmintable"}"#, 1);
    let out = run_helper(
        KUBE_BIN,
        &[],
        "",
        &[
            ("OPENSESAME_AGENT_SOCK", stub.sock.to_str().unwrap()),
            ("OPENSESAME_KUBE_CONNECTION_ID", "conn_kube"),
        ],
    );
    assert!(!out.status.success());
    assert!(out.stdout.is_empty());
    let stderr = String::from_utf8(out.stderr).unwrap();
    assert!(stderr.contains("no mint path"), "{stderr}");
    assert!(!stderr.contains(CANARY), "{stderr}");
}

#[test]
fn kube_without_connection_id_fails_closed() {
    let out = run_helper(KUBE_BIN, &[], "", &[]);
    assert!(!out.status.success());
    assert!(out.stdout.is_empty());
    assert!(String::from_utf8_lossy(&out.stderr).contains("OPENSESAME_KUBE_CONNECTION_ID"));
}
