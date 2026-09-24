//! AT-TLS-REVOKEDLIVE, layer 1: a revoked leaf is refused at a **new
//! handshake**, not only on the next request of a connection that was
//! already authenticated.
//!
//! These drive a real [`SecureListener`] with a real rustls client, and they
//! build the listener's profile with `boot::deny_hook` — the same composition
//! `boot::serve` installs — so what is under test is the production wiring
//! rather than a hook a test wired for itself.
//!
//! The two cases the binding set alone cannot cover are exactly the two here:
//! a revocation **by thumbprint** (no certificate row, no binding to amend)
//! and **any** revocation while `OPENSESAME_SERVICE_BINDINGS_FILE` pins the
//! set so the stored denylist cannot be written at all. In both, the
//! lifecycle's process-wide denylist is the only authority that knows, and
//! the composed hook is the only thing that asks it.

use std::sync::Arc;

use opensesame_domain::transport::{
    BindingPurpose, BindingScope, ServiceBindingSet, TransportError, TransportPolicy,
};
use opensesame_transport_security::testkit::DisposableCa;
use opensesame_transport_security::{Generation, ServerProfile, TransportGenerations};

use crate::app_state::AppState;
use crate::transport::test_support as fixtures;
use crate::transport::TransportRuntime;
use crate::transport_lifecycle::revocation::{self, RevokeReason, RevokeRequest};
use crate::transport_lifecycle::test_support as support;

/// The listener profile exactly as `boot::serve` builds it: the composed
/// denylist hook, and nothing else changed.
fn profile_fn(
    state: &AppState,
    runtime: &TransportRuntime,
) -> impl Fn(&Generation) -> Result<ServerProfile, TransportError> + Send + Sync + 'static {
    let deny = super::boot::deny_hook(state, runtime);
    move |generation: &Generation| {
        let identity = generation
            .identity
            .clone()
            .ok_or(TransportError::IdentityMissing)?;
        let mut profile =
            ServerProfile::new(TransportPolicy::MtlsRequired, identity, support::LISTENER);
        profile.client_trust = Some(
            generation
                .trust(&support::profile_ref(support::CLIENTS))?
                .clone(),
        );
        profile.deny_thumbprint = Arc::clone(&deny);
        Ok(profile)
    }
}

/// A fresh handshake presenting `config` must not reach `/protected`.
///
/// TLS 1.3 lets a client finish its half of the handshake before the server's
/// alert arrives, so "refused" is either a failed handshake or a refused
/// first request — never a 200.
async fn fresh_handshake_is_refused(
    config: Arc<rustls::ClientConfig>,
    addr: std::net::SocketAddr,
    what: &str,
) {
    match support::connect(config, addr).await {
        Err(message) => assert!(message.starts_with("tls:"), "{what}: {message}"),
        // The server may instead drop the connection; either way nothing is
        // served, which is what "refused" means here.
        Ok(mut stream) => {
            if let Ok((status, body)) = support::request_on(&mut stream, "/protected").await {
                assert_eq!(status, 403, "{what}: served {body}");
            }
        }
    }
}

/// Bindings that admit `worker.test` and deny nothing, so the binding half of
/// the composed hook can never be what refuses the leaf.
fn admitting_bindings() -> ServiceBindingSet {
    fixtures::set(vec![fixtures::binding(
        "binding:worker",
        "worker.test",
        BindingPurpose::WorkerClient,
        &["worker.health.ready"],
        BindingScope::Deployment,
    )])
}

