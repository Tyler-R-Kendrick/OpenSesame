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
//!
//! [`restore`] then reads what the store holds before anything is served —
//! the durable revoked-leaf denylist and the stored trust profiles — and
//! [`run_refresh`] keeps both within `transport::bindings::REFRESH_INTERVAL`
//! of the store, so replicas sharing one store converge on a revocation or a
//! trust change the way they already converge on the binding set.

use chrono::Utc;

use crate::app_state::AppState;
use crate::transport_lifecycle::{crl, revocation_store, trust, HOST_LISTENER_TARGET};

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

/// Read the durable state into this process before it serves. Called from
/// `main` right after [`attach`].
///
/// # Errors
///
/// A revoked-leaf denylist that cannot be read: the gateway does not start
/// rather than readmit a revoked leaf. A stored trust set that does not
/// activate is logged and retried by [`run_refresh`]; until then only the
/// deployment plane's anchors serve, which admits fewer peers, never more.
pub async fn restore(state: &AppState) -> anyhow::Result<()> {
    let denied = revocation_store::restore(state)
        .await
        .map_err(|error| anyhow::anyhow!("transport revoked-leaf denylist: {error}"))?;
    if denied > 0 {
        tracing::info!(denied, "revoked transport leaves restored from the store");
    }
    if let Err(error) = trust::refresh(state, Utc::now()).await {
        tracing::warn!(
            code = error.code(),
            "stored trust profiles not activated at boot"
        );
    }
    Ok(())
}

/// One refresh pass: adopt a newer stored trust set, and deny every stored
/// revoked leaf this process does not deny yet. Neither moves backwards.
pub async fn refresh_once(state: &AppState) {
    refresh_trust(state).await;
    refresh_revoked(state).await;
}

async fn refresh_trust(state: &AppState) {
    match trust::refresh(state, Utc::now()).await {
        Ok(true) => tracing::info!("transport trust refreshed from the store"),
        Ok(false) => {}
        Err(error) => tracing::warn!(
            code = error.code(),
            "transport trust could not be refreshed; keeping the serving set"
        ),
    }
}

async fn refresh_revoked(state: &AppState) {
    match revocation_store::refresh(state).await {
        Ok(0) => {}
        Ok(added) => tracing::info!(added, "revoked transport leaves refreshed from the store"),
        Err(error) => tracing::warn!(
            code = error.code(),
            "revoked transport leaves could not be refreshed; keeping the denylist"
        ),
    }
}

/// Process-lifetime loop over [`refresh_once`], on the bindings cadence.
pub async fn run_refresh(state: AppState) {
    let mut ticks = tokio::time::interval(crate::transport::bindings::REFRESH_INTERVAL);
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticks.tick().await;
        refresh_once(&state).await;
    }
}
