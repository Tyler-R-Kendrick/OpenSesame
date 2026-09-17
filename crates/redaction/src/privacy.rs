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
