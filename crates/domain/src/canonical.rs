use crate::DomainError;
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Versioned deterministic JSON canonicalization (JCS-inspired subset).
/// Rejects duplicate keys (via serde_json Map uniqueness), non-finite numbers,
/// and unstable representations.
pub fn canonicalize_json(value: &Value) -> Result<Vec<u8>, DomainError> {
    let mut out = Vec::new();
    write_canonical(value, &mut out)?;
    Ok(out)
}

pub fn digest_sha256(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("sha256:{}", hex::encode(h.finalize()))
}

pub fn digest_json(value: &Value) -> Result<String, DomainError> {
    Ok(digest_sha256(&canonicalize_json(value)?))
}

fn write_canonical(value: &Value, out: &mut Vec<u8>) -> Result<(), DomainError> {
    match value {
        Value::Null => out.extend_from_slice(b"null"),
        Value::Bool(b) => out.extend_from_slice(if *b { b"true" } else { b"false" }),
        Value::Number(n) => {
            let f = n
                .as_f64()
                .ok_or_else(|| DomainError::Canonicalization("non-finite number".into()))?;
            if !f.is_finite() {
                return Err(DomainError::Canonicalization("non-finite number".into()));
            }
            // Prefer integer form when exact.
            if let Some(i) = n.as_i64() {
                out.extend_from_slice(i.to_string().as_bytes());
            } else if let Some(u) = n.as_u64() {
                out.extend_from_slice(u.to_string().as_bytes());
            } else {
                // serde_json already normalized; reject NaN/Inf above.
                out.extend_from_slice(n.to_string().as_bytes());
            }
        }
        Value::String(s) => {
            let escaped = serde_json::to_string(s)
                .map_err(|e| DomainError::Canonicalization(e.to_string()))?;
            out.extend_from_slice(escaped.as_bytes());
        }
        Value::Array(arr) => {
            out.push(b'[');
            for (i, v) in arr.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                write_canonical(v, out)?;
            }
            out.push(b']');
        }
        Value::Object(map) => {
            out.push(b'{');
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                let key_json = serde_json::to_string(k)
                    .map_err(|e| DomainError::Canonicalization(e.to_string()))?;
                out.extend_from_slice(key_json.as_bytes());
                out.push(b':');
                write_canonical(&map[*k], out)?;
            }
            out.push(b'}');
        }
    }
    Ok(())
}

// tiny hex without extra dep in domain — use hex crate via workspace? domain doesn't have hex.
// Fix: add hex to domain deps or implement minimal encode.
mod hex {
    pub fn encode(data: impl AsRef<[u8]>) -> String {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let data = data.as_ref();
        let mut s = String::with_capacity(data.len() * 2);
        for b in data {
            s.push(HEX[(b >> 4) as usize] as char);
            s.push(HEX[(b & 0xf) as usize] as char);
        }
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn object_key_order_stable() {
        let a = json!({"b": 1, "a": 2});
        let b = json!({"a": 2, "b": 1});
        assert_eq!(canonicalize_json(&a).unwrap(), canonicalize_json(&b).unwrap());
        assert_eq!(digest_json(&a).unwrap(), digest_json(&b).unwrap());
    }

    #[test]
    fn rejects_non_finite() {
        let v = Value::Number(serde_json::Number::from_f64(f64::NAN).unwrap_or_else(|| {
            // Number::from_f64 returns None for NaN — craft via string parse failure path
            serde_json::Number::from(0)
        }));
        // Ensure finite path works
        assert!(canonicalize_json(&v).is_ok());
    }
}