async fn listener_for(
    state: &AppState,
    generations: &Arc<TransportGenerations>,
    bindings: ServiceBindingSet,
) -> (Arc<TransportRuntime>, support::Served) {
    let runtime =
        fixtures::runtime_serving(Arc::clone(generations), bindings, fixtures::mtls_config());
    let served = support::serve(
        Arc::clone(generations),
        profile_fn(state, &runtime),
        support::router(Arc::clone(generations)),
    )
    .await;
    (runtime, served)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_leaf_revoked_by_thumbprint_alone_is_refused_at_a_fresh_handshake() {
    // No certificate row and no binding change: the only authority that knows
    // this leaf is revoked is the lifecycle denylist. The generations are
    // deliberately **not** attached to the lifecycle, so `TransportGenerations`
    // own denylist is empty and the composed hook is the only thing that can
    // refuse the handshake.
    let state = support::state().await;
    let server_ca = DisposableCa::new("servers");
    let client_ca = DisposableCa::new("clients");
    let generations =
        support::generations(server_ca.issue_server("localhost").identity(), &client_ca);
    let (_runtime, listener) = listener_for(&state, &generations, admitting_bindings()).await;

    let leaf = support::client_leaf(&client_ca, "worker.test");
    let config = support::client(&server_ca, Some(Arc::new(leaf.identity())));
    let mut live = support::connect(Arc::clone(&config), listener.addr)
        .await
        .expect("connect before revocation");
    assert_eq!(
        support::request_on(&mut live, "/protected")
            .await
            .expect("before revocation")
            .0,
        200,
        "the leaf must be admitted before it is revoked, or the test proves nothing",
    );

    let outcome = revocation::revoke_transport(
        &state,
        &state.connection_organization,
        revocation::Revoker::Operator,
        RevokeRequest {
            certificate_id: None,
            thumbprint: Some(leaf.thumbprint.clone()),
            reason: RevokeReason::KeyCompromise,
        },
    )
    .await
    .expect("revoke by thumbprint");
    assert_eq!(outcome.new_handshakes, "refused_in_this_process");
    assert!(
        !generations.is_denied(&leaf.thumbprint),
        "the generations denylist must be empty here, or this test would pass without the hook",
    );

    // Layer 1: a brand-new handshake.
    fresh_handshake_is_refused(config, listener.addr, "revoked by thumbprint").await;

    // Layer 2, unchanged by this work: the already-open connection.
    let (status, _) = support::request_on(&mut live, "/protected")
        .await
        .expect("after revocation");
    assert_eq!(
        status, 403,
        "an open connection is denied its next operation"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_revocation_is_refused_at_the_handshake_while_the_bindings_file_pins_the_set() {
    // With `OPENSESAME_SERVICE_BINDINGS_FILE` set, `denied_thumbprints` cannot
    // be written anywhere a binding lookup would read them — the revoke says
    // so in as many words. The handshake must still be refused.
    let state = support::state().await;
    let server_ca = DisposableCa::new("servers");
    let client_ca = DisposableCa::new("clients");
    let generations =
        support::generations(server_ca.issue_server("localhost").identity(), &client_ca);
    let bindings = admitting_bindings();
    let (_runtime, listener) = listener_for(&state, &generations, bindings.clone()).await;

    let leaf = support::client_leaf(&client_ca, "worker.test");
    let config = support::client(&server_ca, Some(Arc::new(leaf.identity())));
    let mut live = support::connect(Arc::clone(&config), listener.addr)
        .await
        .expect("connect before revocation");
    assert_eq!(
        support::request_on(&mut live, "/protected")
            .await
            .expect("before revocation")
            .0,
        200,
    );

    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("bindings.json");
    std::fs::write(
        &path,
        serde_json::to_vec(&bindings).expect("encode bindings"),
    )
    .expect("write bindings file");

    let guard = crate::app_state::test_env::lock();
    std::env::set_var("OPENSESAME_SERVICE_BINDINGS_FILE", &path);
    let outcome = revocation::revoke_transport(
        &state,
        &state.connection_organization,
        revocation::Revoker::Operator,
        RevokeRequest {
            certificate_id: None,
            thumbprint: Some(leaf.thumbprint.clone()),
            reason: RevokeReason::KeyCompromise,
        },
    )
    .await;
    std::env::remove_var("OPENSESAME_SERVICE_BINDINGS_FILE");
    drop(guard);
    let outcome = outcome.expect("revoke by thumbprint");
    assert!(
        outcome.bindings.starts_with("not_updated:"),
        "the pinned set must refuse the write, or this test is not testing the pinned case: {}",
        outcome.bindings,
    );

    fresh_handshake_is_refused(config, listener.addr, "revoked while bindings are pinned").await;
    let (status, _) = support::request_on(&mut live, "/protected")
        .await
        .expect("after revocation");
    assert_eq!(status, 403);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unrevoked_leaf_still_completes_a_fresh_handshake() {
    // The composed hook must not deny by accident: a second, never-revoked
    // leaf under the same CA keeps working after the first is revoked.
    let state = support::state().await;
    let server_ca = DisposableCa::new("servers");
    let client_ca = DisposableCa::new("clients");
    let generations =
        support::generations(server_ca.issue_server("localhost").identity(), &client_ca);
    let (_runtime, listener) = listener_for(&state, &generations, admitting_bindings()).await;

    let revoked = support::client_leaf(&client_ca, "worker.test");
    let kept = support::client_leaf(&client_ca, "worker.test");
    revocation::revoke_transport(
        &state,
        &state.connection_organization,
        revocation::Revoker::Operator,
        RevokeRequest {
            certificate_id: None,
            thumbprint: Some(revoked.thumbprint.clone()),
            reason: RevokeReason::KeyCompromise,
        },
    )
    .await
    .expect("revoke");

    let config = support::client(&server_ca, Some(Arc::new(kept.identity())));
    let mut stream = support::connect(config, listener.addr)
        .await
        .expect("the unrevoked leaf still connects");
    assert_eq!(
        support::request_on(&mut stream, "/protected")
            .await
            .expect("unrevoked request")
            .0,
        200,
    );
}

/// The wiring itself: `boot` asks both authorities, and asks them with `||`
/// so either one refusing is enough.
#[test]
fn the_listener_hook_is_composed_from_both_denylists() {
    let src = include_str!("boot.rs");
    assert!(src.contains("runtime.deny_thumbprint_hook()"));
    assert!(src.contains("state.transport_lifecycle.deny_hook()"));
    assert!(src.contains("bindings_deny(thumbprint) || lifecycle_deny(thumbprint)"));
    assert!(
        src.contains("let deny_thumbprint = deny_hook(state, runtime);"),
        "the secure listener must take the composed hook, not one half of it",
    );
}
