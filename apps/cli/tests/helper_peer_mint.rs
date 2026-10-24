//! The credential helpers mint over the daemon's Unix socket by peer
//! credentials, carry no bearer, and get only what the operator allowed
//! (ADR 0138 §2, as amended).
//!
//! The daemon's `/v1/mint` used to demand the operator token on the socket,
//! which no helper sent, so every real daemon answered `401`. The route now
//! authenticates a socket peer by its kernel-attested UID and mints, with no
//! token, only a connection the operator allowed (`opensesame daemon helpers
//! allow`). A helper never reads `OPENSESAME_OPERATOR_TOKEN` and never sends an
//! operator header, so a process that answers at the socket path in the
//! daemon's place captures nothing that authorizes anything, whatever the
//! helper's environment holds.
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

use helper_stub::{run_helper, spawn_stub_daemon, without_inherited_opensesame_env};

/// The daemon's own operator token.
const OPERATOR: &str = "vtok_dummy_marker_operator_0123456789abcdef";
/// A token in the helper's environment, which must travel nowhere.
const INHERITED: &str = "vtok_dummy_marker_inherited_0123456789abcdef";
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

/// Run `helper` against `sock` with `OPENSESAME_OPERATOR_TOKEN` set in its
/// environment, as a helper started from the operator's own shell would be.
fn run(helper: &Helper, sock: &Path) -> Output {
    run_with(helper, sock, &[])
}

