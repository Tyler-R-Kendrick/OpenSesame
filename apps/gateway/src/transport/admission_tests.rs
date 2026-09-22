//! Service admission: what a verified peer does and does not get.

use axum::http::StatusCode;
use opensesame_domain::transport::{operations, BindingPurpose, BindingScope, ServiceBindingSet};

use super::admission::{require_service_caller, requires_mtls};
use super::test_support::{
    binding, forwarded, peer, plain_extensions, runtime, set, tls_extensions, THUMB_A, THUMB_B,
};

fn code(response: &axum::response::Response) -> &str {
    response
        .headers()
        .get("x-opensesame-transport-error")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
}

fn bridge_set() -> ServiceBindingSet {
    set(vec![binding(
        "b1",
        "bridge.test",
        BindingPurpose::NatsAuthBridge,
        &[operations::NATS_CALLOUT_DECIDE],
        BindingScope::Deployment,
    )])
}

async fn state(bindings: ServiceBindingSet, generation: u64) -> crate::app_state::AppState {
    let mut st = crate::app_state::test_demo_state().await;
    st.transport = Some(runtime(bindings, generation));
    st
}

#[tokio::test]
async fn a_bound_peer_is_admitted_for_its_operation_only() {
    let st = state(bridge_set(), 1).await;
    let extensions = tls_extensions(&peer("bridge.test", THUMB_A, 1), 1);
    let caller = require_service_caller(
        &st,
        &extensions,
        BindingPurpose::NatsAuthBridge,
        operations::NATS_CALLOUT_DECIDE,
    )
    .expect("admitted");
    assert_eq!(caller.binding.service_principal, "svc:bridge");
    assert!(caller.originating.is_none());

    let refused = require_service_caller(
        &st,
        &extensions,
        BindingPurpose::NatsAuthBridge,
        operations::WORKER_PROVIDERS_LIST,
    )
    .expect_err("operation not on the allowlist");
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
    assert_eq!(code(&refused), "peer_disallowed");
}

/// AT-TLS-PLAINTEXT: the same request on the plain listener is a policy
/// mismatch. There is no weaker credential it could fall back to.
#[tokio::test]
async fn the_plain_listener_never_carries_a_service_purpose() {
    let st = state(bridge_set(), 1).await;
    assert!(requires_mtls(&st, BindingPurpose::NatsAuthBridge));
    let refused = require_service_caller(
        &st,
        &plain_extensions(),
        BindingPurpose::NatsAuthBridge,
        operations::NATS_CALLOUT_DECIDE,
    )
    .expect_err("plain listener");
    assert_eq!(code(&refused), "listener_policy_mismatch");

    // Extensions with no provenance at all (a router mounted by hand) are
    // refused the same way rather than defaulting to "trusted".
    let refused = require_service_caller(
        &st,
        &axum::http::Extensions::new(),
        BindingPurpose::NatsAuthBridge,
        operations::NATS_CALLOUT_DECIDE,
    )
    .expect_err("no provenance");
    assert_eq!(code(&refused), "listener_policy_mismatch");
}

/// Evidence verified under an older generation does not survive a rotation,
/// even on a connection that is already open.
#[tokio::test]
async fn stale_generation_evidence_is_refused() {
    let st = state(bridge_set(), 5).await;
    let stale = tls_extensions(&peer("bridge.test", THUMB_A, 4), 4);
    let refused = require_service_caller(
        &st,
        &stale,
        BindingPurpose::NatsAuthBridge,
        operations::NATS_CALLOUT_DECIDE,
    )
    .expect_err("stale generation");
    assert_eq!(code(&refused), "generation_stale");
}

#[tokio::test]
async fn a_revoked_leaf_is_refused_even_under_a_name_binding() {
    let mut bindings = bridge_set();
    bindings.bindings[0]
        .denied_thumbprints
        .push(THUMB_A.to_owned());
    let st = state(bindings, 1).await;
    let refused = require_service_caller(
        &st,
        &tls_extensions(&peer("bridge.test", THUMB_A, 1), 1),
        BindingPurpose::NatsAuthBridge,
        operations::NATS_CALLOUT_DECIDE,
    )
    .expect_err("revoked leaf");
    assert_eq!(code(&refused), "evidence_revoked");
}

/// Behind a trusted ingress the *ingress* is the bound peer and the client is
/// carried as `originating`. Binding the client's own certificate would let
/// any client of that ingress act as the ingress.
#[tokio::test]
async fn forwarded_evidence_binds_the_ingress_and_keeps_the_client() {
    let bindings = set(vec![binding(
        "ingress",
        "edge.test",
        BindingPurpose::TrustedIngress,
        &[operations::INGRESS_FORWARD],
        BindingScope::Deployment,
    )]);
    let st = state(bindings, 1).await;
    let ingress = peer("edge.test", THUMB_A, 1);
    let evidence = forwarded("client.test", THUMB_B, &ingress);
    let mut extensions = tls_extensions(&ingress, 1);
    extensions.insert(opensesame_ingress_evidence::OriginatingPeerExtension(
        std::sync::Arc::new(evidence),
    ));
    let caller = require_service_caller(
        &st,
        &extensions,
        BindingPurpose::TrustedIngress,
        operations::INGRESS_FORWARD,
    )
    .expect("admitted");
    assert_eq!(caller.peer.leaf_thumbprint_sha256(), THUMB_A);
    assert_eq!(
        caller
            .originating
            .as_ref()
            .map(opensesame_domain::transport::VerifiedPeer::leaf_thumbprint_sha256),
        Some(THUMB_B)
    );
}

#[tokio::test]
async fn no_transport_runtime_admits_nobody() {
    let mut st = crate::app_state::test_demo_state().await;
    st.transport = None;
    let refused = require_service_caller(
        &st,
        &tls_extensions(&peer("bridge.test", THUMB_A, 1), 1),
        BindingPurpose::NatsAuthBridge,
        operations::NATS_CALLOUT_DECIDE,
    )
    .expect_err("unconfigured");
    assert_eq!(code(&refused), "listener_policy_mismatch");
    assert!(!requires_mtls(&st, BindingPurpose::NatsAuthBridge));
}

/// AUTHENTICATION-IS-NOT-AUTHORIZATION. Nothing in this module constructs a
/// `Caller`, so no admitted bridge or worker can become an operator, and the
/// operator routes keep resolving callers exactly as they did.
#[test]
fn admission_never_produces_an_operator_caller() {
    let src = include_str!("admission.rs");
    assert!(!src.contains("Caller::Operator"));
    assert!(!src.contains("require_operator"));
    assert!(!src.contains("resolve_caller"));
    let module = include_str!("mod.rs");
    assert!(module.contains("never becomes"));
}
