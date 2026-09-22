//! Shared fixtures for the transport tests.
//!
//! Everything disposable: a fresh CA per test in a `tempfile` directory that
//! is deleted on drop, and evidence built through the one privileged
//! constructor (`AttestedPeer::into_verified`) so the tests exercise the same
//! validation a real verifier does.

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::{Arc, RwLock};

use chrono::{Duration, Utc};
use opensesame_domain::transport::attest::AttestedPeer;
use opensesame_domain::transport::{
    BindingPurpose, BindingScope, EvidenceSource, PeerIdentitySelector, ServiceBinding,
    ServiceBindingSet, TlsVersion, TransportPolicy, TrustProfileRef, VerifiedPeer,
};
use opensesame_transport_security::env::{NativeIdentitySpec, NativeTrustSpec};
use opensesame_transport_security::{GenerationCandidate, TransportGenerations};

use super::bindings::BindingsSource;
use super::config::{AuthMode, ListenerConfig, TransportConfig};
use super::status::TransportFacts;
use super::TransportRuntime;

pub const TRUST_PROFILE: &str = "client_ca";
pub const THUMB_A: &str = "aa00000000000000000000000000000000000000000000000000000000000001";
pub const THUMB_B: &str = "bb00000000000000000000000000000000000000000000000000000000000002";

#[must_use]
pub fn profile() -> TrustProfileRef {
    TrustProfileRef::new(TRUST_PROFILE).expect("profile name")
}

/// A directly authenticated TLS peer on the Host's secure listener.
#[must_use]
pub fn peer(dns: &str, thumbprint: &str, generation: u64) -> VerifiedPeer {
    let now = Utc::now();
    AttestedPeer {
        source: EvidenceSource::DirectTls,
        identities: vec![PeerIdentitySelector::DnsName(dns.to_owned())],
        leaf_thumbprint_sha256: thumbprint.to_owned(),
        not_before: now - Duration::minutes(5),
        not_after: now + Duration::hours(1),
        trust_profile: profile(),
        trust_generation: generation,
        credential_generation: generation,
        listener: super::HOST_TLS_LISTENER.to_owned(),
        policy: TransportPolicy::MtlsRequired,
        tls_version: TlsVersion::Tls13,
        authenticated_at: now,
        usable_until: now + Duration::minutes(5),
        ingress: None,
    }
    .into_verified()
    .expect("attested peer")
}

/// An originating client forwarded by an authenticated ingress.
#[must_use]
pub fn forwarded(client_dns: &str, client_thumb: &str, ingress: &VerifiedPeer) -> VerifiedPeer {
    let now = Utc::now();
    AttestedPeer {
        source: EvidenceSource::TrustedIngressAssertion,
        identities: vec![PeerIdentitySelector::DnsName(client_dns.to_owned())],
        leaf_thumbprint_sha256: client_thumb.to_owned(),
        not_before: now - Duration::minutes(5),
        not_after: now + Duration::hours(1),
        trust_profile: profile(),
        trust_generation: ingress.trust_generation(),
        credential_generation: ingress.credential_generation(),
        listener: super::HOST_TLS_LISTENER.to_owned(),
        policy: TransportPolicy::TrustedIngress,
        tls_version: TlsVersion::Tls13,
        authenticated_at: now,
        usable_until: now + Duration::minutes(5),
        ingress: Some(Box::new(ingress_attestation(ingress))),
    }
    .into_verified()
    .expect("forwarded evidence")
}

fn ingress_attestation(peer: &VerifiedPeer) -> AttestedPeer {
    AttestedPeer {
        source: EvidenceSource::DirectTls,
        identities: peer.identities().to_vec(),
        leaf_thumbprint_sha256: peer.leaf_thumbprint_sha256().to_owned(),
        not_before: peer.not_before(),
        not_after: peer.not_after(),
        trust_profile: peer.trust_profile().clone(),
        trust_generation: peer.trust_generation(),
        credential_generation: peer.credential_generation(),
        listener: peer.listener().to_owned(),
        policy: TransportPolicy::TrustedIngress,
        tls_version: peer.tls_version(),
        authenticated_at: peer.authenticated_at(),
        usable_until: peer.usable_until(),
        ingress: None,
    }
}

