//! `opensesame hooks policy preset …` and `put --preset`, driven through the
//! real binary (ADR 0159): the presets need no Host, and a replacement a
//! plain session is refused says what to present instead.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Command, Output};
use std::sync::{Arc, Mutex};
use std::thread;

use serde_json::{json, Value};

const OPERATOR_TOKEN: &str = "0123456789abcdef0123456789abcdef-operator";

fn opensesame(config: &std::path::Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_opensesame"));
    command
        .env("XDG_CONFIG_HOME", config)
        .env("HOME", config)
        .env_remove("OPENSESAME_OPERATOR_TOKEN")
        .env_remove("OPENSESAME_HOOK_POLICY");
    command
}

fn stdout_json(out: &Output) -> Value {
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).expect("stdout is JSON")
}

#[test]
fn presets_are_listed_and_shown_with_no_host() {
    let dir = tempfile::tempdir().unwrap();
    let listed = stdout_json(
        &opensesame(dir.path())
            .args(["hooks", "policy", "preset", "ls"])
            .output()
            .unwrap(),
    );
    let names: Vec<&str> = listed["presets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|preset| preset["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["observe", "rotation-web-login", "strict"]);

    let strict = stdout_json(
        &opensesame(dir.path())
            .args(["hooks", "policy", "preset", "show", "strict"])
            .output()
            .unwrap(),
    );
    assert_eq!(strict["policy"]["unlisted_tools"], "deny");
    assert_eq!(strict["policy"]["secret_guard"], "deny");

    let unknown = opensesame(dir.path())
        .args(["hooks", "policy", "preset", "show", "lenient"])
        .output()
        .unwrap();
    assert!(!unknown.status.success());
    let said = String::from_utf8_lossy(&unknown.stderr);
    assert!(said.contains("rotation-web-login"), "{said}");
}

#[test]
fn put_takes_a_file_or_a_preset_never_both_and_never_neither() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("policy.json");
    std::fs::write(&file, r#"{"version":1}"#).unwrap();
    for args in [
        vec!["--if-version", "0"],
        vec![
            "--preset",
            "strict",
            "--if-version",
            "0",
            file.to_str().unwrap(),
        ],
    ] {
        let out = opensesame(dir.path())
            .args(["hooks", "policy", "put"])
            .args(&args)
            .output()
            .unwrap();
        assert!(!out.status.success(), "{args:?}");
    }
}

/// What the stand-in Host saw of one request.
#[derive(Clone, Debug)]
struct Seen {
    authorization: String,
    if_match: String,
    body: String,
}

/// The header `name` of a raw request head.
fn header_of(head: &str, name: &str) -> String {
    head.lines()
        .find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case(name)
                .then(|| value.trim().to_owned())
        })
        .unwrap_or_default()
}

/// Read one request: its head, then as much body as it declares.
fn read_request(stream: &mut TcpStream) -> Option<Seen> {
    let mut raw = Vec::new();
    let mut buf = [0u8; 4096];
    let split = loop {
        let n = stream.read(&mut buf).unwrap_or(0);
        if n == 0 {
            return None;
        }
        raw.extend_from_slice(&buf[..n]);
        if let Some(at) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
            break at;
        }
    };
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let mut body = raw[split + 4..].to_vec();
    let length: usize = header_of(&head, "content-length").parse().unwrap_or(0);
    while body.len() < length {
        let n = stream.read(&mut buf).unwrap_or(0);
        if n == 0 {
            break;
        }
        body.extend_from_slice(&buf[..n]);
    }
    Some(Seen {
        authorization: header_of(&head, "authorization"),
        if_match: header_of(&head, "if-match"),
        body: String::from_utf8_lossy(&body).to_string(),
    })
}

