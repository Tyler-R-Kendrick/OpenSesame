//! Consumer of `@env-spec/parser` JSON emitted by `packages/env-spec-bridge`.
//! Does not reimplement the DSL.

use opensesame_domain::{
    CredentialDeliveryMode, DevDeliveryPolicy, DomainError, LegacyProjection, PlaceholderLocation,
    PlaceholderPlacement,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

mod login;
mod node_bridge;
mod scope;
pub use login::{web_login, WebLogin, LOGIN_RESOLVER};
pub use node_bridge::node_command;
pub use scope::{is_bounded_prefix, is_http_method};

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
    /// A `paths=` or `methods=` declaration that does not bound a surrogate.
    #[error("{0}")]
    Scope(String),
    /// No `node` the bridge may be started with (see [`node_command`]).
    #[error("{0}")]
    Node(String),
    /// `OPENSESAME_NODE` is set to something that cannot be run. Names the
    /// variable; the `PATH` search is not tried instead.
    #[error("{0}")]
    NodeOverride(String),
    /// An `opensesame-env-parse.mjs` beside the running executable that may not
    /// be run: says which file or directory and why. The checkout's copy is
    /// not tried instead. Also: no bridge to run at all (none beside the
    /// executable, no override, no checkout copy), saying where it looked.
    #[error("{0}")]
    BridgeScript(String),
}

/// Invoke the Node `@env-spec/parser` bridge.
///
/// The script is `OPENSESAME_ENV_PARSE` when set, else an
/// `opensesame-env-parse.mjs` beside the running executable (after symlinks)
/// that only root or the caller could have put there, else the checkout's
/// `packages/env-spec-bridge/bin/opensesame-env-parse.mjs`.
///
/// The bridge runs under [`node_command`]: a `node` found only in trusted
/// `PATH` entries, started by its absolute path with a minimal environment. It
/// reads our configuration, so it gets neither the secrets this process holds
/// nor code that an inherited `NODE_OPTIONS`, `NODE_PATH` or a `node` planted
/// in the working directory would put inside it.
///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails, when
/// no trusted `node` exists, when the bridge beside the executable may not
/// be run, or when there is no bridge to run.
pub fn parse_schema_file(path: &Path) -> Result<EnvSpecDocument, EnvSpecError> {
    let bin = node_bridge::script()?;
    let out = node_command()?.arg(&bin).arg(path).output()?;
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

pub(crate) fn arg_string(a: &EnvResolverArg) -> Option<String> {
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
    /// A web login a surrogate stands in for (ADR 0150 §6.3). Always
    /// `omitted`: only the surrogate-proxy plugin delivers anything for it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub login: Option<WebLogin>,
    /// The path prefixes the entry declared with `paths=` (ADR 0150 section
    /// 8): the most a surrogate for it may reach. Empty when none were
    /// declared, never defaulted to the root; the plugin issues nothing for a
    /// served entry that has none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub path_prefixes: Vec<String>,
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
            login: None,
            path_prefixes: Vec::new(),
        });
    }

    policy.assert_allows(CredentialDeliveryMode::Placeholder)?;
    let declared = scope::declared(&item.key, resolver)?;
    let pattern = starts_with_from_type(item.r#type.as_ref()).unwrap_or_else(|| "ostest_*".into());
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
    if let Some(methods) = declared.methods {
        projection.placement.methods = methods;
    }
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
        login: None,
        path_prefixes: declared.path_prefixes,
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
            login: None,
            path_prefixes: Vec::new(),
        }));
    }
    if let Some(resolver) = &item.resolver {
        if resolver.fn_name == LOGIN_RESOLVER {
            policy.assert_allows(CredentialDeliveryMode::Placeholder)?;
            return Ok(Some(login::resolve_login(item, resolver)));
        }
        let Some(uri) = connection_uri_from_resolver(resolver) else {
            return Ok(Some(ResolvedEnvEntry {
                key: item.key.clone(),
                delivery: CredentialDeliveryMode::Handle,
                env_value: None,
                connection_ref: None,
                projection: None,
                omitted: true,
                warning: Some(format!("unresolved resolver {}", resolver.fn_name)),
                login: None,
                path_prefixes: Vec::new(),
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
        login: None,
        path_prefixes: Vec::new(),
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
mod tests;
