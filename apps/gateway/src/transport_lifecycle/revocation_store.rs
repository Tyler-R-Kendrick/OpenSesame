//! The durable halves of a revocation (LIFE-REVOCATION).
//!
//! **The revoked-leaf denylist.** Every revoked leaf thumbprint is kept in
//! the `host_kv` document [`KV_REVOKED_LEAVES`]. It is read into the
//! process-wide denylist before the gateway serves ([`restore`], from
//! `boot::restore`) and re-read on the refresh cadence ([`refresh`]), so a
//! revocation outlives a restart and reaches every replica sharing the
//! store. The denylist is consulted at the handshake, on every guarded
//! request and by service admission for *every* binding — including one
//! created after the revocation, which carries no `denied_thumbprints` of
//! its own. The set only grows; nothing here un-revokes a leaf.
//!
//! **The stored bindings.** The thumbprint is also appended to every stored
//! binding's `denied_thumbprints` through the bindings store's CAS write.
//! A stale revision (another writer landed in between) is retried against a
//! fresh read up to [`CAS_ATTEMPTS`] times; if it still cannot apply, the
//! revocation reports an error rather than a `200` with a note.
//!
//! Both documents are written with `compare_and_set_host_kv`, so replicas
//! racing on one store cannot drop each other's entries.

use std::collections::BTreeSet;

use opensesame_domain::transport::{
    validate_thumbprint, ServiceBindingSet, TransportError, MAX_LIST_ENTRIES,
};
use serde::{Deserialize, Serialize};

use crate::app_state::AppState;
use crate::transport::bindings::{self, BindingsSource, PutError};

/// The `host_kv` key holding the durable denylist (JSON [`RevokedLeaves`]).
pub const KV_REVOKED_LEAVES: &str = "transport.revoked_leaves";
/// Most revoked leaves one deployment keeps.
pub const MAX_REVOKED: usize = 4_096;
/// Largest denylist document accepted from the store.
pub const MAX_REVOKED_BYTES: usize = 512 * 1024;
/// Conditional-write attempts before a lost race is reported as an error.
pub const CAS_ATTEMPTS: usize = 5;

/// The stored denylist: lowercase hex SHA-256 leaf thumbprints.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct RevokedLeaves {
    pub thumbprints: BTreeSet<String>,
}

/// Why a durable layer could not be applied.
#[derive(Debug, thiserror::Error)]
pub enum DurableError {
    /// Lost the conditional write [`CAS_ATTEMPTS`] times in a row.
    #[error("{0}: lost the conditional write {CAS_ATTEMPTS} times; retry")]
    Contended(&'static str),
    #[error("revoked-leaf denylist is full ({MAX_REVOKED} entries)")]
    Full,
    #[error("{0}")]
    Invalid(TransportError),
    #[error("store: {0}")]
    Storage(String),
}

impl DurableError {
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Contended(_) => "stale_revision",
            Self::Full => "denylist_full",
            Self::Invalid(inner) => inner.code(),
            Self::Storage(_) => "storage_error",
        }
    }

    #[must_use]
    pub const fn http_status(&self) -> u16 {
        match self {
            Self::Contended(_) | Self::Full => 409,
            Self::Invalid(_) | Self::Storage(_) => 500,
        }
    }
}

/// Read the stored denylist and the exact document it came from.
///
/// # Errors
///
/// `MalformedConfiguration` when the store is unreadable, the document is
/// oversized or does not parse, or an entry is not a thumbprint — a corrupt
/// denylist is reported, never read as empty.
pub async fn load(state: &AppState) -> Result<(Option<String>, RevokedLeaves), TransportError> {
    let Some(raw) = state
        .db
        .get_host_kv(KV_REVOKED_LEAVES)
        .await
        .map_err(|e| TransportError::malformed(format!("revoked leaves store: {e}")))?
    else {
        return Ok((None, RevokedLeaves::default()));
    };
    if raw.len() > MAX_REVOKED_BYTES {
        return Err(TransportError::malformed(
            "revoked leaves: stored document exceeds the size bound",
        ));
    }
    let leaves: RevokedLeaves = serde_json::from_str(&raw)
        .map_err(|e| TransportError::malformed(format!("revoked leaves store: {e}")))?;
    for thumbprint in &leaves.thumbprints {
        validate_thumbprint("revoked_leaves", thumbprint)?;
    }
    Ok((Some(raw), leaves))
}

