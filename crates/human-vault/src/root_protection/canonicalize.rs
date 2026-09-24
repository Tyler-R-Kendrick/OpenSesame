//! Deterministic JSON canonicalization for manifests we author (RFC 8785 subset).

use serde_json::{Map, Value};

use super::error::ProtectionError;

fn canonicalize_value(value: &Value) -> Result<Value, ProtectionError> {
    match value {
        Value::Null | Value::Bool(_) | Value::String(_) => Ok(value.clone()),
        Value::Number(n) => {
            if n.is_f64() {
                let Some(f) = n.as_f64() else {
                    return Err(ProtectionError::MalformedEncoding(
                        "non-finite number".into(),
                    ));
                };
                if !f.is_finite() {
                    return Err(ProtectionError::MalformedEncoding(
                        "non-finite number".into(),
                    ));
                }
            }
            Ok(value.clone())
        }
        Value::Array(items) => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                out.push(canonicalize_value(item)?);
            }
            Ok(Value::Array(out))
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut out = Map::new();
            for key in keys {
                // Explicit nulls are kept; only absent keys are skipped.
                if let Some(entry) = map.get(key) {
                    out.insert(key.clone(), canonicalize_value(entry)?);
                }
            }
            Ok(Value::Object(out))
        }
    }
}

/// UTF-8 bytes of sorted-key JSON without insignificant whitespace.
///
/// # Errors
///
/// Returns `MalformedEncoding` when the value cannot be canonicalized.
pub fn canonicalize_to_bytes(value: &Value) -> Result<Vec<u8>, ProtectionError> {
    let canonical = canonicalize_value(value)?;
    serde_json::to_vec(&canonical)
        .map_err(|e| ProtectionError::MalformedEncoding(e.to_string()))
}
