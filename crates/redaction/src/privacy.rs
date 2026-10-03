//! AT-PRIVACY: secret values do not survive redaction.

use super::{redact_json, redact_text};
use serde_json::json;

#[test]
fn redacts_bearer_and_json_keys() {
    assert!(redact_text("Authorization: Bearer abc.def.ghi").contains("[REDACTED]"));
    let v = redact_json(&json!({"access_token": "secret", "ok": 1}));
    assert_eq!(v["access_token"], "[REDACTED]");
    assert_eq!(v["ok"], 1);
}

#[test]
fn a_secret_without_a_label_does_not_survive() {
    for secret in [
        "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl",
        "osc_clm_AbC123.d3adb33fd3adb33f",
        "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        "https://app.example/claim#token=abc123&key=k3y",
    ] {
        let out = redact_text(&format!("request failed: {secret} (retrying)"));
        assert!(!out.contains("abc123") && !out.contains("d3adb33f") && !out.contains("eyJ"));
        assert!(!out.contains("ghp_") && !out.contains("k3y"), "{out}");
    }
}
