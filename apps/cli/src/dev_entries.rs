//! Which env-spec entries a surrogate can stand in for (ADR 0150 §6.1): the
//! legacy-token projections placed in one header, as run-spec entries for
//! the surrogate-proxy plugin.

use opensesame_domain::{CredentialDeliveryMode, PlaceholderLocation};
use opensesame_env_spec::ResolvedEnvEntry;
use serde_json::{json, Value};

/// The run-spec entries for the placeholder deliveries a surrogate can
/// replace: a legacy-token projection placed in one header.
pub(crate) fn run_entries(entries: &[ResolvedEnvEntry]) -> Vec<Value> {
    entries
        .iter()
        .filter(|entry| entry.delivery == CredentialDeliveryMode::Placeholder && !entry.omitted)
        .filter_map(|entry| {
            let projection = entry.projection.as_ref()?;
            let connection_ref = entry.connection_ref.as_deref()?;
            let site = match projection.placement.locations.as_slice() {
                [PlaceholderLocation::Header { name }] => site_for(name.as_deref()),
                _ => return None,
            };
            Some(json!({
                "env_var": entry.key,
                "provider_id": provider_of(connection_ref)?,
                "connection_ref": connection_ref,
                "site": site,
                "methods": projection.placement.methods,
                "path_prefixes": ["/"],
            }))
        })
        .collect()
}

fn site_for(header: Option<&str>) -> String {
    match header {
        None => "authorization".to_owned(),
        Some(name) if name.eq_ignore_ascii_case("authorization") => "authorization".to_owned(),
        Some(name) => format!("header:{}", name.to_ascii_lowercase()),
    }
}

/// `github` from `conn://org[/project]/github[@vN]`: a connection's logical
/// name is its provider for the connections a surrogate can serve.
pub(crate) fn provider_of(connection_ref: &str) -> Option<String> {
    let rest = connection_ref.strip_prefix("conn://")?;
    let name = rest.rsplit('/').next()?;
    let name = name.split('@').next()?;
    (!name.is_empty() && rest.contains('/')).then(|| name.to_owned())
}
