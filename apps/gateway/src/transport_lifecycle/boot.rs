//! The one-shot bridge from the transport runtime to the certificate
//! lifecycle, called from `main` right after `AppState` is built.
//!
//! Three things happen here and nothing else:
//!
//! 1. The runtime's [`TransportGenerations`] and live binding set are attached
//!    to [`LifecycleState`], so a revocation reaches the guard that refuses an
//!    already-open connection's next operation, and a trust write actually
//!    re-activates instead of only being stored.
//! 2. The deployment-plane peer-trust bundles the listener booted with are
//!    recorded as the *base* map, so a stored profile can never take one of
//!    their names.
//! 3. A configured `OPENSESAME_TLS_CRL_FILE` is read once and its freshness
//!    recorded. A CRL past its `nextUpdate` makes the transport status
//!    `degraded` — it is never silently treated as current.
//!
//! With no secure listener configured this is a no-op: an unconfigured
//! optional feature is not an error (EXPLICIT-ENFORCEMENT).

use chrono::Utc;

use crate::app_state::AppState;
use crate::transport_lifecycle::{crl, HOST_LISTENER_TARGET};

/// Attach the lifecycle to whatever transport runtime was booted.
pub fn attach(state: &AppState) {
    let Some(runtime) = state.transport.as_ref() else {
        return;
    };
    let base_trust = runtime.generations.current().peer_trust.clone();
    state
        .transport_lifecycle
        .attach_generations(runtime.generations.clone(), base_trust);
    state
        .transport_lifecycle
        .attach_bindings(runtime.bindings.clone());

    if let Some(listener) = runtime.config.listener.as_ref() {
        if let opensesame_transport_security::NativeIdentitySpec::ManagedCertificate {
            certificate_id,
        } = &listener.identity
        {
            // Renewal now knows which target to re-activate after a reissue.
            state
                .transport_lifecycle
                .bind_target(HOST_LISTENER_TARGET, certificate_id);
        }
        if let Some(path) = listener.crl_file.as_ref() {
            match crl::load_crl_file(state, path, Utc::now()) {
                Ok(_) => tracing::info!("transport CRL loaded; freshness recorded"),
                Err(error) => tracing::warn!(
                    code = error.code(),
                    "configured transport CRL could not be read; revocation status is degraded",
                ),
            }
        }
    }
}