/// One live binding for `dns` at the given purpose and operations.
#[must_use]
pub fn binding(
    id: &str,
    dns: &str,
    purpose: BindingPurpose,
    operations: &[&str],
    scope: BindingScope,
) -> ServiceBinding {
    ServiceBinding {
        id: id.to_owned(),
        revision: 1,
        enabled: true,
        revoked: false,
        scope,
        trust_profile: profile(),
        peer: PeerIdentitySelector::DnsName(dns.to_owned()),
        service_principal: "svc:bridge".to_owned(),
        purpose,
        allowed_operations: operations.iter().map(|o| (*o).to_owned()).collect(),
        allowed_audiences: vec!["host".to_owned()],
        not_after: None,
        denied_thumbprints: Vec::new(),
    }
}

#[must_use]
pub fn set(bindings: Vec<ServiceBinding>) -> ServiceBindingSet {
    ServiceBindingSet {
        revision: 1,
        bindings,
    }
}

/// A configuration with an `mtls_required` listener that names files nothing
/// ever reads: the runtime under test is assembled directly.
#[must_use]
pub fn mtls_config() -> TransportConfig {
    TransportConfig {
        listener: Some(ListenerConfig {
            listen: "127.0.0.1:0".parse::<SocketAddr>().expect("addr"),
            policy: TransportPolicy::MtlsRequired,
            identity: NativeIdentitySpec::PemFiles {
                cert: "/nonexistent/cert.pem".into(),
                key: "/nonexistent/key.pem".into(),
            },
            client_trust: Some(NativeTrustSpec::PemFile {
                path: "/nonexistent/ca.pem".into(),
                kind: opensesame_domain::transport::TrustProfileKind::PrivateRoot,
            }),
            client_trust_profile: profile(),
            crl_file: None,
            min_version: TlsVersion::Tls13,
            ingress_originating_trust_file: None,
        }),
        service_bindings_file: None,
        mapping_auth: AuthMode::Unconfigured,
        mapping_tls: None,
        callout_auth: AuthMode::Mtls,
        spiffe_endpoint_socket: None,
    }
}

/// A runtime holding `bindings` at generation `generation`, with no listener
/// actually bound.
#[must_use]
pub fn runtime(bindings: ServiceBindingSet, generation: u64) -> Arc<TransportRuntime> {
    let initial = GenerationCandidate {
        identity: None,
        peer_trust: BTreeMap::new(),
        own_trust: None,
        identity_required: false,
    }
    .into_generation(generation, Utc::now())
    .expect("generation");
    let config = mtls_config();
    Arc::new(TransportRuntime {
        generations: TransportGenerations::new(initial),
        bindings: Arc::new(RwLock::new(bindings)),
        bindings_source: BindingsSource::Default,
        policy: TransportPolicy::MtlsRequired,
        listen: config.listener.as_ref().map(|l| l.listen),
        listener_id: super::HOST_TLS_LISTENER.to_owned(),
        client_trust_profile: profile(),
        status: Arc::new(RwLock::new(TransportFacts::default())),
        mapping_auth: config.mapping_auth,
        callout_auth: config.callout_auth,
        config,
        ingress_layer: None,
        spiffe: None,
    })
}

/// Request extensions as the secure listener would stamp them.
#[must_use]
pub fn tls_extensions(peer: &VerifiedPeer, generation: u64) -> axum::http::Extensions {
    let mut extensions = axum::http::Extensions::new();
    extensions.insert(opensesame_transport_security::ListenerProvenance::Tls {
        listener_id: super::HOST_TLS_LISTENER.to_owned(),
        policy: TransportPolicy::MtlsRequired,
        generation,
    });
    extensions.insert(opensesame_transport_security::PeerExtension(Arc::new(
        peer.clone(),
    )));
    extensions
}

/// Request extensions as the plain listener would stamp them.
#[must_use]
pub fn plain_extensions() -> axum::http::Extensions {
    let mut extensions = axum::http::Extensions::new();
    extensions.insert(opensesame_transport_security::ListenerProvenance::Plain {
        listener_id: super::HOST_PLAIN_LISTENER.to_owned(),
    });
    extensions
}

/// A lookup over an explicit map; no test ever touches the process
/// environment. The *last* entry for a name wins, so a case can append an
/// override to a base set.
#[must_use]
pub fn lookup(pairs: Vec<(&'static str, String)>) -> impl Fn(&str) -> Option<String> + Clone {
    move |name: &str| {
        pairs
            .iter()
            .rev()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| value.clone())
    }
}
