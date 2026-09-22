//! The enforcement probe: what it may target and when its result goes stale.

use chrono::{Duration, Utc};
use opensesame_domain::transport::{EnforcementStatus, ServiceBindingSet};

use super::probe::{self, ProbeTarget, FRESH_FOR, PROBE_PATH};
use super::test_support::{lookup, runtime};

#[test]
fn the_target_allowlist_is_three_words() {
    assert_eq!(ProbeTarget::parse("host-tls"), Some(ProbeTarget::HostTls));
    assert_eq!(ProbeTarget::parse("worker"), Some(ProbeTarget::Worker));
    assert_eq!(
        ProbeTarget::parse("identity-mapping"),
        Some(ProbeTarget::IdentityMapping)
    );
    for rejected in [
        "HOST-TLS",
        "host_tls",
        "host-tls.",
        "https://identity.test",
        "127.0.0.1",
        "localhost:8443",
        "",
    ] {
        assert!(
            ProbeTarget::parse(rejected).is_none(),
            "accepted {rejected}"
        );
    }
}

/// The only route a probe ever asks for is the harmless liveness one; no
/// business operation is invoked and no third party is touched.
#[test]
fn the_probe_requests_one_harmless_route() {
    assert_eq!(PROBE_PATH, "/health/live");
    let src = include_str!("probe.rs");
    assert_eq!(src.matches("client.get(").count(), 1);
    // No caller-supplied destination reaches the dialer: the authority comes
    // from the configured server expectation, the address from a
    // deployment variable.
    assert!(!src.contains("body."));
    assert!(src.contains("resolve_to_addrs"));
    assert!(src.contains(".no_proxy()"));
    assert!(src.contains("redirect::Policy::none()"));
}

#[tokio::test]
async fn an_unconfigured_probe_identity_is_unsupported_not_anonymous() {
    let runtime = runtime(ServiceBindingSet::empty(), 1);
    let empty = lookup(vec![]);
    for target in [
        ProbeTarget::HostTls,
        ProbeTarget::Worker,
        ProbeTarget::IdentityMapping,
    ] {
        let error = probe::plan_from(&runtime, target, &empty).expect_err("no probe identity");
        assert_eq!(error.code(), "enforcement_unsupported");
    }
}

#[tokio::test]
async fn a_probe_address_comes_from_the_deployment_plane() {
    let runtime = runtime(ServiceBindingSet::empty(), 1);
    // Named but unparseable: refused, never coerced.
    let bad = lookup(vec![(
        "OPENSESAME_WORKER_PROBE_ADDR",
        "evil.test:443".to_owned(),
    )]);
    assert_eq!(
        probe::plan_from(&runtime, ProbeTarget::Worker, &bad)
            .expect_err("not a socket address")
            .code(),
        "enforcement_unsupported"
    );
    assert_eq!(
        ProbeTarget::Worker.address_var(),
        Some("OPENSESAME_WORKER_PROBE_ADDR")
    );
    assert_eq!(ProbeTarget::HostTls.address_var(), None);
}

/// A verification is bound to the generation it was taken under: a rotation,
/// or simply time, turns it back into an unproven claim.
#[test]
fn a_later_generation_makes_a_verification_stale() {
    let at = Utc::now();
    let verified = EnforcementStatus::Verified {
        at,
        target: ProbeTarget::HostTls.label().to_owned(),
        generation: 4,
        accepted_with_certificate: true,
        rejected_without_certificate: true,
        fresh_until: at + FRESH_FOR,
    };
    assert!(verified.enforces());
    assert!(matches!(
        verified.clone().reconcile(5, at),
        EnforcementStatus::Stale {
            generation: 4,
            current_generation: 5,
            ..
        }
    ));
    assert!(matches!(
        verified.reconcile(4, at + FRESH_FOR + Duration::seconds(1)),
        EnforcementStatus::Stale { .. }
    ));
}

/// Accepting a certificate and refusing a caller without one are separate
/// facts; only both together are enforcement.
#[test]
fn one_half_of_the_probe_is_never_enforcement() {
    let at = Utc::now();
    let half = EnforcementStatus::Verified {
        at,
        target: "host-tls".to_owned(),
        generation: 1,
        accepted_with_certificate: true,
        rejected_without_certificate: false,
        fresh_until: at + FRESH_FOR,
    };
    assert!(!half.enforces());
}

/// The probe authorizes nothing, and the contract no longer says it does.
///
/// SW-SECURITY found `BindingPurpose::ServiceProbe` and the operation string
/// `transport.probe` advertised by the contract, answered by `requires_mtls`,
/// and consulted by nothing — an authority with no enforcement point. The
/// decision taken here is **removal**, for three reasons this test pins:
///
/// - the probe is an *outbound client only*. Nothing on any plane ever
///   receives a request under a probe purpose, so there is no place a
///   `require_service_caller(ServiceProbe, "transport.probe")` could stand;
/// - the one route it ever asks is `/health/live`, which must stay
///   unauthenticated — the probe's negative half *is* "connect with no
///   certificate and observe the refusal", and an admission check there would
///   make that half untestable and break ordinary liveness probing;
/// - the route that *starts* a probe, `POST /api/v1/operator/transport/verify`,
///   is configurator-gated: a human operator path. Requiring a service binding
///   there would make mTLS an alternate operator login, which this module's
///   own docs forbid (AUTHENTICATION-IS-NOT-AUTHORIZATION).
///
/// The match below is exhaustive on purpose: reintroducing a purpose arm
/// stops this file compiling until whoever added it names the receiver that
/// admits it.
#[test]
fn the_probe_advertises_no_authority_it_does_not_enforce() {
    use opensesame_domain::transport::{operations, BindingPurpose};

    /// Every advertised purpose, and the production receiver that admits it.
    const fn admission_receiver(purpose: BindingPurpose) -> &'static str {
        match purpose {
            // apps/gateway/src/routes/nats_callout_config.rs + nats_callout.rs
            BindingPurpose::NatsAuthBridge => "host: nats callout routes",
            // apps/worker/src/routes.rs (ServiceCaller::admit)
            BindingPurpose::WorkerClient => "worker: provider + readiness routes",
            // apps/control-plane mapping-auth.ts, via routes/principals.ts
            BindingPurpose::IdentityMappingClient => "identity: principal mapping",
            // crates/ingress-evidence layer + BindingSetAdmission
            BindingPurpose::TrustedIngress => "host: forwarded-evidence layer",
            // crates/connection-broker transport client identity
            BindingPurpose::UpstreamConnector => "broker: upstream connector invoke",
        }
    }
    for purpose in [
        BindingPurpose::NatsAuthBridge,
        BindingPurpose::WorkerClient,
        BindingPurpose::IdentityMappingClient,
        BindingPurpose::TrustedIngress,
        BindingPurpose::UpstreamConnector,
    ] {
        assert!(!admission_receiver(purpose).is_empty());
    }

    assert!(
        !operations::KNOWN.contains(&"transport.probe"),
        "`transport.probe` is back in the operation catalogue and needs an admission call site",
    );

    // The probe admits nobody and asks for exactly one route.
    let src = include_str!("probe.rs");
    assert!(!src.contains("require_service_caller"));
    assert!(!src.contains("require_delegated_caller"));
    assert!(!src.contains("BindingPurpose"));
    assert_eq!(PROBE_PATH, "/health/live");

    // And `requires_mtls` has no probe arm left to answer with.
    assert!(!include_str!("config.rs").contains("ServiceProbe"));
}
