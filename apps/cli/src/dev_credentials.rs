//! A connection's credential for `opensesame dev run --agent`: the token the
//! `surrogate-proxy` plugin redeems for the surrogate its child holds, read
//! from the person's sealed store at run start (ADR 0150 §6.1, §9).
//!
//! This is `op run`'s shape. The schema holds a reference and nothing else:
//!
//! ```text
//! VERCEL_TOKEN=opensesameConnection(conn://acme/vercel, projection=legacy-token,
//!                                   paths="/v2/user", methods="GET")
//! ```
//!
//! and the token it names is the sealed entry `connections/acme/vercel`
//! (`opensesame pass insert connections/acme/vercel`). The entry's name is
//! derived from the reference, never written in the schema, so a working tree
//! an agent can edit cannot aim a run at some other entry of the store, and
//! only entries under `connections/` are ever read this way. Where the token
//! may go is not the store's or the schema's to say either: the plugin sends
//! it only to the host its provider's egress rule names, at the scope the
//! entry declared.
//!
//! Only a provider the plugin brokers with a connection's own credential is
//! read from the store (vercel today), and only once the plugin is on and will
//! take it. One it draws a credential for from a local tool (it has `gh auth
//! token` for github) is never read, and neither is one it has no egress rule
//! for: a token stored for that would be sent to the plugin for nothing, and a
//! hint to store one would promise what storing cannot do. Which providers the
//! plugin brokers this way is the plugin catalog's to say
//! (`spec/plugins/catalog.json`, read through `opensesame-plugin-settings`),
//! because this binary links no plugin. The token leaves this process inside
//! the plugin's run spec, over its stdin pipe: never argv, never a file, never
//! the child's environment, never a log line. A store that holds no entry for
//! a connection asks for no password at all, and the entry keeps its
//! placeholder.

use opensesame_invoke_through::source_tool;
use opensesame_plugin_settings::takes_stored_credential;
use serde::Serialize;
use serde_json::Value;
use zeroize::Zeroizing;

use crate::dev_run::login::LoginSource;
use crate::dev_surrogate::PLUGIN_ID;

/// The sealed-store folder connection credentials live in.
pub(crate) const FOLDER: &str = "connections";

/// One connection's token as it travels to the plugin. `Debug` names the
/// connection, never the secret.
#[derive(Serialize)]
pub(crate) struct CredentialWire {
    pub(crate) connection_ref: String,
    #[serde(serialize_with = "expose")]
    secret: Zeroizing<String>,
}

impl CredentialWire {
    pub(crate) fn new(connection_ref: String, secret: Zeroizing<String>) -> Self {
        Self {
            connection_ref,
            secret,
        }
    }
}

impl std::fmt::Debug for CredentialWire {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CredentialWire")
            .field("connection_ref", &self.connection_ref)
            .finish_non_exhaustive()
    }
}

fn expose<S: serde::Serializer>(secret: &Zeroizing<String>, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(secret)
}

/// `connections/acme/vercel` for `conn://acme/vercel` and for
/// `conn://acme/vercel@v2`: the sealed entry a connection's token lives in.
/// `None` for anything that is not a plain `conn://<org>[/<project>]/<name>`.
pub(crate) fn store_path_of(connection_ref: &str) -> Option<String> {
    let rest = connection_ref.strip_prefix("conn://")?;
    let mut segments: Vec<&str> = rest.split('/').collect();
    let last = segments.pop()?;
    segments.push(last.split('@').next()?);
    let plain = |segment: &&str| {
        !segment.is_empty()
            && !segment.starts_with('.')
            && segment
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    };
    (segments.len() >= 2 && segments.iter().all(plain))
        .then(|| format!("{FOLDER}/{}", segments.join("/")))
}

/// Where the plugin gets the credential for a connection of one provider.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Credential {
    /// A local tool yields it (`gh auth token`): nothing is read from the store.
    LocalTool,
    /// The connection's own, sealed under `connections/`.
    Stored,
    /// The plugin has no egress rule for the provider. Nothing can serve it, so
    /// nothing is read and nothing is stored for it.
    Unserved,
}

/// Whether this process must read the connection's token from the sealed
/// store for the plugin to redeem (as opposed to the plugin drawing one
/// from a local tool, or brokering the provider not at all).
pub(crate) fn needs_stored_credential(provider_id: &str) -> bool {
    credential_of(provider_id) == Credential::Stored
}

