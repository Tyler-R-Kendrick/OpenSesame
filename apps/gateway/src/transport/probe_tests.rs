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
