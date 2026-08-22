//! Golden protocol tests for `opensesame-gopass-jsonapi`.
//!
//! Same harness as the browserpass tests: the real binary, a tempdir store,
//! fixed requests, snapshotted responses. `getData` carries a live TOTP, so
//! that one field is redacted — everything else is pinned exactly.

#![cfg(feature = "gopass")]

mod support;

use serde_json::json;
use support::{run_host, Fixture};

const BIN: &str = env!("CARGO_BIN_EXE_opensesame-gopass-jsonapi");

#[test]
fn query_matches_entry_paths() {
    let fixture = Fixture::new();
    let run = run_host(
        BIN,
        &fixture,
        &[json!({ "type": "query", "query": "example" })],
    );
    assert!(run.status.success(), "stderr: {}", run.stderr);
    assert_eq!(run.responses[0], json!(["Web/example.com"]));
    insta::assert_json_snapshot!("query", run.responses[0]);
}

#[test]
fn an_empty_query_lists_the_whole_store() {
    let fixture = Fixture::new();
    let run = run_host(BIN, &fixture, &[json!({ "type": "query", "query": "" })]);
    assert_eq!(run.responses[0], json!(["Dev/github", "Web/example.com"]));
}

#[test]
fn query_with_no_match_is_an_empty_array_not_an_error() {
    let fixture = Fixture::new();
    let run = run_host(
        BIN,
        &fixture,
        &[json!({ "type": "query", "query": "nothing-here" })],
    );
    assert_eq!(run.responses[0], json!([]));
}

#[test]
fn query_host_walks_subdomains_leftwards() {
    let fixture = Fixture::new();
    let run = run_host(
        BIN,
        &fixture,
        &[
            json!({ "type": "queryHost", "host": "login.example.com" }),
            json!({ "type": "queryHost", "host": "nothing.invalid" }),
        ],
    );
    assert!(run.status.success(), "stderr: {}", run.stderr);
    assert_eq!(run.responses[0], json!(["Web/example.com"]));
    assert_eq!(run.responses[1], json!([]));
    insta::assert_json_snapshot!("query_host", run.responses[0]);
}

#[test]
fn query_host_never_matches_on_a_bare_public_suffix() {
    let fixture = Fixture::new();
    // "com" alone must not be queried; that would match everything.
    let run = run_host(BIN, &fixture, &[json!({ "type": "queryHost", "host": "com" })]);
    assert_eq!(run.responses[0], json!([]));
}

#[test]
fn get_login_returns_the_username_and_password() {
    let fixture = Fixture::new();
    let run = run_host(
        BIN,
        &fixture,
        &[json!({ "type": "getLogin", "entry": "Web/example.com" })],
    );
    assert!(run.status.success(), "stderr: {}", run.stderr);
    assert_eq!(
        run.responses[0],
        json!({ "username": "alice", "password": "hunter2" })
    );
    insta::assert_json_snapshot!("get_login", run.responses[0]);
}

#[test]
fn get_login_falls_back_to_the_last_path_segment() {
    let fixture = Fixture::new();
    let run = run_host(
        BIN,
        &fixture,
        &[json!({ "type": "getLogin", "entry": "Dev/github" })],
    );
    assert_eq!(run.responses[0]["username"], "github");
}

#[test]
fn get_data_returns_the_current_totp_and_extras() {
    let fixture = Fixture::new();
    let run = run_host(
        BIN,
        &fixture,
        &[json!({ "type": "getData", "entry": "Web/example.com" })],
    );
    assert!(run.status.success(), "stderr: {}", run.stderr);
    let data = &run.responses[0];
    let totp = data["current_totp"].as_str().expect("current_totp");
    assert_eq!(totp.len(), 6);
    assert!(totp.chars().all(|c| c.is_ascii_digit()));
    // The password is never part of `getData`.
    assert!(!serde_json::to_string(data).unwrap().contains("hunter2"));

    insta::assert_json_snapshot!("get_data", data, { ".current_totp" => "[totp]" });
}

#[test]
fn get_data_on_an_entry_without_otp_omits_the_field() {
    let fixture = Fixture::new();
    let run = run_host(
        BIN,
        &fixture,
        &[json!({ "type": "getData", "entry": "Dev/github" })],
    );
    assert_eq!(run.responses[0], json!({}));
}

#[test]
fn a_missing_entry_is_an_error_object_that_leaks_nothing() {
    let fixture = Fixture::new();
    let run = run_host(
        BIN,
        &fixture,
        &[json!({ "type": "getLogin", "entry": "Web/nope" })],
    );
    let raw = serde_json::to_string(&run.responses[0]).unwrap();
    assert!(run.responses[0]["error"].is_string());
    assert!(!raw.contains("hunter2"));
    insta::assert_json_snapshot!("missing_entry", run.responses[0]);
}

#[test]
fn an_unsupported_type_is_rejected() {
    let fixture = Fixture::new();
    let run = run_host(BIN, &fixture, &[json!({ "type": "create", "login": "x" })]);
    assert_eq!(
        run.responses[0],
        json!({ "error": "protocol: unsupported type 'create'" })
    );
}

#[test]
fn malformed_json_is_answered_not_crashed() {
    let fixture = Fixture::new();
    // A valid frame carrying a JSON array where an object was expected.
    let run = run_host(BIN, &fixture, &[json!([1, 2, 3])]);
    assert!(run.responses[0]["error"].is_string());
    assert!(run.status.success());
}
