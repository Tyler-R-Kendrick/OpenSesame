//! Serving the Host router on one or two listeners.
//!
//! The plain listener never goes away — `existing_local` is a supported
//! profile, not a fallback — but it is stamped
//! `ListenerProvenance::Plain { listener_id: "host-plain" }` so admission can
//! tell where a request came from. When `OPENSESAME_TLS_LISTEN` is
//! configured, a [`SecureListener`] serves the *same* router with
//! `Tls { listener_id: "host-tls", .. }` provenance and, on the
//! authenticating policies, a verified peer per connection.
//!
//! A configured-but-broken secure profile is an error out of this function,
//! so `main` returns `Err` and nothing serves at all. That is the whole of
//! EXPLICIT-ENFORCEMENT at the entry point: there is no path where a
//! `mtls_required` deployment ends up answering on plaintext because its key
//! file was unreadable.

use std::{future::IntoFuture, sync::Arc};

use anyhow::Context as _;
use axum::Router;
use opensesame_domain::transport::{TransportError, TransportPolicy};
use opensesame_transport_security::{
    enforce_current_generation, plain_provenance_layer, DenyThumbprint, SecureListener,
    ServerProfile,
};

use crate::app_state::AppState;
use crate::config::Args;

use super::{TransportRuntime, HOST_PLAIN_LISTENER};

/// Serve `app` on the plain listener, and on the secure listener when one is
/// configured. Returns when either serving loop stops.
///
/// # Errors
///
/// A secure listener that cannot be bound with the configured material, or
/// a plain listener that cannot be bound.
pub async fn serve(state: AppState, args: &Args, app: Router) -> anyhow::Result<()> {
    let app = with_ingress(&state, app);
    let listen = args.listen.to_string();
    opensesame_host_core::daemon::assert_tcp_listen_allowed(&listen).map_err(anyhow::Error::msg)?;
    // Bind both sockets before either serves. A failed primary bind must not
    // leave a detached secure listener accepting requests after startup failed.
    let listener = tokio::net::TcpListener::bind(args.listen)
        .await
        .with_context(|| format!("bind {listen}"))?;
    let secure = match state
        .transport
        .as_ref()
        .and_then(|runtime| runtime.listen.map(|address| (runtime, address)))
    {
        Some((runtime, address)) => {
            let listener = bind_secure_listener(&state, runtime, address).await?;
            let app = app.clone().layer(axum::middleware::from_fn_with_state(
                Arc::clone(&runtime.generations),
                enforce_current_generation,
            ));
            Some((listener, app))
        }
        None => None,
    };
    let plain = app.layer(plain_provenance_layer(HOST_PLAIN_LISTENER));
    tracing::info!(%listen, "opensesame gateway listening");
    let primary = axum::serve(
        listener,
        plain.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .into_future();
    match secure {
        Some((listener, app)) => {
            // Neither listener outlives this future. Failure of either one
            // stops acceptance on both, including when an embedder cancels it.
            tokio::select! {
                result = primary => result.map_err(Into::into),
                result = listener.serve(app) => result.map_err(Into::into),
            }
        }
        None => primary.await.map_err(Into::into),
    }
}

/// Bind the secure listener for `runtime` without starting a detached task.
///
/// # Errors
///
/// The listener cannot be bound with the configured material.
async fn bind_secure_listener(
    state: &AppState,
    runtime: &TransportRuntime,
    listen: std::net::SocketAddr,
) -> anyhow::Result<SecureListener> {
    opensesame_host_core::daemon::assert_tcp_listen_allowed(&listen.to_string())
        .map_err(anyhow::Error::msg)?;
    let policy = runtime.policy;
    let client_profile = runtime.client_trust_profile.clone();
    let deny_thumbprint = deny_hook(state, runtime);
    let listener = SecureListener::bind(
        listen,
        Arc::clone(&runtime.generations),
        move |generation| {
            let identity = generation
                .identity
                .clone()
                .ok_or(TransportError::IdentityMissing)?;
            let mut profile = ServerProfile::new(policy, identity, super::HOST_TLS_LISTENER);
            profile.deny_thumbprint = Arc::clone(&deny_thumbprint);
            if policy.authenticates_client() {
                profile.client_trust = Some(generation.trust(&client_profile)?.clone());
            }
            Ok(profile)
        },
    )
    .await
    .map_err(|error| {
        anyhow::anyhow!(
            "secure listener refused to start: {error} [{}]",
            error.code()
        )
    })?;
    tracing::info!(listen = %listen, policy = ?policy, "opensesame gateway secure listener");
    Ok(listener)
}

/// The listener's revoked-leaf hook, composed from **both** authorities that
/// can revoke a leaf.
///
/// The service-binding set carries `denied_thumbprints` that every process
/// reads, and the certificate lifecycle keeps a process-wide denylist that a
/// revoke verb writes immediately. Either one is sufficient to refuse a new
/// handshake: asking only the binding set would let a revocation *by
/// thumbprint* — and every revocation at all while
/// `OPENSESAME_SERVICE_BINDINGS_FILE` pins the set — complete a fresh
/// handshake, which is the first layer of AT-TLS-REVOKEDLIVE.
///
/// The same hook is handed to `enforce_current_generation` through
/// `PeerDenyHook`, so an already-open connection is refused its next guarded
/// operation on exactly the same evidence.
#[must_use]
pub fn deny_hook(state: &AppState, runtime: &TransportRuntime) -> DenyThumbprint {
    let bindings_deny = runtime.deny_thumbprint_hook();
    let lifecycle_deny = state.transport_lifecycle.deny_hook();
    Arc::new(move |thumbprint: &str| bindings_deny(thumbprint) || lifecycle_deny(thumbprint))
}

/// The trusted-ingress layer goes on the shared router, inside the
/// provenance layer, so forwarded evidence is verified once for whichever
/// listener carried it — and stripped everywhere it is not admissible.
///
/// The layer gets the listener's own revoked-leaf hook ([`deny_hook`]): the
/// per-request guard only sees the ingress's leaf, so a revoked
/// *originating* client is refused here instead, on the same evidence.
fn with_ingress(state: &AppState, app: Router) -> Router {
    match state
        .transport
        .as_ref()
        .filter(|runtime| runtime.policy == TransportPolicy::TrustedIngress)
        .and_then(|runtime| {
            runtime
                .ingress_layer
                .clone()
                .map(|layer| layer.with_deny_thumbprint(deny_hook(state, runtime)))
        }) {
        Some(layer) => app.layer(layer),
        None => app,
    }
}
