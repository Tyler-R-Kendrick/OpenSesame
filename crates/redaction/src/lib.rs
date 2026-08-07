use regex::Regex;
use once_cell::sync::Lazy;

static SENSITIVE_KEYS: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)(password|secret|token|authorization|refresh_token|access_token|client_secret|private_key|device_code|claim_token|cookie|set-cookie)").unwrap()
});

pub fn redact_text(input: &str) -> String {
    let mut out = input.to_string();
    for pat in [
        r"(?i)(Bearer\s+)[A-Za-z0-9\-_./+=]+",
        r"(?i)(device_code=)[^&\s]+",
        r"(?i)(refresh_token=)[^&\s]+",
    ] {
        let re = Regex::new(pat).unwrap();
        out = re.replace_all(&out, "$1[REDACTED]").into_owned();
    }
    out
}

pub fn redact_json(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                if SENSITIVE_KEYS.is_match(k) {
                    out.insert(k.clone(), serde_json::Value::String("[REDACTED]".into()));
                } else {
                    out.insert(k.clone(), redact_json(v));
                }
            }
            serde_json::Value::Object(out)
        }
        serde_json::Value::Array(arr) => {
            serde_json::Value::Array(arr.iter().map(redact_json).collect())
        }
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn redacts_bearer_and_json_keys() {
        assert!(redact_text("Authorization: Bearer abc.def.ghi").contains("[REDACTED]"));
        let v = redact_json(&json!({"access_token": "secret", "ok": 1}));
        assert_eq!(v["access_token"], "[REDACTED]");
        assert_eq!(v["ok"], 1);
    }

    #[test]
    fn redacts_nested_and_array() {
        let v = redact_json(&json!({
            "outer": {"refresh_token": "r", "name": "ok"},
            "list": [{"client_secret": "c"}, {"n": 1}]
        }));
        assert_eq!(v["outer"]["refresh_token"], "[REDACTED]");
        assert_eq!(v["outer"]["name"], "ok");
        assert_eq!(v["list"][0]["client_secret"], "[REDACTED]");
        assert_eq!(v["list"][1]["n"], 1);
    }

    #[test]
    fn redacts_query_style_secrets() {
        let s = redact_text("https://x/?device_code=ABC&refresh_token=ZZZ&ok=1");
        assert!(s.contains("device_code=[REDACTED]"));
        assert!(s.contains("refresh_token=[REDACTED]"));
        assert!(s.contains("ok=1"));
        assert!(!s.contains("ABC"));
        assert!(!s.contains("ZZZ"));
    }

    #[test]
    fn redacts_claim_token_key() {
        let v = redact_json(&json!({"claim_token": "once", "id": "1"}));
        assert_eq!(v["claim_token"], "[REDACTED]");
    }

    #[test]
    fn case_insensitive_keys() {
        let v = redact_json(&json!({"Access_Token": "x", "PASSWORD": "y"}));
        assert_eq!(v["Access_Token"], "[REDACTED]");
        assert_eq!(v["PASSWORD"], "[REDACTED]");
    }
}
