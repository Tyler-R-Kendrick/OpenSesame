//! `opensesame hooks approver get|put`, driven through the real binary against
//! a stand-in Host (ADR 0159): who the Host asks is read, and replaced only
//! compare-and-set and with a step-up.

mod hooks_mock;

use std::sync::{Arc, Mutex};

use hooks_mock::{opensesame, serve, stdout_json, Request, HANDLE};
use serde_json::{json, Value};

const OPERATOR_TOKEN: &str = "0123456789abcdef0123456789abcdef-operator";

// --- `hooks approver get|put` against a stand-in Host ----------------------

fn host(operator_accepted: bool, stale: bool) -> (String, Arc<Mutex<Vec<Request>>>) {
    serve(move |request, _| {
        let operator = request.authorization.starts_with("Bearer operator:");
        match (request.method.as_str(), operator, operator_accepted) {
            ("GET", _, _) => (
                "200 OK",
                json!({"version": 3, "stored": true, "asks": "organization", "approver_ref": HANDLE}),
            ),
            (_, true, true) if stale => (
                "412 Precondition Failed",
                json!({"error": "precondition_failed", "current_version": 5}),
            ),
            (_, true, true) => ("200 OK", json!({"version": 4, "stored": true})),
            (_, true, false) => (
                "401 Unauthorized",
                json!({"error": "operator_unauthorized"}),
            ),
            (_, false, _) => (
                "403 Forbidden",
                json!({
                    "error": "step_up_required",
                    "reason": "no_step_up",
                    "hint": "to change who approves the agent-hooks escalations this session needs a step-up",
                }),
            ),
        }
    })
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
fn get_prints_who_is_asked_and_the_version() {
    let dir = tempfile::tempdir().unwrap();
    signed_in(dir.path());
    let (server, seen) = host(true, false);
    let out = opensesame(dir.path())
        .args(["--server", &server, "hooks", "approver", "get"])
        .output()
        .unwrap();
    let body = stdout_json(&out);
    assert_eq!(body["version"], 3);
    assert_eq!(body["asks"], "organization");
    let seen = seen.lock().unwrap();
    assert_eq!(
        (seen[0].method.as_str(), seen[0].path.as_str()),
        ("GET", "/api/v1/agent-hooks/approver")
    );
}

#[test]
fn put_sends_one_handle_or_a_clear_against_the_version_it_was_read_at() {
    let dir = tempfile::tempdir().unwrap();
    let (server, seen) = host(true, false);
    for (args, sent) in [
        (
            vec!["--ref", HANDLE, "--if-version", "3"],
            json!({"approver_ref": HANDLE}),
        ),
        (
            vec!["--clear", "--if-version", "4"],
            json!({"approver_ref": null}),
        ),
    ] {
        let out = opensesame(dir.path())
            .env("OPENSESAME_OPERATOR_TOKEN", OPERATOR_TOKEN)
            .args(["--server", &server, "hooks", "approver", "put"])
            .args(&args)
            .output()
            .unwrap();
        assert_eq!(stdout_json(&out)["version"], 4, "{args:?}");
        let seen = seen.lock().unwrap();
        let last = seen.last().unwrap();
        assert_eq!(last.method, "PUT");
        assert_eq!(last.if_match, format!("\"{}\"", args.last().unwrap()));
        assert_eq!(serde_json::from_str::<Value>(&last.body).unwrap(), sent);
    }
}

#[test]
fn put_takes_a_handle_or_a_clear_never_both_never_neither_and_checks_the_shape() {
    let dir = tempfile::tempdir().unwrap();
    for args in [
        vec!["--if-version", "0"],
        vec!["--ref", HANDLE, "--clear", "--if-version", "0"],
        vec!["--ref", "https://elsewhere.example/x", "--if-version", "0"],
        vec!["--ref", "inbox_has space", "--if-version", "0"],
    ] {
        let out = opensesame(dir.path())
            .args(["hooks", "approver", "put"])
            .args(&args)
            .output()
            .unwrap();
        assert!(!out.status.success(), "{args:?}");
    }
}

#[test]
fn a_session_alone_is_told_what_to_present_and_a_stale_version_says_so() {
    let dir = tempfile::tempdir().unwrap();
    signed_in(dir.path());
    let (server, _) = host(true, false);
    let out = opensesame(dir.path())
        .args(["--server", &server, "hooks", "approver", "put"])
        .args(["--ref", HANDLE, "--if-version", "0"])
        .output()
        .unwrap();
    assert!(!out.status.success());
    let said = String::from_utf8_lossy(&out.stderr);
    assert!(said.contains("step_up_required"), "{said}");
    assert!(said.contains("OPENSESAME_OPERATOR_TOKEN"), "{said}");
    assert!(said.contains("passkey"), "{said}");

    let (server, _) = host(true, true);
    let out = opensesame(dir.path())
        .env("OPENSESAME_OPERATOR_TOKEN", OPERATOR_TOKEN)
        .args(["--server", &server, "hooks", "approver", "put"])
        .args(["--ref", HANDLE, "--if-version", "3"])
        .output()
        .unwrap();
    let said = String::from_utf8_lossy(&out.stderr);
    assert!(
        said.contains("version 3") && said.contains("version 5"),
        "{said}"
    );
}
