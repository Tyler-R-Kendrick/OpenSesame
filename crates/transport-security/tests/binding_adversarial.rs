//! SEC-IDENTITIES (policy half) — nothing falls back to accepting the text
//! on a certificate.
//!
//! The handshake half lives in `identity_adversarial.rs`. These are the
//! pure binding-resolution properties that must hold for *every* peer whose
//! certificate is perfectly valid: default deny, exact match on all four of
//! (scope, trust profile, peer selector, purpose), and no path by which the
//! service principal — a public string on a status page — becomes an input.
//!
//! Acceptance: AT-TLS-FAKECONTEXT, AT-AUTHORITY-CROSSTENANT (policy layer),
//! AT-CUSTODY-BOOTSTRAP (the "same root is not the same service" half).

mod common;

use common::{profile_ref, CLIENTS};
use opensesame_domain::transport::{
    BindingPurpose, BindingScope, PeerIdentitySelector, ServiceBinding, ServiceBindingSet,
    TransportError,
};

fn binding(peer: PeerIdentitySelector, principal: &str) -> ServiceBinding {
    ServiceBinding {
        id: "bridge".into(),
        revision: 1,
        enabled: true,
        revoked: false,
        scope: BindingScope::Deployment,
        trust_profile: profile_ref(CLIENTS),
        peer,
        service_principal: principal.into(),
        purpose: BindingPurpose::NatsAuthBridge,
        allowed_operations: vec!["nats.callout.decide".into()],
        allowed_audiences: Vec::new(),
        not_after: None,
        denied_thumbprints: Vec::new(),
    }
}

/// A certificate whose SAN text is literally the *service principal* of a
/// binding — the string an attacker would read off a status page — resolves
/// to nothing. The principal is an output of binding resolution, never an
/// input to it.
#[test]
fn a_san_matching_a_binding_principal_is_not_that_principal() {
    let set = ServiceBindingSet {
        revision: 1,
        bindings: vec![binding(
            PeerIdentitySelector::DnsName("bridge.internal".into()),
            "nats-bridge",
        )],
    };
    set.validate().expect("fixture is a valid set");
    let presented = vec![PeerIdentitySelector::DnsName("nats-bridge".into())];
    assert_eq!(
        set.resolve(
            &profile_ref(CLIENTS),
            &presented,
            BindingPurpose::NatsAuthBridge,
            chrono::Utc::now(),
        )
        .unwrap_err(),
        TransportError::PeerNotBound
    );
}

/// The default-deny property stated as a loop rather than one example: for
/// every selector kind, a peer holding a perfectly valid certificate that
/// the administrator did not name is not bound. There is no "same root
/// therefore same service" path.
#[test]
fn no_selector_kind_has_an_accept_any_fallback() {
    let set = ServiceBindingSet {
        revision: 1,
        bindings: vec![binding(
            PeerIdentitySelector::SpiffeId("spiffe://prod.example/bridge".into()),
            "nats-bridge",
        )],
    };
    for presented in [
        PeerIdentitySelector::SpiffeId("spiffe://prod.example/bridge2".into()),
        PeerIdentitySelector::SpiffeId("spiffe://prod2.example/bridge".into()),
        PeerIdentitySelector::DnsName("bridge.internal".into()),
        PeerIdentitySelector::UriSan("https://prod.example/bridge".into()),
        PeerIdentitySelector::LeafThumbprintSha256("aa".repeat(32)),
    ] {
        assert_eq!(
            set.resolve(
                &profile_ref(CLIENTS),
                std::slice::from_ref(&presented),
                BindingPurpose::NatsAuthBridge,
                chrono::Utc::now(),
            )
            .unwrap_err(),
            TransportError::PeerNotBound,
            "{presented:?} resolved against a binding that does not name it"
        );
    }
}

/// A peer bound for one purpose is not bound for another, and a peer bound
/// under one trust profile is not bound under another. Both are the same
/// "authentication is not authorization" rule.
#[test]
fn purpose_and_trust_profile_are_both_part_of_the_match() {
    let peer = PeerIdentitySelector::DnsName("bridge.internal".into());
    let set = ServiceBindingSet {
        revision: 1,
        bindings: vec![binding(peer.clone(), "nats-bridge")],
    };
    let presented = [peer];
    let now = chrono::Utc::now();
    assert_eq!(
        set.resolve(
            &profile_ref(CLIENTS),
            &presented,
            BindingPurpose::WorkerClient,
            now
        )
        .unwrap_err(),
        TransportError::PeerNotBound
    );
    assert_eq!(
        set.resolve(
            &profile_ref("other-roots"),
            &presented,
            BindingPurpose::NatsAuthBridge,
            now
        )
        .unwrap_err(),
        TransportError::PeerNotBound
    );
}

/// An organization-scoped binding never satisfies a deployment lookup, and a
/// deployment binding never carries tenant authority (AT-AUTHORITY-CROSSTENANT
/// at the policy layer).
#[test]
fn scopes_do_not_satisfy_one_another() {
    let peer = PeerIdentitySelector::DnsName("bridge.internal".into());
    let mut org = binding(peer.clone(), "nats-bridge");
    org.scope = BindingScope::Organization {
        organization_id: "org-a".into(),
    };
    let set = ServiceBindingSet {
        revision: 1,
        bindings: vec![org],
    };
    set.validate().expect("valid");
    let presented = [peer];
    let now = chrono::Utc::now();
    assert_eq!(
        set.resolve(
            &profile_ref(CLIENTS),
            &presented,
            BindingPurpose::NatsAuthBridge,
            now
        )
        .unwrap_err(),
        TransportError::PeerNotBound
    );
    assert_eq!(
        set.resolve_scoped(
            &BindingScope::Organization {
                organization_id: "org-b".into()
            },
            &profile_ref(CLIENTS),
            &presented,
            BindingPurpose::NatsAuthBridge,
            now
        )
        .unwrap_err(),
        TransportError::PeerNotBound
    );
}
