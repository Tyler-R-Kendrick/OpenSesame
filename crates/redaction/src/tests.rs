//! Every vector in `spec/log-scrub/log-scrub.json`, the same table
//! `@opensesame/log-scrub` runs.

use super::*;
use serde_json::json;

fn spec() -> Value {
    serde_json::from_str(include_str!("../../../spec/log-scrub/log-scrub.json")).unwrap()
}

#[test]
fn every_shared_vector_agrees() {
    for vector in spec()["vectors"].as_array().unwrap() {
        let input = vector["input"].as_str().unwrap();
        let expect = vector["expect"].as_str().unwrap();
        assert_eq!(redact_text(input), expect, "rule {}", vector["rule"]);
    }
}

#[test]
fn nothing_in_the_unchanged_list_is_touched() {
    for text in spec()["unchanged"].as_array().unwrap() {
        let text = text.as_str().unwrap();
        assert_eq!(redact_text(text), text);
    }
}

#[test]
fn every_key_vector_agrees() {
    for vector in spec()["keyVectors"].as_array().unwrap() {
        let key = vector["key"].as_str().unwrap();
        assert_eq!(
            is_sensitive_key(key),
            vector["sensitive"].as_bool().unwrap(),
            "key {key}"
        );
    }
}

#[test]
fn scrubbing_is_idempotent() {
    for vector in spec()["vectors"].as_array().unwrap() {
        let once = redact_text(vector["input"].as_str().unwrap());
        assert_eq!(redact_text(&once), once);
    }
}

#[test]
fn the_marker_is_the_spec_marker() {
    assert_eq!(MARKER, spec()["marker"].as_str().unwrap());
}

#[test]
fn json_keys_and_strings_are_both_scrubbed() {
    let out = redact_json(&json!({
        "user": "ada",
        "ctx": {"session": {"accessToken": "at-1", "tokenType": "Bearer"}},
        "note": "retry with Authorization: Bearer abc.def.ghi",
        "rows": [{"password": "p"}, "https://x.example/cb?code=abc&state=z"],
        "hasPassword": true,
        "secret": null,
    }));
    assert_eq!(
        out,
        json!({
            "user": "ada",
            "ctx": {"session": {"accessToken": MARKER, "tokenType": "Bearer"}},
            "note": format!("retry with Authorization: {MARKER}"),
            "rows": [{"password": MARKER}, format!("https://x.example/cb?code={MARKER}&state={MARKER}")],
            "hasPassword": true,
            "secret": null,
        })
    );
}

#[test]
fn depth_is_bounded() {
    let mut doc = json!("leaf");
    for _ in 0..40 {
        doc = json!({ "next": doc });
    }
    assert!(redact_json(&doc).to_string().contains(MARKER));
}

#[test]
fn a_long_hostile_line_scrubs_quickly() {
    let start = std::time::Instant::now();
    let _ = redact_text(&format!("{}password=x", "a.".repeat(100_000)));
    let _ = redact_text(&"-----BEGIN A-----".repeat(5_000));
    assert!(start.elapsed().as_secs() < 5);
}
