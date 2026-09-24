//! Golden protocol tests for `opensesame-gopass-jsonapi`.
//!
//! Same harness as the browserpass tests: the real binary, a tempdir store,
//! fixed requests, snapshotted responses. `getData` carries a live TOTP, so
//! that one field is redacted — everything else is pinned exactly.

#![cfg(feature = "gopass")]

mod named;
#[path = "../../../crates/pm-bridges/tests/support/mod.rs"]
mod support;

use opensesame_pm_bridges::store::StoreAccess;
use opensesame_pm_bridges::testing::FIXTURE_PASSPHRASE;
use opensesame_sealed_store::Entry;
use serde_json::json;
use support::{run_host, Fixture};

fn bin() -> String {
    named::binary("opensesame-gopass-jsonapi")
}

#[test]
fn query_matches_entry_paths() {
    let fixture = Fixture::new();
    let run = run_host(
        &bin(),
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
    let run = run_host(&bin(), &fixture, &[json!({ "type": "query", "query": "" })]);
    assert_eq!(run.responses[0], json!(["Dev/github", "Web/example.com"]));
}

#[test]
fn query_with_no_match_is_an_empty_array_not_an_error() {
    let fixture = Fixture::new();
    let run = run_host(
        &bin(),
        &fixture,
        &[json!({ "type": "query", "query": "nothing-here" })],
    );
    assert_eq!(run.responses[0], json!([]));
}

#[test]
fn query_host_serves_a_parent_entry_to_a_subdomain() {
    let fixture = Fixture::new();
    let run = run_host(
        &bin(),
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
    let run = run_host(
        &bin(),
        &fixture,
        &[json!({ "type": "queryHost", "host": "com" })],
    );
    assert_eq!(run.responses[0], json!([]));
}

#[test]
fn query_host_never_offers_a_bare_label_to_a_lookalike() {
    let fixture = Fixture::new();
    // `Dev/github` is a label, not a domain: no host may claim it by name.
    let hosts = ["github.lol", "attacker.github.io", "github.com"];
    let requests: Vec<_> = hosts
        .iter()
        .map(|host| json!({ "type": "queryHost", "host": host }))
        .collect();
    let run = run_host(&bin(), &fixture, &requests);
    assert_eq!(run.responses, vec![json!([]); hosts.len()]);
}

/// Seal URL-less entries into the fixture store: only their path names them.
fn add_url_less(fixture: &Fixture, names: &[&str]) {
    let store = StoreAccess::open(fixture.store_path(), Some(FIXTURE_PASSPHRASE)).expect("open");
    for name in names {
        let entry = Entry {
            secret: "tenant-secret".into(),
            trailer: String::new(),
            otp: None,
        };
        store.put(name, &entry).expect("put");
    }
}

#[test]
fn query_host_never_hands_a_shared_suffix_tenant_its_neighbour() {
    let fixture = Fixture::new();
    add_url_less(&fixture, &["Web/victim.github.io", "Web/bank.co.uk"]);
    // Walking `attacker.github.io` up to `github.io` would have collected
    // `Web/victim.github.io` as a child of the walked suffix.
    let hosts = [
        "attacker.github.io",
        "https://attacker.github.io/login",
        "login.attacker.github.io",
        "attacker.co.uk",
        "www.attacker.co.uk",
    ];
    let requests: Vec<_> = hosts
        .iter()
        .map(|host| json!({ "type": "queryHost", "host": host }))
        .collect();
    let run = run_host(&bin(), &fixture, &requests);
    assert!(run.status.success(), "stderr: {}", run.stderr);
    assert_eq!(run.responses, vec![json!([]); hosts.len()]);
}

#[test]
fn query_host_still_finds_a_url_less_entry_for_its_own_host_and_subdomains() {
    let fixture = Fixture::new();
    add_url_less(&fixture, &["Web/victim.github.io", "Web/bank.co.uk"]);
    let run = run_host(
        &bin(),
        &fixture,
        &[
            json!({ "type": "queryHost", "host": "victim.github.io" }),
            json!({ "type": "queryHost", "host": "login.victim.github.io" }),
            json!({ "type": "queryHost", "host": "https://www.bank.co.uk/signin" }),
            json!({ "type": "queryHost", "host": "online.bank.co.uk" }),
        ],
    );
    assert!(run.status.success(), "stderr: {}", run.stderr);
    assert_eq!(run.responses[0], json!(["Web/victim.github.io"]));
    assert_eq!(run.responses[1], json!(["Web/victim.github.io"]));
    assert_eq!(run.responses[2], json!(["Web/bank.co.uk"]));
    assert_eq!(run.responses[3], json!(["Web/bank.co.uk"]));
}

#[test]
fn get_login_returns_the_username_and_password() {
    let fixture = Fixture::new();
    let run = run_host(
        &bin(),
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
        &bin(),
        &fixture,
        &[json!({ "type": "getLogin", "entry": "Dev/github" })],
    );
    assert_eq!(run.responses[0]["username"], "github");
}

#[test]
fn get_data_returns_the_current_totp_and_extras() {
    let fixture = Fixture::new();
    let run = run_host(
        &bin(),
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
        &bin(),
        &fixture,
        &[json!({ "type": "getData", "entry": "Dev/github" })],
    );
    assert_eq!(run.responses[0], json!({}));
}

#[test]
fn a_missing_entry_is_an_error_object_that_leaks_nothing() {
    let fixture = Fixture::new();
    let run = run_host(
        &bin(),
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
    let run = run_host(
        &bin(),
        &fixture,
        &[json!({ "type": "create", "login": "x" })],
    );
    assert_eq!(
        run.responses[0],
        json!({ "error": "protocol: unsupported type 'create'" })
    );
}

#[test]
fn malformed_json_is_answered_not_crashed() {
    let fixture = Fixture::new();
    // A valid frame carrying a JSON array where an object was expected.
    let run = run_host(&bin(), &fixture, &[json!([1, 2, 3])]);
    assert!(run.responses[0]["error"].is_string());
    assert!(run.status.success());
}
