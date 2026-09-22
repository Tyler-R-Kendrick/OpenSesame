//! SVC-AUTHORITY: effective authority is an intersection, and every factor
//! is checked independently.
//!
//! The threat these cover is credential substitution — a legitimate
//! certificate from one tenant, purpose, or epoch used to reach something it
//! was never bound to. Each case presents *valid* evidence and asserts the
//! refusal anyway.

use opensesame_domain::transport::{operations, BindingPurpose, BindingScope, ServiceBindingSet};
use opensesame_domain::OrganizationId;

use super::admission::{require_delegated_caller, require_service_caller};
use super::test_support::{binding, peer, runtime, set, tls_extensions, THUMB_A};

fn code(response: &axum::response::Response) -> &str {
    response
        .headers()
        .get("x-opensesame-transport-error")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
}

async fn state(bindings: ServiceBindingSet) -> crate::app_state::AppState {
    let mut st = crate::app_state::test_demo_state().await;
    st.transport = Some(runtime(bindings, 1));
    st
}

/// AT-AUTHORITY-UNBOUND: a certificate that chains to the configured client
/// CA and is inside its window, that nothing binds.
#[tokio::test]
async fn a_valid_but_unbound_certificate_is_authenticated_and_unauthorized() {
    let st = state(ServiceBindingSet::empty()).await;
    let refused = require_service_caller(
        &st,
        &tls_extensions(&peer("stranger.test", THUMB_A, 1), 1),
        BindingPurpose::NatsAuthBridge,
        operations::NATS_CALLOUT_DECIDE,
    )
    .expect_err("unbound");
    assert_eq!(code(&refused), "peer_not_bound");
}

/// A binding for one purpose never satisfies another, however generous its
/// operation list.
#[tokio::test]
async fn a_binding_for_another_purpose_does_not_carry_over() {
    let st = state(set(vec![binding(
        "b1",
        "worker.test",
        BindingPurpose::WorkerClient,
        &[
            operations::NATS_CALLOUT_DECIDE,
            operations::WORKER_PROVIDERS_LIST,
        ],
        BindingScope::Deployment,
    )]))
    .await;
    let refused = require_service_caller(
        &st,
        &tls_extensions(&peer("worker.test", THUMB_A, 1), 1),
        BindingPurpose::NatsAuthBridge,
        operations::NATS_CALLOUT_DECIDE,
    )
    .expect_err("wrong purpose");
    assert_eq!(code(&refused), "peer_not_bound");
}

/// AT-AUTHORITY-CROSSTENANT: certificate A (bound in organization A) plus an
/// actor context for organization B. Neither factor is weakened by the other.
#[tokio::test]
async fn certificate_a_with_a_tenant_b_context_is_refused() {
    let organization_a = OrganizationId::new();
    let organization_b = OrganizationId::new();
    let st = state(set(vec![binding(
        "b1",
        "connector.test",
        BindingPurpose::UpstreamConnector,
        &[operations::CONNECTOR_INVOKE],
        BindingScope::Organization {
            organization_id: organization_a.to_string(),
        },
    )]))
    .await;
    let extensions = tls_extensions(&peer("connector.test", THUMB_A, 1), 1);

    let admitted = require_delegated_caller(
        &st,
        &extensions,
        BindingPurpose::UpstreamConnector,
        operations::CONNECTOR_INVOKE,
        &organization_a,
    )
    .expect("its own tenant");
    assert_eq!(
        admitted.binding.scope,
        BindingScope::Organization {
            organization_id: organization_a.to_string()
        }
    );

    let refused = require_delegated_caller(
        &st,
        &extensions,
        BindingPurpose::UpstreamConnector,
        operations::CONNECTOR_INVOKE,
        &organization_b,
    )
    .expect_err("another tenant");
    assert_eq!(code(&refused), "peer_not_bound");

    // A deployment-scoped lookup does not satisfy a tenant binding either.
    let refused = require_service_caller(
        &st,
        &extensions,
        BindingPurpose::UpstreamConnector,
        operations::CONNECTOR_INVOKE,
    )
    .expect_err("deployment scope");
    assert_eq!(code(&refused), "peer_not_bound");
}

/// A binding that was withdrawn (disabled, revoked, or past its window) stops
/// admitting immediately — the certificate is untouched and still refused.
#[tokio::test]
async fn a_withdrawn_binding_stops_admitting() {
    let mut bindings = set(vec![binding(
        "b1",
        "bridge.test",
        BindingPurpose::NatsAuthBridge,
        &[operations::NATS_CALLOUT_DECIDE],
        BindingScope::Deployment,
    )]);
    let st = state(bindings.clone()).await;
    let extensions = tls_extensions(&peer("bridge.test", THUMB_A, 1), 1);
    assert!(require_service_caller(
        &st,
        &extensions,
        BindingPurpose::NatsAuthBridge,
        operations::NATS_CALLOUT_DECIDE,
    )
    .is_ok());

    bindings.bindings[0].enabled = false;
    bindings.revision = 2;
    *st.transport
        .as_ref()
        .expect("runtime")
        .bindings
        .write()
        .unwrap() = bindings.clone();
    let refused = require_service_caller(
        &st,
        &extensions,
        BindingPurpose::NatsAuthBridge,
        operations::NATS_CALLOUT_DECIDE,
    )
    .expect_err("disabled");
    assert_eq!(code(&refused), "binding_disabled");

    bindings.bindings[0].enabled = true;
    bindings.bindings[0].not_after = Some(chrono::Utc::now() - chrono::Duration::minutes(1));
    *st.transport
        .as_ref()
        .expect("runtime")
        .bindings
        .write()
        .unwrap() = bindings;
    let refused = require_service_caller(
        &st,
        &extensions,
        BindingPurpose::NatsAuthBridge,
        operations::NATS_CALLOUT_DECIDE,
    )
    .expect_err("expired binding");
    assert_eq!(code(&refused), "binding_disabled");
}

/// SOURCE-TRUTH: this work adds no remote minting, forwarding, or execution
/// endpoint. The transport surface is diagnostics and configuration only.
#[test]
fn no_new_remote_mint_or_execution_route_exists() {
    let routes = include_str!("routes.rs");
    for forbidden in [
        "/api/v1/operator/transport/mint",
        "/api/v1/transport/issue",
        "/api/v1/transport/sign",
        "/api/v1/transport/execute",
        "/api/v1/transport/forward",
    ] {
        assert!(!routes.contains(forbidden), "unexpected route {forbidden}");
    }
    // Exactly three routes, all under the operator prefix.
    assert_eq!(routes.matches(".route(\"").count(), 3);
    assert_eq!(routes.matches("\"/api/v1/operator/transport/").count(), 3);
    // Nothing here reads a private key, a locator, or a caller-named host.
    for forbidden in ["key_pem", "private_key", "expose_secret", "reveal"] {
        assert!(!routes.contains(forbidden), "unexpected {forbidden}");
    }
}
