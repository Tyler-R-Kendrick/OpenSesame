//! Service bindings: where the Host's `ServiceBindingSet` comes from and how
//! an operator replaces it.
//!
//! Precedence mirrors `taskbus_config`: the deployment plane's
//! `OPENSESAME_SERVICE_BINDINGS_FILE` wins over the stored `host_kv` key
//! [`KV_SERVICE_BINDINGS`], which wins over the default — an *empty* set
//! that binds nobody. A stored value that no longer parses is an error,
//! never a silent default: invalid persisted transport settings cannot fall
//! back to permissive (Cross-swarm rule "Configuration is authority").
//!
//! Replacement is compare-and-set on the set's `revision`: the caller sends
//! the revision it read, the store advances it by one, and a stale revision
//! is refused so two operators cannot overwrite each other blind.

use std::path::Path;
use std::sync::RwLock;

use opensesame_domain::transport::{ServiceBindingSet, TransportError};
use opensesame_storage::Db;
use serde::{Deserialize, Serialize};

/// The `host_kv` key holding the stored set (JSON `ServiceBindingSet`).
pub const KV_SERVICE_BINDINGS: &str = "transport.service_bindings";
/// Largest bindings document accepted from a file, the store, or a `PUT`.
pub const MAX_BINDINGS_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BindingsSource {
    Env,
    Stored,
    Default,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoadedBindings {
    pub set: ServiceBindingSet,
    pub source: BindingsSource,
}

/// Why a `PUT` was refused.
#[derive(Debug, PartialEq, Eq)]
pub enum PutError {
    /// The env file is in force; the store is not consulted.
    EnvOverride,
    /// The caller's `revision` is not the current one.
    StaleRevision { current: u32 },
    Invalid(TransportError),
    Storage(String),
}

/// Parse a bounded JSON document into a validated set.
///
/// # Errors
///
/// `MalformedConfiguration` when the document exceeds
/// [`MAX_BINDINGS_BYTES`] or fails [`ServiceBindingSet::parse_json`].
pub fn parse_bounded(json: &str) -> Result<ServiceBindingSet, TransportError> {
    if json.len() > MAX_BINDINGS_BYTES {
        return Err(TransportError::malformed(format!(
            "service bindings: document exceeds {MAX_BINDINGS_BYTES} bytes"
        )));
    }
    ServiceBindingSet::parse_json(json)
}

/// Read and validate a bindings file. The error never echoes the content.
///
/// # Errors
///
/// `MalformedConfiguration` for an unreadable file or as [`parse_bounded`].
pub fn load_file(path: &Path) -> Result<ServiceBindingSet, TransportError> {
    let metadata = std::fs::metadata(path)
        .map_err(|e| TransportError::malformed(format!("service bindings file: {e}")))?;
    if metadata.len() > MAX_BINDINGS_BYTES as u64 {
        return Err(TransportError::malformed(format!(
            "service bindings file exceeds {MAX_BINDINGS_BYTES} bytes"
        )));
    }
    let text = std::fs::read_to_string(path)
        .map_err(|e| TransportError::malformed(format!("service bindings file: {e}")))?;
    parse_bounded(&text)
}

/// Resolve the effective set: env file > stored > empty default.
///
/// # Errors
///
/// The file's or the stored document's parse error, or
/// `MalformedConfiguration` when the store cannot be read.
pub async fn load(db: &Db, file: Option<&Path>) -> Result<LoadedBindings, TransportError> {
    if let Some(path) = file {
        return Ok(LoadedBindings {
            set: load_file(path)?,
            source: BindingsSource::Env,
        });
    }
    match db
        .get_host_kv(KV_SERVICE_BINDINGS)
        .await
        .map_err(|e| TransportError::malformed(format!("service bindings store: {e}")))?
    {
        Some(stored) => Ok(LoadedBindings {
            set: parse_bounded(&stored)?,
            source: BindingsSource::Stored,
        }),
        None => Ok(LoadedBindings {
            set: ServiceBindingSet::empty(),
            source: BindingsSource::Default,
        }),
    }
}

/// Serializes replacements process-wide even when no runtime holds the set.
static PUT_SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Compare-and-set replacement. `proposed.revision` must equal the current
/// revision; the stored set carries `current + 1`. When `live` is given it
/// is updated under its write lock after the store succeeds, so admission
/// sees the new set atomically.
///
/// # Errors
///
/// [`PutError`].
pub async fn put_cas(
    db: &Db,
    source: BindingsSource,
    live: Option<&RwLock<ServiceBindingSet>>,
    mut proposed: ServiceBindingSet,
) -> Result<ServiceBindingSet, PutError> {
    if source == BindingsSource::Env {
        return Err(PutError::EnvOverride);
    }
    let _serial = PUT_SERIAL.lock().await;
    let current = match live {
        Some(lock) => lock
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .revision,
        None => load(db, None).await.map_err(PutError::Invalid)?.set.revision,
    };
    if proposed.revision != current {
        return Err(PutError::StaleRevision { current });
    }
    proposed.revision = current
        .checked_add(1)
        .ok_or(PutError::Invalid(TransportError::malformed(
            "service bindings: revision overflow",
        )))?;
    proposed.validate().map_err(PutError::Invalid)?;
    let json = serde_json::to_string(&proposed)
        .map_err(|e| PutError::Storage(format!("serialize: {e}")))?;
    if json.len() > MAX_BINDINGS_BYTES {
        return Err(PutError::Invalid(TransportError::malformed(format!(
            "service bindings: document exceeds {MAX_BINDINGS_BYTES} bytes"
        ))));
    }
    db.set_host_kv(KV_SERVICE_BINDINGS, &json)
        .await
        .map_err(|e| PutError::Storage(e.to_string()))?;
    if let Some(lock) = live {
        *lock.write().unwrap_or_else(std::sync::PoisonError::into_inner) = proposed.clone();
    }
    Ok(proposed)
}

/// True when any binding in the set denies this leaf: the listener's
/// handshake-time and per-request denylist hook (AT-TLS-REVOKEDLIVE).
#[must_use]
pub fn denies_thumbprint(set: &ServiceBindingSet, thumbprint: &str) -> bool {
    set.bindings
        .iter()
        .any(|b| b.denied_thumbprints.iter().any(|d| d == thumbprint))
}