/// Add `thumbprint` (already validated, lowercase) to the stored denylist.
///
/// # Errors
///
/// [`DurableError`].
pub async fn persist(state: &AppState, thumbprint: &str) -> Result<(), DurableError> {
    for _ in 0..CAS_ATTEMPTS {
        let (raw, mut leaves) = load(state).await.map_err(DurableError::Invalid)?;
        if !leaves.thumbprints.insert(thumbprint.to_owned()) {
            return Ok(());
        }
        if leaves.thumbprints.len() > MAX_REVOKED {
            return Err(DurableError::Full);
        }
        let json =
            serde_json::to_string(&leaves).map_err(|e| DurableError::Storage(e.to_string()))?;
        let written = state
            .db
            .compare_and_set_host_kv(KV_REVOKED_LEAVES, raw.as_deref(), &json)
            .await
            .map_err(|e| DurableError::Storage(e.to_string()))?;
        if written {
            return Ok(());
        }
    }
    Err(DurableError::Contended("revoked leaves"))
}

/// Deny every stored thumbprint this process does not deny yet. Returns how
/// many were added.
///
/// # Errors
///
/// As [`load`]; the in-memory denylist is then untouched.
pub async fn refresh(state: &AppState) -> Result<usize, TransportError> {
    let (_, leaves) = load(state).await?;
    let lifecycle = &state.transport_lifecycle;
    let mut added = 0;
    for thumbprint in &leaves.thumbprints {
        if !lifecycle.is_denied(thumbprint) {
            lifecycle.deny(thumbprint);
            added += 1;
        }
    }
    Ok(added)
}

/// [`refresh`] at boot, before anything is served.
///
/// # Errors
///
/// As [`load`]: a denylist that cannot be read keeps the gateway from
/// starting, rather than serving with revoked leaves readmitted.
pub async fn restore(state: &AppState) -> Result<usize, TransportError> {
    refresh(state).await
}

/// Append `thumbprint` to every stored binding's `denied_thumbprints`,
/// retrying a lost compare-and-set against a fresh read. `Ok` carries the
/// one-line note for the response.
///
/// # Errors
///
/// [`DurableError`] when the stored set cannot be read or written, or the
/// race is lost [`CAS_ATTEMPTS`] times.
pub async fn deny_in_bindings(state: &AppState, thumbprint: &str) -> Result<String, DurableError> {
    let file = std::env::var("OPENSESAME_SERVICE_BINDINGS_FILE")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(std::path::PathBuf::from);
    let live = state.transport_lifecycle.bindings();
    for _ in 0..CAS_ATTEMPTS {
        let loaded = bindings::load(&state.db, file.as_deref())
            .await
            .map_err(DurableError::Invalid)?;
        if loaded.source == BindingsSource::Env {
            return Ok("not_updated: OPENSESAME_SERVICE_BINDINGS_FILE pins the set; the durable denylist still refuses the leaf, add it to denied_thumbprints there too".into());
        }
        let proposed = match with_denial(loaded.set, thumbprint) {
            Denial::Unchanged => return Ok("unchanged".into()),
            Denial::Full(binding) => {
                return Ok(format!(
                    "not_updated: binding {binding} denylist is full; the durable denylist still refuses the leaf"
                ))
            }
            Denial::Proposed(set) => set,
        };
        match bindings::put_cas(&state.db, loaded.source, live.as_deref(), proposed).await {
            Ok(set) => return Ok(format!("updated: revision {}", set.revision)),
            Err(PutError::StaleRevision { .. }) => {}
            Err(PutError::EnvOverride) => return Ok("not_updated: env override".into()),
            Err(PutError::Invalid(error)) => return Err(DurableError::Invalid(error)),
            Err(PutError::Storage(error)) => return Err(DurableError::Storage(error)),
        }
    }
    Err(DurableError::Contended("service bindings"))
}

enum Denial {
    Unchanged,
    Full(String),
    Proposed(ServiceBindingSet),
}

fn with_denial(mut set: ServiceBindingSet, thumbprint: &str) -> Denial {
    let mut changed = false;
    for binding in &mut set.bindings {
        if binding.denied_thumbprints.iter().any(|d| d == thumbprint) {
            continue;
        }
        if binding.denied_thumbprints.len() >= MAX_LIST_ENTRIES {
            return Denial::Full(binding.id.clone());
        }
        binding.denied_thumbprints.push(thumbprint.to_owned());
        changed = true;
    }
    if changed {
        Denial::Proposed(set)
    } else {
        Denial::Unchanged
    }
}
