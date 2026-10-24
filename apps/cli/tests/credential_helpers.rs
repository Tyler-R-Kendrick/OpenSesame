//! End-to-end helper tests: each binary runs as a subprocess against a stub
//! daemon on a temporary Unix socket. Asserts the exact stdout protocol
//! shape on success, and non-zero exit with empty stdout on any daemon
//! refusal.
#![cfg(unix)]

mod helper_stub;
mod named;

use helper_stub::{run_helper, spawn_stub_daemon};

const CANARY: &str = "ghs_CANARY-derived-token";

fn mint_body() -> String {
    format!(
        r#"{{"connection_id":"conn_test","provider_id":"github","kind":"github_app_installation","derived_token":"{CANARY}","expires_at":"2026-08-20T03:00:00Z","subject":"user:alice","actor":"operator","issued_at":"2026-08-20T02:00:00Z"}}"#
    )
}

// ——— git-credential-opensesame ————————————————————————————————————

fn git_bin() -> String {
    named::binary("git-credential-opensesame")
}

#[test]
fn git_get_prints_the_credential_protocol_shape() {
    let stub = spawn_stub_daemon(200, &mint_body(), 1);
    let out = run_helper(
        &git_bin(),
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
        let out = run_helper(
            &git_bin(),
            &[op],
            "protocol=https\nhost=github.com\n\n",
            &[],
        );
        assert!(out.status.success(), "{op}");
        assert!(out.stdout.is_empty(), "{op}");
    }
}

#[test]
fn git_daemon_denial_exits_nonzero_with_empty_stdout() {
    let stub = spawn_stub_daemon(403, r#"{"error":"materialization_denied"}"#, 1);
    let out = run_helper(
        &git_bin(),
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
    let out = run_helper(
        &git_bin(),
        &["get"],
        "protocol=https\nhost=github.com\n\n",
        &[],
    );
    assert!(!out.status.success());
    assert!(out.stdout.is_empty());
    assert!(String::from_utf8_lossy(&out.stderr).contains("OPENSESAME_GIT_CONNECTION_ID"));
}

#[test]
fn git_get_for_another_host_or_plain_http_mints_and_prints_nothing() {
    let stub = spawn_stub_daemon(200, &mint_body(), 1);
    let sock = stub.sock.to_str().unwrap();
    for input in [
        "protocol=https\nhost=attacker.example\n\n",
        "protocol=https\nhost=github.com.evil.example\n\n",
        "protocol=http\nhost=github.com\n\n",
        "host=github.com\n\n",
    ] {
        let envs = [
            ("OPENSESAME_AGENT_SOCK", sock),
            ("OPENSESAME_GIT_CONNECTION_ID", "conn_test"),
        ];
        let out = run_helper(&git_bin(), &["get"], input, &envs);
        // A clean, empty answer: git falls through to its next helper.
        assert!(out.status.success(), "{input:?}");
        assert!(out.stdout.is_empty(), "{input:?}");
    }
    assert!(
        stub.requests.lock().unwrap().is_empty(),
        "no mint was asked for"
    );
}

// ——— docker-credential-opensesame —————————————————————————————————

fn docker_bin() -> String {
    named::binary("docker-credential-opensesame")
}

#[test]
fn docker_get_prints_the_json_shape() {
    let stub = spawn_stub_daemon(200, &mint_body(), 1);
    let out = run_helper(
        &docker_bin(),
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
    let out = run_helper(&docker_bin(), &["list"], "", &[]);
    assert!(out.status.success());
    assert_eq!(String::from_utf8(out.stdout).unwrap().trim(), "{}");
    for op in ["store", "erase"] {
        let out = run_helper(&docker_bin(), &[op], "ghcr.io", &[]);
        assert!(out.status.success(), "{op}");
        assert!(out.stdout.is_empty(), "{op}");
    }
}

#[test]
fn docker_daemon_5xx_exits_nonzero_with_empty_stdout() {
    let stub = spawn_stub_daemon(502, r#"{"error":"host_api_unreachable"}"#, 1);
    let out = run_helper(
        &docker_bin(),
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

// ——— opensesame-kube-exec —————————————————————————————————————————

fn kube_bin() -> String {
    named::binary("opensesame-kube-exec")
}

#[test]
fn kube_mint_prints_the_exec_credential_shape() {
    let stub = spawn_stub_daemon(200, &mint_body(), 1);
    let out = run_helper(
        &kube_bin(),
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
        &kube_bin(),
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
    let out = run_helper(&kube_bin(), &[], "", &[]);
    assert!(!out.status.success());
    assert!(out.stdout.is_empty());
    assert!(String::from_utf8_lossy(&out.stderr).contains("OPENSESAME_KUBE_CONNECTION_ID"));
}
