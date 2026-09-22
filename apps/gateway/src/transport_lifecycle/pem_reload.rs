//! Re-reading a PEM-sourced listener identity after an external renewer
//! replaced the files on disk (LIFE-ACTIVATION, the `pem` half).
//!
//! A `pem` identity source is the one source this Host does not own: certbot,
//! a SPIRE sidecar's file writer, a configuration-management run or an
//! operator replaces `P_CERT_FILE` / `P_KEY_FILE` and expects the listener to
//! pick the successor up. Nothing here polls a certificate's *expiry* — that
//! is the ADR 0074 lifecycle feed's job and a private due-check would be
//! exactly the duplication ADR 0074 forbids. What this pass watches is the
//! **files**: size and mtime. A pair that has not changed is not re-read.
//!
//! The reload itself goes through [`activation::activate_pem`], so the whole
//! pair is validated before anything swaps and a malformed or mismatched
//! replacement is a recorded `reload_failed` fact with the previous
//! generation — and therefore the previous `not_after` — still serving
//! (AT-ROTATE-ATOMIC). Half-written files are the normal case here, and they
//! must never take a listener down.

use std::path::Path;

use opensesame_domain::transport::TransportError;
use opensesame_transport_security::env::NativeIdentitySpec;
use opensesame_transport_security::SecretBytes;

use crate::app_state::AppState;
use crate::transport_lifecycle::{activation, HOST_LISTENER_TARGET};

/// One file's identity on disk, as cheaply as it can be taken.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FileStamp {
    len: u64,
    modified: Option<std::time::SystemTime>,
}

/// What the last pass saw. `None` means "not looked yet": the first pass
/// records the stamp and reloads nothing, because the runtime loaded these
/// exact files at boot.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Watch {
    seen: Option<(Option<FileStamp>, Option<FileStamp>)>,
}

impl Watch {
    #[must_use]
    pub const fn new() -> Self {
        Self { seen: None }
    }
}

fn stamp(path: &Path) -> Option<FileStamp> {
    let metadata = std::fs::metadata(path).ok()?;
    Some(FileStamp {
        len: metadata.len(),
        modified: metadata.modified().ok(),
    })
}

/// What one pass did, so a caller can log it without inventing a claim.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Pass {
    /// No `pem`-sourced listener, or no generations to activate on.
    NotApplicable,
    /// The first pass: the stamp is now known, nothing was re-read.
    Primed,
    /// The files are byte-for-byte as they were when last seen.
    Unchanged,
    /// The replacement loaded as this generation.
    Reloaded(u64),
    /// The replacement was refused; the previous generation keeps serving and
    /// a `reload_failed` fact was recorded.
    Refused(TransportError),
}

/// Look once at the configured PEM pair and, when it changed since the last
/// look, offer it to the running listener.
///
/// Never returns an error: a failed reload is a recorded fact and a [`Pass`],
/// because a background pass that aborted its own loop over a half-written
/// file would be worse than the stale certificate it was trying to replace.
pub async fn pass(state: &AppState, watch: &mut Watch) -> Pass {
    let Some(runtime) = state.transport.as_ref() else {
        return Pass::NotApplicable;
    };
    let Some(listener) = runtime.config.listener.as_ref() else {
        return Pass::NotApplicable;
    };
    let NativeIdentitySpec::PemFiles { cert, key } = &listener.identity else {
        return Pass::NotApplicable;
    };
    let current = (stamp(cert), stamp(key));
    let previous = watch.seen.replace(current);
    let Some(previous) = previous else {
        return Pass::Primed;
    };
    if previous == current {
        return Pass::Unchanged;
    }
    let Some(generations) = state.transport_lifecycle.generations() else {
        return Pass::NotApplicable;
    };
    let chain = match std::fs::read(cert) {
        Ok(bytes) => bytes,
        Err(error) => {
            return refused(
                state,
                TransportError::malformed(format!("certificate file: {error}")),
            )
            .await
        }
    };
    let key_bytes = match std::fs::read(key) {
        Ok(bytes) => bytes,
        Err(error) => {
            return refused(
                state,
                TransportError::malformed(format!("key file: {error}")),
            )
            .await
        }
    };
    let secret = SecretBytes::new(Box::new(key_bytes));
    match activation::activate_pem(state, HOST_LISTENER_TARGET, &generations, &chain, secret).await
    {
        Ok(generation) => Pass::Reloaded(generation),
        Err(error) => Pass::Refused(error),
    }
}

/// One pass, with the two outcomes worth a log line logged. The renewal
/// loop's call site is this, so the loop body stays one statement.
pub async fn pass_and_log(state: &AppState, watch: &mut Watch) {
    match pass(state, watch).await {
        Pass::Reloaded(generation) => {
            tracing::info!(generation, "pem listener identity reloaded from disk");
        }
        Pass::Refused(error) => tracing::warn!(
            code = error.code(),
            "replacement pem listener identity refused; the previous generation keeps serving",
        ),
        Pass::NotApplicable | Pass::Primed | Pass::Unchanged => {}
    }
}

/// An unreadable file never reaches `activate_pem`, so record by hand the
/// same `reload_failed` fact a malformed one would have produced there.
async fn refused(state: &AppState, error: TransportError) -> Pass {
    crate::transport_lifecycle::facts::note(
        state,
        HOST_LISTENER_TARGET,
        crate::transport_lifecycle::facts::Fact::ReloadFailed {
            code: error.code().to_owned(),
            at: chrono::Utc::now(),
        },
    )
    .await;
    Pass::Refused(error)
}