/// Whether the plugin has any credential to place for `provider_id` — a
/// local tool's, or the connection's own from the store. The plugin still
/// refuses a provider it has no egress rule for; this only says the run is
/// worth starting.
pub(crate) fn has_credential_source(provider_id: &str) -> bool {
    credential_of(provider_id) != Credential::Unserved
}

fn credential_of(provider_id: &str) -> Credential {
    if source_tool(provider_id).is_some() {
        Credential::LocalTool
    } else if takes_stored_credential(PLUGIN_ID, provider_id) {
        Credential::Stored
    } else {
        Credential::Unserved
    }
}

/// `(env_var, connection_ref, store_path)` for each requested entry whose
/// token the store is the place for, once per connection.
fn stored_entries(requested: &[Value]) -> Vec<(&str, &str, String)> {
    let mut seen = std::collections::BTreeSet::new();
    requested
        .iter()
        .filter_map(|entry| {
            let env_var = entry["env_var"].as_str()?;
            let connection_ref = entry["connection_ref"].as_str()?;
            let provider_id = entry["provider_id"].as_str()?;
            (credential_of(provider_id) == Credential::Stored).then_some(())?;
            let path = store_path_of(connection_ref)?;
            seen.insert(connection_ref)
                .then_some((env_var, connection_ref, path))
        })
        .collect()
}

/// The token each requested connection holds in `source`, for the connections
/// that hold one. A connection with no entry is skipped: it keeps its
/// placeholder, and nothing is read or unlocked for it.
///
/// # Errors
///
/// When an entry exists and cannot be read (the store is locked with another
/// passphrase, or the entry is empty). The message names the entry, never a
/// value.
pub(crate) fn resolve(
    requested: &[Value],
    source: &dyn LoginSource,
) -> anyhow::Result<Vec<CredentialWire>> {
    stored_entries(requested)
        .into_iter()
        .filter(|(_, _, path)| source.holds(path))
        .map(|(env_var, connection_ref, path)| {
            // The entry leads and the variable trails in parentheses: a message
            // that begins `VERCEL_TOKEN: …` has the shape of a log line whose
            // key is a credential, and the scrubber (ADR 0157) would replace
            // everything after the colon, the entry's name with it.
            let stored = source.read(&path).map_err(|error| {
                anyhow::anyhow!("the sealed entry {path} (for {env_var}) cannot be read: {error}")
            })?;
            if stored.secret.trim().is_empty() {
                anyhow::bail!("the sealed entry {path} (for {env_var}) is empty");
            }
            Ok(CredentialWire {
                connection_ref: connection_ref.to_owned(),
                secret: stored.secret,
            })
        })
        .collect()
}

/// `(env_var, provider_id)` for each requested entry the plugin has no rule
/// for. It keeps its placeholder whatever the store holds.
fn unserved_entries(requested: &[Value]) -> impl Iterator<Item = (&str, &str)> {
    requested.iter().filter_map(|entry| {
        let env_var = entry["env_var"].as_str()?;
        let provider_id = entry["provider_id"].as_str()?;
        (credential_of(provider_id) == Credential::Unserved).then_some((env_var, provider_id))
    })
}

/// One line for each requested connection that needs a stored token and has
/// none, saying where to put it, and one for each that nothing can serve,
/// saying so. Reads nothing.
///
/// Each line leads with the variable and puts no colon after it: a message
/// that begins `VERCEL_TOKEN: …` has the shape the log scrubber (ADR 0157)
/// replaces.
pub(crate) fn missing(requested: &[Value], source: &dyn LoginSource) -> Vec<String> {
    let stored = stored_entries(requested)
        .into_iter()
        .filter(|(_, _, path)| !source.holds(path))
        .map(|(env_var, _, path)| {
            format!(
                "{env_var} has no token to redeem: store one with \
                 'opensesame pass insert {path}' (this provider draws none from a local tool)"
            )
        });
    let unserved = unserved_entries(requested).map(|(env_var, provider_id)| {
        format!(
            "{env_var} will keep its placeholder: the surrogate-proxy plugin brokers no \
             '{provider_id}' connection, so a stored token would not be used"
        )
    });
    stored.chain(unserved).collect()
}

#[cfg(test)]
#[path = "dev_credentials_tests.rs"]
mod tests;
