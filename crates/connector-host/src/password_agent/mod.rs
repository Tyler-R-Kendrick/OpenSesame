//! Human-operated 1Password parity planning. No guest materialization path.
pub mod discover;
pub mod env;
pub mod lease;
pub mod policy;
pub mod request;
pub mod app_integration;
pub mod reveal_gate;
pub mod service;
pub mod writes;

use serde_json::Value;
/// Parse the concatenated JSON documents returned by `op item get -`.
/// # Errors
/// Rejects malformed or incomplete provider output.
pub fn documents(raw: &[u8]) -> anyhow::Result<Vec<Value>> {
    let mut result = Vec::new();
    for value in serde_json::Deserializer::from_slice(raw).into_iter::<Value>() {
        match value? {
            Value::Array(items) => result.extend(items),
            item => result.push(item),
        }
    }
    Ok(result)
}
/// Validate identifiers before constructing an output reference.
/// # Errors
/// Rejects untrusted provider identifiers.
pub fn reference(item: &Value, field: &str) -> anyhow::Result<String> {
    let id = item["id"].as_str().unwrap_or_default();
    let vault = item["vault"]["id"].as_str().unwrap_or_default();
    anyhow::ensure!(
        [id, vault].iter().all(|id| id.len() == 26
            && id
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())),
        "Provider returned invalid identifiers"
    );
    Ok(format!("op://{vault}/{id}/{field}"))
}
#[cfg(test)]
mod tests;
/// Validate value-blind metadata before projecting provider output.
/// # Errors
/// Rejects malformed metadata without including provider data in diagnostics.
pub fn validate_summary(item: &Value) -> anyhow::Result<()> {
    anyhow::ensure!(
        ["id", "title", "category"]
            .iter()
            .all(|key| item[*key].is_string())
            && item["vault"]["name"].is_string(),
        "Invalid 1Password item metadata"
    );
    Ok(())
}
/// Validate detailed provider metadata and optional private field values.
/// # Errors
/// Rejects malformed field structures without returning provider details.
pub fn validate_item(item: &Value) -> anyhow::Result<()> {
    validate_summary(item)?;
    let fields = item["fields"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Invalid 1Password item fields"))?;
    for field in fields {
        anyhow::ensure!(
            field["id"].is_string() && field["type"].is_string(),
            "Invalid 1Password field metadata"
        );
        for key in ["label", "purpose", "reference", "value"] {
            anyhow::ensure!(
                field.get(key).is_none_or(Value::is_string),
                "Invalid 1Password field metadata"
            );
        }
        anyhow::ensure!(
            field["section"].get("label").is_none_or(Value::is_string),
            "Invalid 1Password section metadata"
        );
    }
    for key in ["created_at", "updated_at"] {
        anyhow::ensure!(
            item.get(key).is_none_or(Value::is_string),
            "Invalid 1Password timestamps"
        );
    }
    Ok(())
}
