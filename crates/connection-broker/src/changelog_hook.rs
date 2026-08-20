//! Secret/config changelog hook (Host plane).
//!
//! WP-C / WP-E call [`record_secret_changelog`] at sync and rotation sites.
//! Events carry **metadata only** — never secret values. Call sites that still
//! lack a `// CHANGELOG_HOOK` marker wire through this module.
//!
//! Frozen event type strings (must match `@opensesame/audit` / WP-B):
//! - `secret.config.created|updated|deleted`
//! - `secret.value.changed`
//! - `sync.target.created|synced|failed`
//! - `credential.rotation.requested|succeeded|failed`
//! - `project.personal.ensured`

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Map, Value};
use uuid::Uuid;

/// Maximum retained Host changelog rows per organization (ring buffer).
const MAX_ENTRIES_PER_ORG: usize = 512;

/// Frozen Host changelog event types (must match the module docs).
pub const CHANGELOG_EVENT_TYPES: &[&str] = &[
    "secret.config.created",
    "secret.config.updated",
    "secret.config.deleted",
    "secret.value.changed",
    "sync.target.created",
    "sync.target.synced",
    "sync.target.failed",
    "credential.rotation.requested",
    "credential.rotation.succeeded",
    "credential.rotation.failed",
    "project.personal.ensured",
];

pub fn is_allowed_changelog_event_type(event_type: &str) -> bool {
    CHANGELOG_EVENT_TYPES.contains(&event_type)
}

/// Metadata-only changelog row for Host listing APIs.
#[derive(Debug, Clone, Serialize)]
pub struct ChangelogEntry {
    pub id: String,
    pub event_type: String,
    pub project_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub organization_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub key_names: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_version: Option<String>,
    pub occurred_at: DateTime<Utc>,
    /// Already redacted; never contains secret bodies.
    pub metadata: Map<String, Value>,
}

/// Input for [`record_secret_changelog`].
#[derive(Debug, Clone, Default)]
pub struct RecordSecretChangelog {
    pub event_type: String,
    pub project_id: String,
    pub organization_id: Option<String>,
    pub actor_id: Option<String>,
    pub config_id: Option<String>,
    pub environment: Option<String>,
    pub key_names: Vec<String>,
    pub version_id: Option<String>,
    pub target_id: Option<String>,
    pub content_version: Option<String>,
    pub occurred_at: Option<DateTime<Utc>>,
    /// Extra metadata; keys matching value/secret/password/token are stripped.
    pub metadata: Map<String, Value>,
}

fn store() -> &'static Mutex<std::collections::HashMap<String, VecDeque<ChangelogEntry>>> {
    static STORE: OnceLock<Mutex<std::collections::HashMap<String, VecDeque<ChangelogEntry>>>> =
        OnceLock::new();
    STORE.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn deny_metadata_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    lower.contains("value")
        || lower.contains("secret")
        || lower.contains("password")
        || lower.contains("token")
        || lower.contains("authorization")
        || lower.contains("bearer")
        || lower.contains("cookie")
        || lower.contains("refresh")
}

/// Strip forbidden keys and non-scalar/non-string-array values from metadata.
pub fn redact_changelog_metadata(input: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for (key, value) in input {
        if deny_metadata_key(key) {
            continue;
        }
        match value {
            Value::String(s) => {
                let clipped = if s.len() > 256 {
                    format!("{}…", &s[..256])
                } else {
                    s.clone()
                };
                out.insert(key.clone(), Value::String(clipped));
            }
            Value::Number(n) => {
                out.insert(key.clone(), Value::Number(n.clone()));
            }
            Value::Bool(b) => {
                out.insert(key.clone(), Value::Bool(*b));
            }
            Value::Null => {
                out.insert(key.clone(), Value::Null);
            }
            Value::Array(items) if items.iter().all(|v| v.is_string()) => {
                let names: Vec<Value> = items
                    .iter()
                    .filter_map(|v| v.as_str())
                    .map(|s| {
                        if s.len() > 256 {
                            Value::String(format!("{}…", &s[..256]))
                        } else {
                            Value::String(s.to_string())
                        }
                    })
                    .collect();
                out.insert(key.clone(), Value::Array(names));
            }
            _ => {}
        }
    }
    out
}

