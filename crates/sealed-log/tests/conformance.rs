//! The sealed log line format is one definition (ADR 0157): the lines in
//! `spec/conformance/sealed-log-vectors.json` were sealed once and every
//! implementation must open them. `packages/observability` runs the same file.
//!
//! `UPDATE_SEALED_LOG_VECTORS=1` writes the separate current-envelope fixture.
//! The legacy fixture stays immutable so compatibility cannot be rewritten away.

use opensesame_sealed_log::{open_line, seal_line, LogKey};
use serde_json::{json, Value};

const PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../spec/conformance/sealed-log-vectors.json"
);
const ENVELOPE_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../spec/conformance/sealed-log-envelope-vectors.json"
);
const KEY_HEX: &str = "0707070707070707070707070707070707070707070707070707070707070707";
const PLAIN: &[&str] = &[
    "vault unlocked",
    "{\"level\":\"INFO\",\"fields\":{\"message\":\"claim opened\",\"user\":\"ada\"}}",
    "unicode ✓ – non-ASCII, and a tab\there",
    "",
];

fn key() -> LogKey {
    let bytes: [u8; 32] = hex::decode(KEY_HEX).unwrap().try_into().unwrap();
    LogKey::from_bytes(bytes)
}

fn generate() -> Value {
    let lines: Vec<Value> = PLAIN
        .iter()
        .map(|plain| json!({ "plain": plain, "sealed": seal_line(&key(), plain) }))
        .collect();
    json!({
        "$comment": "Sealed log lines: every implementation of the format (crates/sealed-log, packages/observability) must open each `sealed` to its `plain` under `key`, and refuse each `notOpening`. Regenerated only when the format changes: UPDATE_SEALED_LOG_VECTORS=1 cargo test -p opensesame-sealed-log --test conformance.",
        "format": "osl2. wrapped-DEK envelope; trusted key namespace empty; purpose sealed-log.line",
        "namespace": "",
        "key": KEY_HEX,
        "lines": lines,
        "notOpening": [
            { "why": "not sealed", "line": "plain text" },
            { "why": "prefix only", "line": "osl2." },
            { "why": "shorter than an envelope", "line": "osl2.AAAA" },
            { "why": "unsupported prefix", "line": "osl3.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }
        ]
    })
}

#[test]
fn every_vector_opens_and_every_refusal_refuses() {
    if std::env::var_os("UPDATE_SEALED_LOG_VECTORS").is_some() {
        std::fs::write(
            ENVELOPE_PATH,
            format!("{}\n", serde_json::to_string_pretty(&generate()).unwrap()),
        )
        .unwrap();
    }
    let vectors: Value = serde_json::from_str(&std::fs::read_to_string(PATH).unwrap()).unwrap();
    assert_eq!(vectors["key"], KEY_HEX);
    let plains: Vec<&str> = vectors["lines"]
        .as_array()
        .unwrap()
        .iter()
        .map(|vector| vector["plain"].as_str().unwrap())
        .collect();
    assert_eq!(plains, PLAIN, "the file covers what generate() seals");
    for vector in vectors["lines"].as_array().unwrap() {
        let opened = open_line(&key(), vector["sealed"].as_str().unwrap());
        assert_eq!(opened.as_deref(), vector["plain"].as_str(), "{vector}");
    }
    for refusal in vectors["notOpening"].as_array().unwrap() {
        assert!(
            open_line(&key(), refusal["line"].as_str().unwrap()).is_none(),
            "{refusal}"
        );
    }
}
