//! The credential helpers carry the operator token to the daemon.
//!
//! The daemon's `/v1/mint` runs `require_operator`, which demands the operator
//! token on the Unix socket as well as over TCP. A helper that sent none was
//! refused `401` by every real daemon, so git, Docker, `credential_process`
//! and kubectl could never mint. Each helper now forwards the
//! `OPENSESAME_OPERATOR_TOKEN` of its own environment, and only that: an
//! environment without one (an agent's) is still refused, a value that could
//! write a header is refused before the socket opens, and the value is never
//! printed.
#![cfg(unix)]

mod helper_stub;
mod named;

use std::fs::File;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::process::{Child, Command, Output, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use helper_stub::{run_helper, spawn_stub_daemon};

const OPERATOR: &str = "vtok_dummy_marker_operator_0123456789abcdef";
const MINTED: &str = "vtok_dummy_marker_minted_0123456789abcdef";

fn mint_body() -> String {
    format!(
        r#"{{"connection_id":"conn_test","provider_id":"github","kind":"github_app_installation","derived_token":"{MINTED}","expires_at":"2026-08-20T03:00:00Z","subject":"user:alice","actor":"operator","issued_at":"2026-08-20T02:00:00Z"}}"#
    )
}

/// One helper as git, Docker, an AWS SDK or kubectl starts it.
struct Helper {
    bin: &'static str,
    args: &'static [&'static str],
    stdin: &'static str,
    connection_env: &'static str,
}

const HELPERS: [Helper; 4] = [
    Helper {
        bin: "git-credential-opensesame",
        args: &["get"],
        stdin: "protocol=https\nhost=github.com\n\n",
        connection_env: "OPENSESAME_GIT_CONNECTION_ID",
    },
    Helper {
        bin: "docker-credential-opensesame",
        args: &["get"],
        stdin: "ghcr.io",
        connection_env: "OPENSESAME_DOCKER_CONNECTION_ID",
    },
    Helper {
        bin: "opensesame-credential-process",
        args: &[],
        stdin: "",
        connection_env: "OPENSESAME_AWS_CONNECTION_ID",
    },
    Helper {
        bin: "opensesame-kube-exec",
        args: &[],
        stdin: "",
        connection_env: "OPENSESAME_KUBE_CONNECTION_ID",
    },
];

fn run(helper: &Helper, sock: &Path, operator: Option<&str>) -> Output {
    let sock = sock.to_string_lossy().to_string();
    let mut env = vec![
        ("OPENSESAME_AGENT_SOCK", sock.as_str()),
        (helper.connection_env, "conn_test"),
    ];
    if let Some(token) = operator {
        env.push(("OPENSESAME_OPERATOR_TOKEN", token));
    }
    run_helper(&named::binary(helper.bin), helper.args, helper.stdin, &env)
}

fn shown(out: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
}

#[test]
fn every_helper_forwards_the_operator_token_and_never_prints_it() {
    for helper in &HELPERS {
        let stub = spawn_stub_daemon(200, &mint_body(), 1);
        let out = run(helper, &stub.sock, Some(OPERATOR));
        // The AWS helper refuses a GitHub-shaped mint; what matters here is
        // what reached the daemon and what the helper printed.
        let heads = stub.heads.lock().unwrap();
        assert_eq!(heads.len(), 1, "{}: {}", helper.bin, shown(&out));
        assert!(
            heads[0].contains(&format!("X-OpenSesame-Operator: {OPERATOR}\r\n")),
            "{}: {}",
            helper.bin,
            heads[0]
        );
        assert!(
            !shown(&out).contains(OPERATOR),
            "{}: the token reached the helper's output",
            helper.bin
        );
    }
}

#[test]
fn without_a_token_in_the_environment_none_is_sent() {
    for helper in &HELPERS {
        let stub = spawn_stub_daemon(200, &mint_body(), 1);
        let _ = run(helper, &stub.sock, None);
        let heads = stub.heads.lock().unwrap();
        assert_eq!(heads.len(), 1, "{}", helper.bin);
        assert!(
            !heads[0]
                .to_ascii_lowercase()
                .contains("x-opensesame-operator"),
            "{}: {}",
            helper.bin,
            heads[0]
        );
    }
}

