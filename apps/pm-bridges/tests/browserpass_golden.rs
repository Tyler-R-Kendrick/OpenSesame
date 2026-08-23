//! Golden protocol tests for `opensesame-browserpass-host`.
//!
//! Fixed request in → exact response out, over a tempdir sealed store, with
//! the real binary as a subprocess. The `insta` snapshots are the format
//! contract: if a field name or shape changes, the diff says so.

#![cfg(feature = "browserpass")]

mod support;

use serde_json::{json, Value};
use support::{run_host, Fixture};

const BIN: &str = env!("CARGO_BIN_EXE_opensesame-browserpass-host");

fn store_settings(fixture: &Fixture) -> Value {
    json!({
        "stores": {
            "default": {
                "id": "default",
                "name": "OpenSesame",
                "path": fixture.store_path().to_string_lossy(),
            }
        }
    })
}

#[test]
fn configure_reports_the_configured_store() {
    let fixture = Fixture::new();
    let run = run_host(
        BIN,
        &fixture,
        &[json!({ "action": "configure", "settings": store_settings(&fixture) })],
    );
    assert!(run.status.success(), "stderr: {}", run.stderr);
    assert_eq!(run.responses.len(), 1);

    let response = &run.responses[0];
    assert_eq!(response["status"], "ok");
    assert_eq!(response["version"], 3_001_002u64);
    assert_eq!(response["data"]["storeSettings"]["default"], "{}");
    // No user-configured default store was asked for, so none is reported.
    assert_eq!(response["data"]["defaultStore"]["path"], "");

    insta::assert_json_snapshot!("configure", response);
}

#[test]
fn configure_refuses_an_inaccessible_store() {
    let fixture = Fixture::new();
    let run = run_host(
        BIN,
        &fixture,
        &[json!({
            "action": "configure",
            "settings": { "stores": { "gone": { "id": "gone", "name": "Gone", "path": "/nonexistent/store" } } }
        })],
    );
    assert!(!run.status.success());
    assert_eq!(run.status.code(), Some(13));
    let response = &run.responses[0];
    assert_eq!(response["status"], "error");
    assert_eq!(response["code"], 13);
    insta::assert_json_snapshot!("configure_inaccessible", response);
}

#[test]
fn list_returns_every_entry_with_a_gpg_suffix() {
    let fixture = Fixture::new();
    let run = run_host(
        BIN,
        &fixture,
        &[json!({ "action": "list", "settings": store_settings(&fixture) })],
    );
    assert!(run.status.success(), "stderr: {}", run.stderr);
    let response = &run.responses[0];
    assert_eq!(
        response["data"]["files"]["default"],
        json!(["Dev/github.gpg", "Web/example.com.gpg"])
    );
    insta::assert_json_snapshot!("list", response);
}

#[test]
fn fetch_returns_the_entry_in_pass_format() {
    let fixture = Fixture::new();
    let run = run_host(
        BIN,
        &fixture,
        &[json!({
            "action": "fetch",
            "storeId": "default",
            "file": "Web/example.com.gpg",
            "settings": store_settings(&fixture),
        })],
    );
    assert!(run.status.success(), "stderr: {}", run.stderr);
    let contents = run.responses[0]["data"]["contents"]
        .as_str()
        .expect("contents");
    // Secret first, trailer after — exactly what the extension parses.
    assert!(contents.starts_with("hunter2\n"));
    assert!(contents.contains("login: alice"));
    assert!(contents.contains("url: https://example.com/login"));
    insta::assert_json_snapshot!("fetch", run.responses[0]);
}

#[test]
fn fetch_rejects_a_file_without_the_gpg_extension() {
    let fixture = Fixture::new();
    let run = run_host(
        BIN,
        &fixture,
        &[json!({
            "action": "fetch",
            "storeId": "default",
            "file": "Web/example.com",
            "settings": store_settings(&fixture),
        })],
    );
    assert_eq!(run.status.code(), Some(23));
    insta::assert_json_snapshot!("fetch_bad_extension", run.responses[0]);
}

#[test]
fn fetch_rejects_an_unknown_store_id() {
    let fixture = Fixture::new();
    let run = run_host(
        BIN,
        &fixture,
        &[json!({
            "action": "fetch",
            "storeId": "other",
            "file": "Web/example.com.gpg",
            "settings": store_settings(&fixture),
        })],
    );
    assert_eq!(run.status.code(), Some(20));
    assert_eq!(run.responses[0]["code"], 20);
}

#[test]
fn fetch_of_a_missing_entry_leaks_nothing() {
    let fixture = Fixture::new();
    let run = run_host(
        BIN,
        &fixture,
        &[json!({
            "action": "fetch",
            "storeId": "default",
            "file": "Web/nope.gpg",
            "settings": store_settings(&fixture),
        })],
    );
    assert_eq!(run.status.code(), Some(24));
    let raw = serde_json::to_string(&run.responses[0]).unwrap();
    assert!(!raw.contains("hunter2"));
    assert!(!run.stderr.contains("hunter2"));
    insta::assert_json_snapshot!("fetch_missing", run.responses[0]);
}

#[test]
fn echo_returns_the_payload_verbatim() {
    let fixture = Fixture::new();
    let run = run_host(
        BIN,
        &fixture,
        &[json!({ "action": "echo", "echoResponse": { "hello": "world", "n": 7 } })],
    );
    assert!(run.status.success());
    assert_eq!(run.responses[0], json!({ "hello": "world", "n": 7 }));
}

#[test]
fn an_unknown_action_is_rejected() {
    let fixture = Fixture::new();
    let run = run_host(BIN, &fixture, &[json!({ "action": "delete" })]);
    assert_eq!(run.status.code(), Some(12));
    insta::assert_json_snapshot!("unknown_action", run.responses[0]);
}

#[test]
fn several_requests_share_one_process() {
    let fixture = Fixture::new();
    let settings = store_settings(&fixture);
    let run = run_host(
        BIN,
        &fixture,
        &[
            json!({ "action": "configure", "settings": settings }),
            json!({ "action": "list", "settings": store_settings(&fixture) }),
            json!({ "action": "echo", "echoResponse": "bye" }),
        ],
    );
    assert!(run.status.success(), "stderr: {}", run.stderr);
    assert_eq!(run.responses.len(), 3);
    assert_eq!(run.responses[2], json!("bye"));
}