/// Record a metadata-only secret/config changelog event on the Host plane.
///
/// Returns the stored entry. Never persists secret values.
pub fn record_secret_changelog(input: RecordSecretChangelog) -> ChangelogEntry {
    let mut metadata = redact_changelog_metadata(&input.metadata);
    if let Some(config_id) = &input.config_id {
        metadata.insert("configId".into(), json!(config_id));
    }
    if let Some(environment) = &input.environment {
        metadata.insert("environment".into(), json!(environment));
    }
    if !input.key_names.is_empty() {
        metadata.insert("keyNames".into(), json!(input.key_names));
    }
    if let Some(version_id) = &input.version_id {
        metadata.insert("versionId".into(), json!(version_id));
    }
    if let Some(target_id) = &input.target_id {
        metadata.insert("targetId".into(), json!(target_id));
    }
    if let Some(content_version) = &input.content_version {
        metadata.insert("contentVersion".into(), json!(content_version));
    }
    if let Some(actor_id) = &input.actor_id {
        metadata.insert("actor".into(), json!(actor_id));
    }

    let entry = ChangelogEntry {
        id: format!("chg_{}", Uuid::new_v4()),
        event_type: input.event_type,
        project_id: input.project_id,
        organization_id: input.organization_id,
        actor_id: input.actor_id,
        config_id: input.config_id,
        environment: input.environment,
        key_names: input.key_names,
        version_id: input.version_id,
        target_id: input.target_id,
        content_version: input.content_version,
        occurred_at: input.occurred_at.unwrap_or_else(Utc::now),
        metadata,
    };

    let mut guard = store().lock().expect("changelog store poisoned");
    let org_key = entry
        .organization_id
        .clone()
        .unwrap_or_else(|| "_unscoped".into());
    let ring = guard.entry(org_key).or_default();
    ring.push_back(entry.clone());
    while ring.len() > MAX_ENTRIES_PER_ORG {
        ring.pop_front();
    }
    entry
}

/// List changelog events for a project **in one organization** (newest first).
///
/// The store is org-keyed. Scanning every org for a caller-supplied project id
/// is a cross-tenant read; callers must pass the authenticated organization.
pub fn list_secret_changelog(
    organization_id: &str,
    project_id: &str,
    limit: usize,
) -> Vec<ChangelogEntry> {
    let guard = store().lock().expect("changelog store poisoned");
    let Some(ring) = guard.get(organization_id) else {
        return Vec::new();
    };
    let mut entries: Vec<_> = ring
        .iter()
        .filter(|e| e.project_id == project_id)
        .cloned()
        .collect();
    entries.sort_by(|a, b| b.occurred_at.cmp(&a.occurred_at));
    entries.into_iter().take(limit.clamp(1, 200)).collect()
}

/// Clear the in-memory Host changelog (tests / local reset only).
pub fn clear_secret_changelog_for_tests() {
    store().lock().expect("changelog store poisoned").clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_strips_secret_values() {
        let mut metadata = Map::new();
        metadata.insert("value".into(), json!("plaintext-secret"));
        metadata.insert("password".into(), json!("hunter2"));
        metadata.insert("token".into(), json!("tok"));
        metadata.insert("note".into(), json!("rotated"));

        let entry = record_secret_changelog(RecordSecretChangelog {
            event_type: "secret.value.changed".into(),
            project_id: "project_1".into(),
            actor_id: Some("prn_1".into()),
            config_id: Some("cfg_1".into()),
            environment: Some("production".into()),
            key_names: vec!["DATABASE_URL".into()],
            version_id: Some("ver_1".into()),
            metadata,
            ..Default::default()
        });

        let serialized = serde_json::to_string(&entry).unwrap();
        assert!(!serialized.contains("plaintext-secret"));
        assert!(!serialized.contains("hunter2"));
        assert!(!serialized.contains("\"tok\""));
        assert_eq!(entry.key_names, vec!["DATABASE_URL"]);
        assert_eq!(entry.metadata.get("note"), Some(&json!("rotated")));
    }

    #[test]
    fn list_filters_by_project() {
        clear_secret_changelog_for_tests();
        record_secret_changelog(RecordSecretChangelog {
            event_type: "sync.target.synced".into(),
            project_id: "p_a".into(),
            organization_id: Some("org_a".into()),
            target_id: Some("st_1".into()),
            content_version: Some("cv_1".into()),
            ..Default::default()
        });
        record_secret_changelog(RecordSecretChangelog {
            event_type: "secret.config.created".into(),
            project_id: "p_a".into(),
            organization_id: Some("org_b".into()),
            config_id: Some("cfg".into()),
            key_names: vec!["STRIPE_API_KEY".into()],
            ..Default::default()
        });
        let a = list_secret_changelog("org_a", "p_a", 10);
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].event_type, "sync.target.synced");
        assert_eq!(a[0].target_id.as_deref(), Some("st_1"));
        assert_eq!(a[0].content_version.as_deref(), Some("cv_1"));
        let b = list_secret_changelog("org_b", "p_a", 10);
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].key_names, vec!["STRIPE_API_KEY"]);
        assert!(list_secret_changelog("org_a", "p_a", 10)
            .iter()
            .all(|e| e.organization_id.as_deref() == Some("org_a")));
    }

    #[test]
    fn allowlist_matches_frozen_event_types() {
        assert!(is_allowed_changelog_event_type("secret.value.changed"));
        assert!(!is_allowed_changelog_event_type("secret.value.exfiltrated"));
    }
}
