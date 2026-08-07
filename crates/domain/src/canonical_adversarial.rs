//! Adversarial canonicalization / digest tests (included from lib under cfg(test)).

#[cfg(test)]
mod tests {
    use crate::{canonicalize_json, digest_json, DomainError};
    use serde_json::{json, Value};

    #[test]
    fn nested_key_order_stable() {
        let a = json!({"z": {"b": 1, "a": 2}, "y": [3, 1]});
        let b = json!({"y": [3, 1], "z": {"a": 2, "b": 1}});
        assert_eq!(digest_json(&a).unwrap(), digest_json(&b).unwrap());
    }

    #[test]
    fn unicode_strings_roundtrip_escape() {
        let v = json!({"msg": "café — 日本語"});
        let c = canonicalize_json(&v).unwrap();
        assert!(std::str::from_utf8(&c).is_ok());
        assert!(digest_json(&v).unwrap().starts_with("sha256:"));
    }

    #[test]
    fn empty_object_and_array_stable() {
        assert_eq!(
            canonicalize_json(&json!({})).unwrap(),
            br#"{}"#.as_slice()
        );
        assert_eq!(
            canonicalize_json(&json!([])).unwrap(),
            br#"[]"#.as_slice()
        );
    }

    #[test]
    fn integers_and_floats_distinct_when_needed() {
        let i = json!({"n": 1});
        let f = json!({"n": 1.5});
        assert_ne!(digest_json(&i).unwrap(), digest_json(&f).unwrap());
    }

    #[test]
    fn deep_nesting_bounded_ok() {
        let mut v = json!(1);
        for _ in 0..32 {
            v = json!([v]);
        }
        assert!(canonicalize_json(&v).is_ok());
    }

    #[test]
    fn boolean_and_null() {
        assert_eq!(canonicalize_json(&Value::Bool(true)).unwrap(), b"true");
        assert_eq!(canonicalize_json(&Value::Null).unwrap(), b"null");
    }

    #[test]
    fn digest_changes_on_value_change() {
        let a = json!({"x": 1});
        let b = json!({"x": 2});
        assert_ne!(digest_json(&a).unwrap(), digest_json(&b).unwrap());
    }

    #[test]
    fn error_display_safe() {
        let e = DomainError::Canonicalization("boom".into());
        assert!(!e.to_string().contains("password"));
    }
}
