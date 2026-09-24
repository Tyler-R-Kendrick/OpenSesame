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
//! is refused so two operators cannot overwrite each other blind. The
//! revision compared is the *stored* one and the write is conditional on
//! the document read, so gateway processes sharing one store cannot
//! overwrite each other either; each re-reads the store every
//! [`REFRESH_INTERVAL`] (and on every `PUT`/`GET` of the set) so a
//! replacement another process made — a revocation's `denied_thumbprints`
//! above all — reaches its admission within that bound.

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
    StaleRevision {
        current: u32,
    },
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

/// Serializes replacements within one process. Across processes sharing
/// the store, the conditional write in [`put_cas`] is what serializes.
static PUT_SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// How often a running gateway re-reads the stored set ([`run_refresh`]).
/// With several gateway processes sharing one store this bounds how long a
/// replica keeps admitting on a set another replica has replaced — a
/// revocation's `denied_thumbprints` above all: at most this long, plus the
/// time to its next `PUT` or `GET` of the set, which refresh immediately.
pub const REFRESH_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15);

/// Compare-and-set replacement. `proposed.revision` must equal the revision
/// **stored** now — not this process's in-memory copy, which another
/// gateway sharing the store may have superseded — and the stored set
/// carries `current + 1`. The write itself is conditional on the exact
/// document that was read, so two processes holding the same read cannot
/// both land. When `live` is given it adopts a newer stored set as soon as
/// one is seen, and the new set under its write lock after the store
/// succeeds, so admission sees it atomically.
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
    let raw = db
        .get_host_kv(KV_SERVICE_BINDINGS)
        .await
        .map_err(|e| PutError::Storage(e.to_string()))?;
    let stored = match raw.as_deref() {
        Some(raw) => parse_bounded(raw).map_err(PutError::Invalid)?,
        None => ServiceBindingSet::empty(),
    };
    if let Some(lock) = live {
        adopt_if_newer(lock, &stored);
    }
    let current = stored.revision;
    if proposed.revision != current {
        return Err(PutError::StaleRevision { current });
    }
    proposed.revision =
        current
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
    let written = db
        .compare_and_set_host_kv(KV_SERVICE_BINDINGS, raw.as_deref(), &json)
        .await
        .map_err(|e| PutError::Storage(e.to_string()))?;
    if !written {
        // Another process wrote between the read and the write.
        let now = load(db, None).await.map_err(PutError::Invalid)?.set;
        if let Some(lock) = live {
            adopt_if_newer(lock, &now);
        }
        return Err(PutError::StaleRevision {
            current: now.revision,
        });
    }
    if let Some(lock) = live {
        *lock
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = proposed.clone();
    }
    Ok(proposed)
}

/// Replace `live` with `stored` when the store is ahead. Never moves the
/// live set backwards. Returns whether it changed.
fn adopt_if_newer(live: &RwLock<ServiceBindingSet>, stored: &ServiceBindingSet) -> bool {
    let mut guard = live
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if stored.revision > guard.revision {
        *guard = stored.clone();
        true
    } else {
        false
    }
}

/// Re-read the stored set and adopt it when it is newer than `live`. A set
/// pinned by the env file is the deployment plane's and is not re-read.
///
/// # Errors
///
/// The store's or the stored document's error; `live` is then untouched.
pub async fn refresh(
    db: &Db,
    source: BindingsSource,
    live: &RwLock<ServiceBindingSet>,
) -> Result<bool, TransportError> {
    if source == BindingsSource::Env {
        return Ok(false);
    }
    let loaded = load(db, None).await?;
    Ok(adopt_if_newer(live, &loaded.set))
}

/// Keep this process's live set within [`REFRESH_INTERVAL`] of the store.
/// A no-op loop exit when no transport runtime is configured.
pub async fn run_refresh(state: crate::app_state::AppState) {
    let Some(runtime) = state.transport.clone() else {
        return;
    };
    if runtime.bindings_source == BindingsSource::Env {
        return;
    }
    let mut ticks = tokio::time::interval(REFRESH_INTERVAL);
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticks.tick().await;
        match refresh(&state.db, runtime.bindings_source, &runtime.bindings).await {
            Ok(true) => tracing::info!("service bindings refreshed from the store"),
            Ok(false) => {}
            Err(error) => tracing::warn!(
                code = error.code(),
                "service bindings could not be refreshed; keeping the live set"
            ),
        }
    }
}

/// True when any binding in the set denies this leaf: the listener's
/// handshake-time and per-request denylist hook (AT-TLS-REVOKEDLIVE).
#[must_use]
pub fn denies_thumbprint(set: &ServiceBindingSet, thumbprint: &str) -> bool {
    set.bindings
        .iter()
        .any(|b| b.denied_thumbprints.iter().any(|d| d == thumbprint))
}
