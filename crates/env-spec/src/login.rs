//! `opensesameLogin(<sealed-store path>, origin=…, action=…, field=…[, ca=…])`
//! — a web login an agent signs in to with a surrogate (ADR 0150 §6.3).
//!
//! The entry names where the password lives and the one form submission it
//! may go into; it never carries the password. Nothing here delivers a
//! value: the entry resolves **omitted**, and only an `opensesame dev run
//! --agent` with the `surrogate-proxy` plugin on gives the child anything —
//! an `osr_…` surrogate the plugin redeems in the declared field alone. With
//! the plugin off the child gets nothing, never the password.

use serde::{Deserialize, Serialize};

use crate::{arg_string, EnvResolver, EnvSpecItem, ResolvedEnvEntry};
use opensesame_domain::CredentialDeliveryMode;

/// The resolver name.
pub const LOGIN_RESOLVER: &str = "opensesameLogin";

/// A declared web login. Names a sealed-store path and a form, never a value.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WebLogin {
    /// The sealed-store entry whose first line is the password.
    pub store_path: String,
    /// `https://host[:port]`, exact.
    pub origin: String,
    /// The form's action path, exact.
    pub action: String,
    /// The one form field (or top-level JSON key) the password goes into.
    pub field: String,
    /// A private origin's trust anchor (PEM file), replacing webpki for it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ca_file: Option<String>,
}

fn keyed(resolver: &EnvResolver, key: &str) -> Option<String> {
    resolver
        .args
        .iter()
        .find(|arg| arg.key.as_deref() == Some(key))
        .and_then(arg_string)
        .filter(|value| !value.is_empty())
}

/// The declaration, or `None` when a required part is missing.
#[must_use]
pub fn web_login(resolver: &EnvResolver) -> Option<WebLogin> {
    let store_path = resolver
        .args
        .iter()
        .find(|arg| arg.key.is_none())
        .and_then(arg_string)
        .filter(|value| !value.is_empty())?;
    Some(WebLogin {
        store_path,
        origin: keyed(resolver, "origin")?,
        action: keyed(resolver, "action")?,
        field: keyed(resolver, "field")?,
        ca_file: keyed(resolver, "ca"),
    })
}

/// The entry for an `opensesameLogin(…)` item: omitted, with the declaration
/// beside it, or omitted with a warning when the declaration is incomplete.
pub(crate) fn resolve_login(item: &EnvSpecItem, resolver: &EnvResolver) -> ResolvedEnvEntry {
    let login = web_login(resolver);
    let warning = if login.is_some() {
        "web login: delivered only as a surrogate by the surrogate-proxy plugin in an --agent run"
    } else {
        "opensesameLogin needs a store path, origin=, action= and field="
    };
    ResolvedEnvEntry {
        key: item.key.clone(),
        delivery: CredentialDeliveryMode::Placeholder,
        env_value: None,
        connection_ref: None,
        projection: None,
        omitted: true,
        warning: Some(warning.into()),
        login,
    }
}