/// The Host's answer: the operator's replacement lands (when accepted), a
/// session is refused for want of a step-up.
fn answer(seen: &Seen, operator_accepted: bool) -> (&'static str, Value) {
    let operator = seen.authorization.starts_with("Bearer operator:");
    match (operator, operator_accepted) {
        (true, true) => ("200 OK", json!({"version": 1, "stored": true})),
        (true, false) => (
            "401 Unauthorized",
            json!({"error": "operator_unauthorized"}),
        ),
        (false, _) => (
            "403 Forbidden",
            json!({
                "error": "step_up_required",
                "reason": "no_step_up",
                "hint": "to replace the agent-hooks policy this session needs a step-up it does not have",
            }),
        ),
    }
}

/// A Host that refuses a session's replacement for want of a step-up, and
/// takes the operator's (or refuses that too).
fn host(operator_accepted: bool) -> (String, Arc<Mutex<Vec<Seen>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&seen);
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            let Some(request) = read_request(&mut stream) else {
                continue;
            };
            let (status, reply) = answer(&request, operator_accepted);
            log.lock().unwrap().push(request);
            let reply = reply.to_string();
            let _ = write!(
                stream,
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}",
                reply.len()
            );
        }
    });
    (url, seen)
}

fn signed_in(config: &std::path::Path) {
    let dir = config.join("opensesame");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("session.json"),
        json!({"access_token": "opaque-session:plain-admin-session"}).to_string(),
    )
    .unwrap();
}

#[test]
fn a_session_alone_is_refused_and_told_what_to_present() {
    let dir = tempfile::tempdir().unwrap();
    signed_in(dir.path());
    let (server, seen) = host(true);
    let out = opensesame(dir.path())
        .args(["--server", &server, "hooks", "policy", "put"])
        .args(["--preset", "strict", "--if-version", "0"])
        .output()
        .unwrap();
    assert!(!out.status.success());
    let said = String::from_utf8_lossy(&out.stderr);
    assert!(said.contains("step_up_required"), "{said}");
    assert!(said.contains("OPENSESAME_OPERATOR_TOKEN"), "{said}");
    assert!(said.contains("passkey"), "{said}");
    // It asked once, as the session, and sent the preset's own policy.
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].if_match, "\"0\"");
    let sent: Value = serde_json::from_str(&seen[0].body).unwrap();
    assert_eq!(sent["unlisted_tools"], "deny");
    assert_eq!(sent["secret_guard"], "deny");
}

#[test]
fn the_operator_token_after_a_refused_session_replaces_the_policy() {
    let dir = tempfile::tempdir().unwrap();
    signed_in(dir.path());
    let (server, seen) = host(true);
    let out = opensesame(dir.path())
        .env("OPENSESAME_OPERATOR_TOKEN", OPERATOR_TOKEN)
        .args(["--server", &server, "hooks", "policy", "put"])
        .args(["--preset", "observe", "--if-version", "0"])
        .output()
        .unwrap();
    let body = stdout_json(&out);
    assert_eq!(body["version"], 1);
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 2, "the session first, then the operator token");
    assert!(seen[0].authorization.starts_with("Bearer opaque-session:"));
    assert!(seen[1].authorization.starts_with("Bearer operator:"));
    assert_eq!(seen[0].body, seen[1].body);
}

#[test]
fn a_wrong_operator_token_does_not_hide_the_step_up_remedy() {
    let dir = tempfile::tempdir().unwrap();
    signed_in(dir.path());
    let (server, seen) = host(false);
    let out = opensesame(dir.path())
        .env("OPENSESAME_OPERATOR_TOKEN", OPERATOR_TOKEN)
        .args(["--server", &server, "hooks", "policy", "put"])
        .args(["--preset", "observe", "--if-version", "3"])
        .output()
        .unwrap();
    assert!(!out.status.success());
    let said = String::from_utf8_lossy(&out.stderr);
    // The last credential's plain 401 is not the answer; the session's
    // step-up refusal, which says what would work, is.
    assert!(said.contains("step_up_required"), "{said}");
    assert!(!said.contains("operator_unauthorized"), "{said}");
    assert_eq!(seen.lock().unwrap().len(), 2);
}