#[test]
fn a_token_that_could_write_a_header_is_refused_before_the_daemon() {
    for helper in &HELPERS {
        let stub = spawn_stub_daemon(200, &mint_body(), 1);
        let out = run(helper, &stub.sock, Some("abc\r\nX-Evil: 1"));
        assert!(!out.status.success(), "{}", helper.bin);
        assert!(out.stdout.is_empty(), "{}", helper.bin);
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        assert!(
            stderr.contains("OPENSESAME_OPERATOR_TOKEN"),
            "{}: {stderr}",
            helper.bin
        );
        assert!(!stderr.contains("X-Evil"), "{}: {stderr}", helper.bin);
        assert!(
            stub.heads.lock().unwrap().is_empty(),
            "{}: the request reached the daemon",
            helper.bin
        );
    }
}

// ——— against the real daemon ——————————————————————————————————————

/// A child process that is killed when the test ends, however it ends.
struct Process(Child);

impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// A Host API stand-in: answers every request with the mint body and records
/// the request line of each.
fn spawn_host() -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind host stand-in");
    let base = format!("http://{}", listener.local_addr().expect("address"));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let recorded = seen.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
            let mut raw = Vec::new();
            let mut chunk = [0u8; 4096];
            while !request_complete(&raw) {
                match stream.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => raw.extend_from_slice(&chunk[..n]),
                }
            }
            let text = String::from_utf8_lossy(&raw).to_string();
            recorded
                .lock()
                .unwrap()
                .push(text.lines().next().unwrap_or_default().to_string());
            let body = mint_body();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
        }
    });
    (base, seen)
}

/// True once `raw` holds a request's head and as much body as it declared.
fn request_complete(raw: &[u8]) -> bool {
    let text = String::from_utf8_lossy(raw);
    let Some((head, body)) = text.split_once("\r\n\r\n") else {
        return false;
    };
    let declared = head
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .and_then(|value| value.trim().parse::<usize>().ok())
        })
        .unwrap_or(0);
    body.len() >= declared
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .expect("bind")
        .local_addr()
        .expect("address")
        .port()
}

fn spawn_daemon(dir: &Path, host_api: &str) -> Process {
    let log = File::create(dir.join("daemon.log")).expect("log file");
    let err = log.try_clone().expect("log handle");
    Process(
        Command::new(env!("CARGO_BIN_EXE_opensesame"))
            .env_clear()
            .env("HOME", dir)
            .env("OPENSESAME_ENV", "development")
            .env("NODE_ENV", "development")
            .env("OPENSESAME_ALLOW_DEV_DEFAULTS", "1")
            .env("OPENSESAME_OPERATOR_TOKEN", OPERATOR)
            .env("OPENSESAME_HOST_API", host_api)
            .args(["daemon", "run", "--listen"])
            .arg(format!("127.0.0.1:{}", free_port()))
            .arg("--sock")
            .arg(dir.join("agent.sock"))
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(err))
            .spawn()
            .expect("spawn the daemon"),
    )
}

#[test]
fn the_real_daemon_mints_for_a_helper_with_the_token_and_refuses_one_without() {
    let dir = tempfile::tempdir().expect("state dir");
    let (host_api, host_seen) = spawn_host();
    let _daemon = spawn_daemon(dir.path(), &host_api);
    let sock = dir.path().join("agent.sock");
    let deadline = Instant::now() + Duration::from_secs(60);
    while !sock.exists() {
        assert!(
            Instant::now() < deadline,
            "timed out waiting for the daemon"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    let git = &HELPERS[0];

    let refused = run(git, &sock, None);
    assert!(!refused.status.success());
    assert!(refused.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&refused.stderr).contains("401"),
        "{}",
        shown(&refused)
    );
    assert!(
        host_seen.lock().unwrap().is_empty(),
        "a refused helper reached the Host"
    );

    let minted = run(git, &sock, Some(OPERATOR));
    assert!(minted.status.success(), "{}", shown(&minted));
    assert_eq!(
        String::from_utf8_lossy(&minted.stdout),
        format!("username=x-access-token\npassword={MINTED}\n\n")
    );
    assert!(!shown(&minted).contains(OPERATOR));
    let seen = host_seen.lock().unwrap();
    assert_eq!(
        seen.as_slice(),
        ["POST /api/v1/connections/conn_test/mint HTTP/1.1"]
    );
}
