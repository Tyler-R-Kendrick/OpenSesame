//! Bounded parse of root-protection manifests. Fail closed before crypto (KP-20).

use serde_json::Value;

use super::error::ProtectionError;
use super::limits::{
    MANIFEST_SCHEMA_VERSION, MAX_MANIFEST_ENCODED_BYTES, MAX_PROTECTION_RECORDS,
    MAX_RECORD_ENCODED_BYTES,
};
use super::types::RootProtectionManifest;

/// One pass over raw JSON text, tracking object keys per nesting level so a
/// duplicate key — which `serde_json` would silently resolve to the last
/// value — is refused before parsing.
#[derive(Default)]
struct KeyScan {
    stack: Vec<std::collections::HashSet<String>>,
    in_string: bool,
    escape: bool,
    pending_key: bool,
    key_buf: String,
}

impl KeyScan {
    /// A character inside a string: escapes, the closing quote, or key text.
    fn string_char(&mut self, ch: char) {
        if self.escape {
            self.escape = false;
        } else if ch == '\\' {
            self.escape = true;
            return;
        } else if ch == '"' {
            self.in_string = false;
            return;
        }
        if self.pending_key {
            self.key_buf.push(ch);
        }
    }

    /// A character outside any string: structure, and the end of a key.
    fn structural_char(&mut self, ch: char) -> Result<(), ProtectionError> {
        match ch {
            '"' => {
                self.in_string = true;
                if !self.stack.is_empty() && !self.pending_key {
                    self.key_buf.clear();
                    self.pending_key = true;
                }
            }
            '{' => {
                self.stack.push(std::collections::HashSet::new());
                self.pending_key = false;
            }
            '}' => {
                self.stack.pop();
                self.pending_key = false;
            }
            ':' if self.pending_key => self.close_key()?,
            ',' => {
                self.pending_key = false;
                self.key_buf.clear();
            }
            _ => {}
        }
        Ok(())
    }

    fn close_key(&mut self) -> Result<(), ProtectionError> {
        let fresh = self
            .stack
            .last_mut()
            .is_none_or(|top| top.insert(self.key_buf.clone()));
        if !fresh {
            return Err(ProtectionError::MalformedEncoding(format!(
                "duplicate JSON key {}",
                self.key_buf
            )));
        }
        self.pending_key = false;
        self.key_buf.clear();
        Ok(())
    }
}

fn detect_duplicate_json_keys(raw: &str) -> Result<(), ProtectionError> {
    let mut scan = KeyScan::default();
    for ch in raw.chars() {
        if scan.in_string {
            scan.string_char(ch);
        } else {
            scan.structural_char(ch)?;
        }
    }
    Ok(())
}

/// Parse and bound-check a root-protection manifest JSON document.
///
/// # Errors
///
/// Returns typed failures for size, duplicates, unknown versions, or shape.
pub fn parse_root_protection_manifest(
    input: &str,
) -> Result<RootProtectionManifest, ProtectionError> {
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
        return Err(ProtectionError::UnsupportedVersion(
            u32::try_from(schema_version).unwrap_or(u32::MAX),
        ));
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
