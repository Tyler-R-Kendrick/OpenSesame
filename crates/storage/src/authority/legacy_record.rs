//! Reading a legacy grant's stored body without inventing anything.
//!
//! Every field this can rely on is read explicitly, and anything absent is a
//! refusal rather than a default. That is the whole discipline of the backfill:
//! a record that does not say when it expires does not mean "never", and one
//! that does not name a provider does not mean "any".

use super::PermissionEntry;
use chrono::{DateTime, Utc as ChronoUtc};

/// The product ceiling. A legacy record whose action and resource lists multiply
/// out past this is not translated: nobody reviewed that many rights, and writing
/// them out would look like a review that never happened.
const MAX_ENTRIES: usize = 64;

/// The digest recorded for migrated entries. It matches no live provider
/// manifest, which is the point: a migrated right works where the connection
/// broker already enforced it and needs a reviewed replacement anywhere else.
const LEGACY_MANIFEST: &str = "legacy:connection-broker";

/// The parts of a legacy grant a translation may rely on. Anything absent here is
/// a refusal, never a default.
pub(super) struct Legacy {
    actions: Vec<String>,
    resources: Vec<String>,
    connection_id: Option<String>,
    constraints: String,
    has_parent: bool,
    pub(super) not_before: DateTime<ChronoUtc>,
    pub(super) expires_at: DateTime<ChronoUtc>,
}

impl Legacy {
    pub(super) fn read(body: &serde_json::Value) -> Option<Self> {
        let constraints = body.get("constraints")?;
        let expires_at = constraints
            .get("expires_at")
            .and_then(serde_json::Value::as_str)
            .and_then(|at| DateTime::parse_from_rfc3339(at).ok())?
            .with_timezone(&ChronoUtc);
        // A missing `not_before` is not permission to have started earlier than
        // the record exists: the grant's own creation is the floor.
        let not_before = constraints
            .get("not_before")
            .and_then(serde_json::Value::as_str)
            .or_else(|| body.get("created_at").and_then(serde_json::Value::as_str))
            .and_then(|at| DateTime::parse_from_rfc3339(at).ok())?
            .with_timezone(&ChronoUtc);
        Some(Self {
            actions: strings(body.get("actions")),
            resources: strings(body.get("resources")),
            connection_id: body
                .get("connection_id")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned),
            constraints: constraints.to_string(),
            has_parent: body
                .get("parent_grant_id")
                .is_some_and(|parent| !parent.is_null()),
            not_before,
            expires_at,
        })
    }

    /// The reason this record cannot be translated, if there is one.
    pub(super) fn refusal(&self) -> Option<&'static str> {
        if self.actions.is_empty() || self.resources.is_empty() {
            return Some("empty_envelope");
        }
        if self.expires_at <= ChronoUtc::now() {
            return Some("expired");
        }
        if self.not_before >= self.expires_at {
            return Some("empty_interval");
        }
        if self.connection_id.is_none() {
            return Some("no_provider");
        }
        if self.has_parent {
            return Some("parent_unmapped");
        }
        if self.actions.len() * self.resources.len() > MAX_ENTRIES {
            return Some("product_too_large");
        }
        None
    }

    /// The product, written out. Each entry keeps the legacy constraints verbatim,
    /// so a parameter restriction the old engine enforced is carried rather than
    /// summarised.
    pub(super) fn entries(&self) -> Vec<PermissionEntry> {
        let operation = self.connection_id.as_ref().map_or_else(
            || "connection.invoke".to_owned(),
            |connection| format!("connection.invoke:{connection}"),
        );
        let mut entries = Vec::new();
        for resource in &self.resources {
            for action in &self.actions {
                entries.push(PermissionEntry {
                    resource_selector: resource.clone(),
                    provider_operation_id: operation.clone(),
                    action_set_json: serde_json::json!([action]).to_string(),
                    parameter_constraints_json: self.constraints.clone(),
                    audience_set_json: "[]".to_owned(),
                    manifest_digest: LEGACY_MANIFEST.to_owned(),
                });
            }
        }
        entries
    }
}

fn strings(value: Option<&serde_json::Value>) -> Vec<String> {
    value
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}
