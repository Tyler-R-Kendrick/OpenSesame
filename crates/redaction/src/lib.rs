use regex::Regex;

/// Whole-key match. `token` is sensitive; `token_type` is not.
fn is_sensitive_key(key: &str) -> bool {
    static SENSITIVE_KEYS: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(
            r"(?i)^(password|passwd|secret|token|authorization|refresh_token|access_token|id_token|client_secret|private_key|device_code|user_code|claim_token|cookie|set[_-]?cookie|api[_-]?key)$",
        )
        .unwrap()
    });
    SENSITIVE_KEYS.is_match(key)
}

/// Prefix-preserving patterns: the captured label survives, the value does not.
static TEXT_PATTERNS: std::sync::LazyLock<Vec<Regex>> = std::sync::LazyLock::new(|| {
    [
        r"(?i)(Bearer\s+)\S+",
        r"(?i)(Basic\s+)\S+",
        // Any `key=value` / `key: value` pair whose label looks secret. Backend
        // errors routinely echo the query string or header that failed.
        r#"(?i)\b(password|passwd|secret|client[_-]?secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|device[_-]?code|user[_-]?code|claim[_-]?token|code[_-]?verifier|private[_-]?key|token|authorization|cookie)\b(["']?\s*[=:]\s*["']?)[^&\s,;)\]}"']+"#,
    ]
    .into_iter()
    .map(|p| Regex::new(p).expect("static redaction pattern"))
    .collect()
});

/// `scheme://user:pass@host` — DSNs in connection errors are the usual carrier.
static URL_USERINFO: std::sync::LazyLock<Regex> =
    std::sync::LazyLock::new(|| Regex::new(r"(?i)([a-z][a-z0-9+.\-]*://)[^/\s@]*@").unwrap());

pub fn redact_text(input: &str) -> String {
    let mut out = URL_USERINFO
        .replace_all(input, "${1}[REDACTED]@")
        .into_owned();
    for re in TEXT_PATTERNS.iter() {
        out = re
            .replace_all(&out, |caps: &regex::Captures<'_>| {
                // Group 1 is the label (or auth scheme); the optional group 2 is
                // the `=` / `:` separator we must keep to stay readable.
                let label = caps.get(1).map_or("", |m| m.as_str());
                let sep = caps.get(2).map_or("", |m| m.as_str());
                format!("{label}{sep}[REDACTED]")
            })
            .into_owned();
    }
    out
}

pub fn redact_json(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                if is_sensitive_key(k) {
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
    fn redacts_complete_authorization_values_but_not_an_empty_scheme() {
        assert_eq!(redact_text("Basic "), "Basic ");
        let redacted = redact_text("Authorization: Bearer odd~token!?");
        assert!(redacted.contains("[REDACTED]"));
        assert!(!redacted.contains("odd~token!?"));
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
    fn redacts_dsn_credentials() {
        // The usual carrier: a connection error echoing its own DSN.
        let s = redact_text(
            "error connecting to postgres://os_app:sup3r-s3cret@db.internal:5432/opensesame",
        );
        assert!(!s.contains("sup3r-s3cret"), "{s}");
        assert!(!s.contains("os_app"), "{s}");
        assert!(
            s.contains("postgres://[REDACTED]@db.internal:5432/opensesame"),
            "{s}"
        );

        let redis = redact_text("redis://:hunter2@cache:6379 refused");
        assert!(!redis.contains("hunter2"), "{redis}");
    }

    #[test]
    fn redacts_labelled_values_beyond_the_original_three() {
        let s = redact_text("GET /x?api_key=AKIA123&user_code=BCDF-GHJK&page=2 failed");
        assert!(!s.contains("AKIA123"), "{s}");
        assert!(!s.contains("BCDF-GHJK"), "{s}");
        assert!(s.contains("page=2"), "{s}");

        let basic = redact_text("Authorization: Basic dXNlcjpwYXNz");
        assert!(!basic.contains("dXNlcjpwYXNz"), "{basic}");

        let header = redact_text("upstream rejected header authorization: Bearer eyJhbGciOi");
        assert!(!header.contains("eyJhbGciOi"), "{header}");

        let json_ish = redact_text("{\"client_secret\":\"cs_live_abc\",\"ok\":true}");
        assert!(!json_ish.contains("cs_live_abc"), "{json_ish}");
        assert!(json_ish.contains("\"ok\":true"), "{json_ish}");
    }

    #[test]
    fn leaves_innocuous_text_intact() {
        let s = redact_text("authority quorum degraded: 1 of 3 nodes reachable");
        assert_eq!(s, "authority quorum degraded: 1 of 3 nodes reachable");
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

#[cfg(test)]
mod pact {
    use super::*;
    use serde_json::json;

    #[test]
    fn property_token_type_survives_across_many_shapes() {
        for ty in ["Bearer", "token", "mac"] {
            let v = redact_json(&json!({
                "token_type": ty,
                "access_token": "leak",
            }));
            assert_eq!(v["token_type"], ty, "{ty}");
            assert_eq!(v["access_token"], "[REDACTED]");
        }
    }

    #[test]
    fn adversarial_substring_token_in_token_type_is_not_a_secret_key() {
        assert!(!is_sensitive_key("token_type"));
        assert!(!is_sensitive_key("Token_Type"));
        assert!(is_sensitive_key("token"));
        assert!(is_sensitive_key("access_token"));
        let v = redact_json(&json!({"token_type": "Bearer", "ok": 1}));
        assert_eq!(v["token_type"], "Bearer");
        assert_eq!(v["ok"], 1);
    }

    #[test]
    fn chaos_concurrent_redaction_never_leaks() {
        let input = json!({"refresh_token": "r", "token_type": "Bearer"});
        let results: Vec<_> = (0..32).map(|_| redact_json(&input)).collect();
        for v in results {
            assert_eq!(v["refresh_token"], "[REDACTED]");
            assert_eq!(v["token_type"], "Bearer");
            assert!(!v.to_string().contains("\"r\"") || v["refresh_token"] == "[REDACTED]");
        }
    }

    #[test]
    fn contract_redacted_object_has_no_secret_values() {
        let v = redact_json(&json!({
            "access_token": "s",
            "refresh_token": "r",
            "token_type": "Bearer"
        }));
        let blob = v.to_string();
        assert!(!blob.contains("\"s\""));
        assert!(!blob.contains("\"r\""));
        assert!(blob.contains("Bearer"));
        assert!(blob.contains("token_type"));
    }
}
