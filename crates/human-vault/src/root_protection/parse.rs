//! Bounded parse of root-protection manifests. Fail closed before crypto (KP-20).

use serde_json::Value;

use super::error::ProtectionError;
use super::limits::{
    MANIFEST_SCHEMA_VERSION, MAX_MANIFEST_ENCODED_BYTES, MAX_PROTECTION_RECORDS,
    MAX_RECORD_ENCODED_BYTES,
};
use super::types::RootProtectionManifest;

fn detect_duplicate_json_keys(raw: &str) -> Result<(), ProtectionError> {
    let mut stack: Vec<std::collections::HashSet<String>> = Vec::new();
    let mut in_string = false;
    let mut escape = false;
    let mut pending_key = false;
    let mut key_buf = String::new();
    for ch in raw.chars() {
        if in_string {
            if escape {
                escape = false;
                if pending_key {
                    key_buf.push(ch);
                }
                continue;
            }
            if ch == '\\' {
                escape = true;
                continue;
            }
            if ch == '"' {
                in_string = false;
                continue;
            }
            if pending_key {
                key_buf.push(ch);
            }
            continue;
        }
        match ch {
            '"' => {
                in_string = true;
                if !stack.is_empty() && !pending_key {
                    key_buf.clear();
                    pending_key = true;
                }
            }
            '{' => {
                stack.push(std::collections::HashSet::new());
                pending_key = false;
            }
            '}' => {
                stack.pop();
                pending_key = false;
            }
            ':' if pending_key => {
                if let Some(top) = stack.last_mut() {
                    if !top.insert(key_buf.clone()) {
                        return Err(ProtectionError::MalformedEncoding(format!(
                            "duplicate JSON key {key_buf}"
                        )));
                    }
                }
                pending_key = false;
                key_buf.clear();
            }
            ',' => {
                pending_key = false;
                key_buf.clear();
            }
            _ => {}
        }
    }
    Ok(())
}

/// Parse and bound-check a root-protection manifest JSON document.
///
/// # Errors
///
/// Returns typed failures for size, duplicates, unknown versions, or shape.
pub fn parse_root_protection_manifest(input: &str) -> Result<RootProtectionManifest, ProtectionError> {
    if input.len() > MAX_MANIFEST_ENCODED_BYTES {
        return Err(ProtectionError::OversizedManifest);
    }
    detect_duplicate_json_keys(input)?;
    let value: Value = serde_json::from_str(input)
        .map_err(|e| ProtectionError::MalformedEncoding(e.to_string()))?;
    let Some(obj) = value.as_object() else {
        return Err(ProtectionError::MalformedEncoding(
            "manifest must be an object".into(),
        ));
    };
    let schema_version = obj
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| ProtectionError::MalformedEncoding("schemaVersion".into()))?;
    if schema_version != u64::from(MANIFEST_SCHEMA_VERSION) {
        return Err(ProtectionError::UnsupportedVersion(schema_version as u32));
    }
    if obj.contains_key("criticalExtensions") {
        return Err(ProtectionError::UnknownCriticalField);
    }
    let Some(records) = obj.get("records").and_then(Value::as_array) else {
        return Err(ProtectionError::MalformedEncoding(
            "records must be an array".into(),
        ));
    };
    if records.len() > MAX_PROTECTION_RECORDS {
        return Err(ProtectionError::TooManyRecords);
    }
    let mut seen = std::collections::HashSet::new();
    for (index, record) in records.iter().enumerate() {
        let encoded = serde_json::to_vec(record)
            .map_err(|e| ProtectionError::MalformedEncoding(e.to_string()))?;
        if encoded.len() > MAX_RECORD_ENCODED_BYTES {
            return Err(ProtectionError::OversizedRecord);
        }
        let id = record
            .get("protectorId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ProtectionError::MalformedEncoding(format!("records[{index}].protectorId"))
            })?;
        if !seen.insert(id.to_string()) {
            return Err(ProtectionError::DuplicateProtectorId);
        }
    }
    serde_json::from_value(value).map_err(|e| ProtectionError::MalformedEncoding(e.to_string()))
}