fn run_with(helper: &Helper, sock: &Path, extra: &[(&str, &str)]) -> Output {
    let sock = sock.to_string_lossy().to_string();
    let mut env = vec![
        ("OPENSESAME_AGENT_SOCK", sock.as_str()),
        (helper.connection_env, "conn_test"),
        ("OPENSESAME_OPERATOR_TOKEN", INHERITED),
    ];
    env.extend_from_slice(extra);
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
fn no_helper_forwards_the_operator_token_its_environment_holds() {
    for helper in &HELPERS {
        let stub = spawn_stub_daemon(200, &mint_body(), 1);
        let out = run(helper, &stub.sock);
        // The AWS helper refuses a GitHub-shaped mint; what matters here is
        // what reached the socket and what the helper printed.
        let heads = stub.heads.lock().unwrap();
        assert_eq!(heads.len(), 1, "{}: {}", helper.bin, shown(&out));
        assert!(
            !heads[0]
                .to_ascii_lowercase()
                .contains("x-opensesame-operator"),
            "{}: {}",
            helper.bin,
            heads[0]
        );
        assert!(
            !heads[0].contains(INHERITED),
            "{}: the token reached the socket",
            helper.bin
        );
        assert!(
            !shown(&out).contains(INHERITED),
            "{}: the token reached the helper's output",
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
/// each request whole.
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
            recorded.lock().unwrap().push(text);
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

fn spawn_daemon(dir: &Path, host_api: &str, port: u16) -> Process {
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
            .arg(format!("127.0.0.1:{port}"))
            .arg("--sock")
            .arg(dir.join("agent.sock"))
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(err))
            .spawn()
            .expect("spawn the daemon"),
    )
}

/// The real daemon over a Host stand-in, its socket ready: the state dir,
/// the process, its TCP port and what the Host has seen.
fn boot() -> (tempfile::TempDir, Process, u16, Arc<Mutex<Vec<String>>>) {
    let dir = tempfile::tempdir().expect("state dir");
    let (host_api, host_seen) = spawn_host();
    let port = free_port();
    let daemon = spawn_daemon(dir.path(), &host_api, port);
    let sock = dir.path().join("agent.sock");
    let deadline = Instant::now() + Duration::from_secs(60);
    while !sock.exists() {
        assert!(
            Instant::now() < deadline,
            "timed out waiting for the daemon"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    (dir, daemon, port, host_seen)
}

/// `opensesame daemon helpers <args>` against the daemon at `port`, with the
/// operator token or without it.
fn allowlist(port: u16, args: &[&str], token: Option<&str>) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_opensesame"));
    without_inherited_opensesame_env(&mut command)
        .args(["daemon", "--url"])
        .arg(format!("http://127.0.0.1:{port}"))
        .arg("helpers")
        .args(args);
    if let Some(token) = token {
        command.env("OPENSESAME_OPERATOR_TOKEN", token);
    }
    command.output().expect("opensesame daemon helpers")
}

#[test]
fn a_helper_mints_only_what_the_operator_allowed_through_the_real_daemon() {
    let (dir, _daemon, port, host_seen) = boot();
    let sock = dir.path().join("agent.sock");

    // Over TCP the operator token is still required, and nothing is forwarded
    // without it.
    let tcp = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(30))
        .build()
        .expect("client")
        .post(format!("http://127.0.0.1:{port}/v1/mint"))
        .json(&serde_json::json!({"connection_id": "conn_test"}))
        .send()
        .expect("daemon over TCP");
    assert_eq!(tcp.status().as_u16(), 401);

    // On the socket, peer credentials alone mint nothing the operator has not
    // allowed.
    let refused = run(&HELPERS[0], &sock);
    assert!(!refused.status.success());
    assert!(refused.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&refused.stderr).contains("403"),
        "{}",
        shown(&refused)
    );
    assert!(host_seen.lock().unwrap().is_empty());

    // Allowing needs the operator token, which the helper never holds.
    let unauthorized = allowlist(port, &["allow", "conn_test"], None);
    assert!(!unauthorized.status.success(), "{unauthorized:?}");
    let allowed = allowlist(port, &["allow", "conn_test"], Some(OPERATOR));
    assert!(allowed.status.success(), "{allowed:?}");

    let minted = run(&HELPERS[0], &sock);
    assert!(minted.status.success(), "{}", shown(&minted));
    assert_eq!(
        String::from_utf8_lossy(&minted.stdout),
        format!("username=x-access-token\npassword={MINTED}\n\n")
    );
    assert!(!shown(&minted).contains(INHERITED));
    {
        let seen = host_seen.lock().unwrap();
        assert_eq!(seen.len(), 1, "{seen:?}");
        let request = &seen[0];
        assert!(
            request.starts_with("POST /api/v1/connections/conn_test/mint HTTP/1.1"),
            "{request}"
        );
        // The forward carries the daemon's own token, never the helper's
        // environment, and names the process it minted for.
        assert!(request.contains(OPERATOR), "{request}");
        assert!(!request.contains(INHERITED), "{request}");
        let body: serde_json::Value =
            serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap_or_default())
                .expect("forwarded body");
        assert!(body["on_behalf_of"]["uid"].is_u64(), "{body}");
        assert!(body["on_behalf_of"]["pid"].is_u64(), "{body}");
    }

    let revoked = allowlist(port, &["revoke", "conn_test"], Some(OPERATOR));
    assert!(revoked.status.success(), "{revoked:?}");
    let refused = run(&HELPERS[0], &sock);
    assert!(!refused.status.success());
    assert_eq!(
        host_seen.lock().unwrap().len(),
        1,
        "a revoked connection minted"
    );
}

/// A GitHub App connection reaches every installation of the App; a helper
/// grant names one, and a helper asking for another is refused (ADR 0138 §2).
#[test]
fn a_grant_mints_only_the_installation_the_operator_named() {
    let (dir, _daemon, port, host_seen) = boot();
    let sock = dir.path().join("agent.sock");
    let allowed = allowlist(
        port,
        &["allow", "conn_test", "--installation", "777"],
        Some(OPERATOR),
    );
    assert!(allowed.status.success(), "{allowed:?}");

    let other = run_with(
        &HELPERS[0],
        &sock,
        &[("OPENSESAME_GITHUB_INSTALLATION_ID", "778")],
    );
    assert!(!other.status.success());
    assert!(other.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&other.stderr).contains("403"),
        "{}",
        shown(&other)
    );
    assert!(host_seen.lock().unwrap().is_empty());

    let granted = run_with(
        &HELPERS[0],
        &sock,
        &[("OPENSESAME_GITHUB_INSTALLATION_ID", "777")],
    );
    assert!(granted.status.success(), "{}", shown(&granted));
    let seen = host_seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    let body: serde_json::Value =
        serde_json::from_str(seen[0].split("\r\n\r\n").nth(1).unwrap_or_default())
            .expect("forwarded body");
    assert_eq!(body["installation_id"], "777");
}
