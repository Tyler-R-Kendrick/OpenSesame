//! Consumer of `@env-spec/parser` JSON emitted by `packages/env-spec-bridge`.
//! Does not reimplement the DSL.

use opensesame_domain::{
    CredentialDeliveryMode, DevDeliveryPolicy, DomainError, LegacyProjection, PlaceholderLocation,
    PlaceholderPlacement,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EnvSpecDocument {
    pub schema_path: String,
    pub parser: String,
    pub items: Vec<EnvSpecItem>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EnvSpecItem {
    pub key: String,
    pub sensitive: bool,
    pub required: bool,
    #[serde(default)]
    pub public: bool,
    #[serde(default)]
    pub r#type: Option<Value>,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub resolver: Option<EnvResolver>,
    #[serde(default)]
    pub decorators: Vec<EnvDecorator>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EnvDecorator {
    pub name: String,
    #[serde(default)]
    pub value: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EnvResolver {
    #[serde(rename = "fn")]
    pub fn_name: String,
    #[serde(default)]
    pub args: Vec<EnvResolverArg>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EnvResolverArg {
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub value: Option<Value>,
}

#[derive(Debug, thiserror::Error)]
pub enum EnvSpecError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("bridge failed: {0}")]
    Bridge(String),
    #[error(transparent)]
    Domain(#[from] DomainError),
}

fn bridge_bin() -> PathBuf {
    if let Ok(p) = std::env::var("OPENSESAME_ENV_PARSE") {
        return PathBuf::from(p);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/env-spec-bridge/bin/opensesame-env-parse.mjs")
}

/// Invoke the Node `@env-spec/parser` bridge.
///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn parse_schema_file(path: &Path) -> Result<EnvSpecDocument, EnvSpecError> {
    let bin = bridge_bin();
    // Run the bridge on a bare Node. An inherited `NODE_OPTIONS` decides what
    // loads into this process before the script does, so it can fail the parse
    // for reasons that have nothing to do with the schema (`--import tsx`
    // does exactly that) and, with `--require`, can put someone else's code
    // inside the thing that reads our configuration. Neither belongs here.
    let out = Command::new("node")
        .env_remove("NODE_OPTIONS")
        .arg(&bin)
        .arg(path)
        .output()?;
    if !out.status.success() {
        return Err(EnvSpecError::Bridge(
            String::from_utf8_lossy(&out.stderr).into(),
        ));
    }
    Ok(serde_json::from_slice(&out.stdout)?)
}

///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn parse_schema_json(json: &str) -> Result<EnvSpecDocument, EnvSpecError> {
    Ok(serde_json::from_str(json)?)
}

/// Schema-only view safe for agents/logs (no secret values).
#[must_use]
pub fn schema_summary(doc: &EnvSpecDocument) -> serde_json::Value {
    let items: Vec<_> = doc
        .items
        .iter()
        .map(|i| {
            serde_json::json!({
                "key": i.key,
                "sensitive": i.sensitive,
                "required": i.required,
                "public": i.public,
                "has_resolver": i.resolver.is_some(),
                "resolver_fn": i.resolver.as_ref().map(|r| r.fn_name.clone()),
                "value_present": i.value.is_some(),
            })
        })
        .collect();
    serde_json::json!({
        "schema_path": doc.schema_path,
        "items": items,
        "public_count": doc.items.iter().filter(|i| i.public || !i.sensitive).count(),
        "sensitive_count": doc.items.iter().filter(|i| i.sensitive).count(),
    })
}

fn starts_with_from_type(t: Option<&Value>) -> Option<String> {
    let o = t?.as_object()?;
    if o.get("fn").and_then(|v| v.as_str()) != Some("string") {
        return None;
    }
    let args = o.get("args")?.as_array()?;
    for a in args {
        if a.get("key").and_then(|k| k.as_str()) == Some("startsWith") {
            return a
                .get("value")
                .and_then(|v| v.as_str())
                .map(|s| format!("{s}*"));
        }
    }
    None
}

fn arg_string(a: &EnvResolverArg) -> Option<String> {
    match &a.value {
        Some(Value::String(s)) => Some(s.clone()),
        Some(v) => Some(v.to_string().trim_matches('"').to_string()),
        None => None,
    }
}

fn connection_uri_from_resolver(r: &EnvResolver) -> Option<String> {
    if r.fn_name != "opensesame" && r.fn_name != "opensesameConnection" {
        return None;
    }
    for a in &r.args {
        if let Some(s) = arg_string(a) {
            if s.starts_with("conn://") {
                return Some(s);
            }
        }
    }
    None
}

fn projection_name(r: &EnvResolver) -> Option<String> {
    for a in &r.args {
        if a.key.as_deref() == Some("projection") {
            return arg_string(a);
        }
    }
    None
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ResolvedEnvEntry {
    pub key: String,
    pub delivery: CredentialDeliveryMode,
    pub env_value: Option<String>,
    pub connection_ref: Option<String>,
    pub projection: Option<LegacyProjection>,
    pub omitted: bool,
    pub warning: Option<String>,
}

/// Unguessable, per-projection placeholder suffix.
fn placeholder_suffix() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn resolve_connection_entry(
    item: &EnvSpecItem,
    resolver: &EnvResolver,
    uri: String,
    policy: &DevDeliveryPolicy,
) -> Result<ResolvedEnvEntry, EnvSpecError> {
    let wants_legacy = projection_name(resolver).as_deref() == Some("legacy-token")
        || resolver.fn_name == "opensesameConnection";
    if !wants_legacy {
        policy.assert_allows(CredentialDeliveryMode::Handle)?;
        return Ok(ResolvedEnvEntry {
            key: item.key.clone(),
            delivery: CredentialDeliveryMode::Handle,
            env_value: Some(uri.clone()),
            connection_ref: Some(uri),
            projection: None,
            omitted: false,
            warning: None,
        });
    }

    policy.assert_allows(CredentialDeliveryMode::Placeholder)?;
    let pattern = starts_with_from_type(item.r#type.as_ref()).unwrap_or_else(|| "sk_test_*".into());
    let mut projection = LegacyProjection {
        env_var: item.key.clone(),
        connection_ref_uri: uri.clone(),
        placeholder_pattern: pattern,
        issued_placeholder: None,
        placement: PlaceholderPlacement {
            locations: vec![PlaceholderLocation::Header {
                name: Some("Authorization".into()),
            }],
            methods: vec!["GET".into(), "POST".into(), "PUT".into(), "PATCH".into()],
            max_occurrences: 1,
        },
        delivery: CredentialDeliveryMode::Placeholder,
    };
    // A fresh suffix binds substitution to this projection instead of a
    // shared or guessable placeholder with the same shape.
    let placeholder = projection.shaped_placeholder(&placeholder_suffix());
    projection.issued_placeholder = Some(placeholder.clone());
    Ok(ResolvedEnvEntry {
        key: item.key.clone(),
        delivery: CredentialDeliveryMode::Placeholder,
        env_value: Some(placeholder),
        connection_ref: Some(uri),
        projection: Some(projection),
        omitted: false,
        warning: None,
    })
}

fn resolve_item(
    item: &EnvSpecItem,
    policy: &DevDeliveryPolicy,
    agent: bool,
) -> Result<Option<ResolvedEnvEntry>, EnvSpecError> {
    if !item.sensitive && item.resolver.is_none() {
        return Ok(Some(ResolvedEnvEntry {
            key: item.key.clone(),
            delivery: CredentialDeliveryMode::Native,
            env_value: item.value.clone(),
            connection_ref: None,
            projection: None,
            omitted: false,
            warning: None,
        }));
    }
    if let Some(resolver) = &item.resolver {
        let Some(uri) = connection_uri_from_resolver(resolver) else {
            return Ok(Some(ResolvedEnvEntry {
                key: item.key.clone(),
                delivery: CredentialDeliveryMode::Handle,
                env_value: None,
                connection_ref: None,
                projection: None,
                omitted: true,
                warning: Some(format!("unresolved resolver {}", resolver.fn_name)),
            }));
        };
        return resolve_connection_entry(item, resolver, uri, policy).map(Some);
    }
    if !item.sensitive {
        return Ok(None);
    }
    let denied = agent || !policy.allows(CredentialDeliveryMode::Materialize);
    if !denied {
        policy.assert_allows(CredentialDeliveryMode::Materialize)?;
    }
    Ok(Some(ResolvedEnvEntry {
        key: item.key.clone(),
        delivery: CredentialDeliveryMode::Materialize,
        env_value: (!denied).then(|| item.value.clone()).flatten(),
        connection_ref: None,
        projection: None,
        omitted: denied,
        warning: Some(if denied {
            "sensitive value omitted (materialize denied)".into()
        } else {
            "materialize allowed — legacy warning".into()
        }),
    }))
}

/// Apply delivery policy to schema items — never materializes secrets without policy allow.
///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn resolve_for_delivery(
    doc: &EnvSpecDocument,
    policy: &DevDeliveryPolicy,
    agent: bool,
) -> Result<Vec<ResolvedEnvEntry>, EnvSpecError> {
    let mut out = Vec::new();
    for item in &doc.items {
        if let Some(resolved) = resolve_item(item, policy, agent)? {
            out.push(resolved);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const FIXTURE: &str = r#"{
  "schema_path": "fixtures/demo.env.schema",
  "parser": "@env-spec/parser",
  "items": [
    {
      "key": "API_URL",
      "sensitive": false,
      "required": false,
      "public": true,
      "type": {"fn": "url"},
      "value": "http://localhost:3000",
      "resolver": null,
      "decorators": [{"name": "public", "value": true}]
    },
    {
      "key": "STRIPE_SECRET_KEY",
      "sensitive": true,
      "required": true,
      "public": false,
      "type": {"fn": "string", "args": [{"key": "startsWith", "value": "sk_"}]},
      "value": null,
      "resolver": {
        "fn": "opensesameConnection",
        "args": [
          {"value": "conn://demo/stripe"},
          {"key": "projection", "value": "legacy-token"}
        ]
      },
      "decorators": [{"name": "sensitive", "value": true}]
    },
    {
      "key": "GITHUB_TOKEN",
      "sensitive": true,
      "required": true,
      "public": false,
      "type": null,
      "value": null,
      "resolver": {
        "fn": "opensesame",
        "args": [{"value": "conn://demo/github"}]
      },
      "decorators": [{"name": "sensitive", "value": true}]
    }
  ]
}"#;

    #[test]
    fn summary_hides_secrets() {
        let doc = parse_schema_json(FIXTURE).unwrap();
        let s = schema_summary(&doc);
        let text = s.to_string();
        assert!(text.contains("STRIPE_SECRET_KEY"));
        assert!(!text.contains("sk_live"));
    }

    #[test]
    fn agent_resolve_placeholders_and_handles() {
        let doc = parse_schema_json(FIXTURE).unwrap();
        let policy = DevDeliveryPolicy::agent_default();
        let entries = resolve_for_delivery(&doc, &policy, true).unwrap();
        let stripe = entries
            .iter()
            .find(|e| e.key == "STRIPE_SECRET_KEY")
            .unwrap();
        assert_eq!(stripe.delivery, CredentialDeliveryMode::Placeholder);
        assert!(stripe.env_value.as_ref().unwrap().starts_with("sk_"));
        let gh = entries.iter().find(|e| e.key == "GITHUB_TOKEN").unwrap();
        assert_eq!(gh.delivery, CredentialDeliveryMode::Handle);
        assert_eq!(gh.env_value.as_deref(), Some("conn://demo/github"));
    }

    #[test]
    fn each_projection_gets_its_own_placeholder() {
        let doc = parse_schema_json(FIXTURE).unwrap();
        let policy = DevDeliveryPolicy::agent_default();
        let first = resolve_for_delivery(&doc, &policy, true).unwrap();
        let second = resolve_for_delivery(&doc, &policy, true).unwrap();
        let pick = |entries: &[ResolvedEnvEntry]| {
            entries
                .iter()
                .find(|e| e.key == "STRIPE_SECRET_KEY")
                .cloned()
                .unwrap()
        };
        let (a, b) = (pick(&first), pick(&second));
        let (pa, pb) = (a.env_value.clone().unwrap(), b.env_value.clone().unwrap());
        // Two projections of the same connection must not share a placeholder:
        // egress substitution keys off the text alone.
        assert_ne!(pa, pb);
        assert!(pa.starts_with("sk_"));
        // And the placeholder handed out is one the projection will accept back.
        assert!(a.projection.as_ref().unwrap().accepts_placeholder(&pa));
        // Each projection admits only its own placeholder, not its neighbour's.
        assert!(!a.projection.as_ref().unwrap().accepts_placeholder(&pb));
        assert!(b.projection.as_ref().unwrap().accepts_placeholder(&pb));
    }

    #[test]
    fn bridge_roundtrip_fixture() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/demo.env.schema");
        assert!(path.exists(), "fixture missing at {}", path.display());
        let node_ok = Command::new("node").arg("--version").output().is_ok();
        if !node_ok {
            eprintln!("skip bridge_roundtrip_fixture: node not installed");
            return;
        }
        let doc = match parse_schema_file(&path) {
            Ok(doc) => doc,
            Err(EnvSpecError::Bridge(msg)) if msg.contains("ERR_MODULE_NOT_FOUND") => {
                eprintln!(
                    "skip bridge_roundtrip_fixture: env-spec-bridge deps not installed ({msg})"
                );
                return;
            }
            Err(e) => panic!("bridge parse failed: {e}"),
        };
        assert!(doc.items.iter().any(|i| i.key == "STRIPE_SECRET_KEY"));
        let stripe = doc
            .items
            .iter()
            .find(|i| i.key == "STRIPE_SECRET_KEY")
            .unwrap();
        assert!(stripe.sensitive);
        assert!(stripe.value.is_none());
        let entries =
            resolve_for_delivery(&doc, &DevDeliveryPolicy::agent_default(), true).unwrap();
        let stripe_e = entries
            .iter()
            .find(|e| e.key == "STRIPE_SECRET_KEY")
            .unwrap();
        assert_eq!(stripe_e.delivery, CredentialDeliveryMode::Placeholder);
        assert!(stripe_e.env_value.as_ref().unwrap().starts_with("sk_"));
    }
}
