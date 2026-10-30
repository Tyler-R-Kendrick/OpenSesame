//! Canonical sources cannot be selected by a password, port or forged header.
use super::*;
use crate::transport::test_support::{forwarded, peer, THUMB_A, THUMB_B};
use opensesame_domain::transport::attest::AttestedPeer;
use std::sync::Arc;

fn socket(address: &str) -> Extensions {
    let mut extensions = Extensions::new();
    extensions.insert(ConnectInfo(address.parse::<SocketAddr>().unwrap()));
    extensions
}

fn ingress() -> opensesame_domain::transport::VerifiedPeer {
    let direct = peer("edge.test", THUMB_A, 1);
    AttestedPeer {
        source: EvidenceSource::DirectTls,
        identities: direct.identities().to_vec(),
        leaf_thumbprint_sha256: THUMB_A.into(),
        not_before: direct.not_before(),
        not_after: direct.not_after(),
        trust_profile: direct.trust_profile().clone(),
        trust_generation: 1,
        credential_generation: 1,
        listener: direct.listener().into(),
        policy: TransportPolicy::TrustedIngress,
        tls_version: direct.tls_version(),
        authenticated_at: direct.authenticated_at(),
        usable_until: direct.usable_until(),
        ingress: None,
    }
    .into_verified()
    .unwrap()
}

#[test]
fn ports_mapped_ipv4_and_ipv6_interface_rotation_do_not_mint_sources() {
    assert_eq!(
        source(&socket("192.0.2.1:1000")).unwrap(),
        source(&socket("192.0.2.1:2000")).unwrap()
    );
    assert_eq!(
        source(&socket("192.0.2.1:1000")).unwrap(),
        source(&socket("[::ffff:192.0.2.1]:2000")).unwrap()
    );
    assert_eq!(
        source(&socket("[2001:db8:1:2::1]:1000")).unwrap(),
        source(&socket("[2001:db8:1:2:ffff::99]:2000")).unwrap()
    );
    assert_ne!(
        source(&socket("[2001:db8:1:2::1]:1000")).unwrap(),
        source(&socket("[2001:db8:1:3::1]:1000")).unwrap()
    );
    assert_ne!(
        source(&socket("192.0.2.1:1000")).unwrap(),
        source(&socket("192.0.2.2:1000")).unwrap()
    );
}

#[test]
fn missing_invalid_or_proxy_only_evidence_never_uses_a_shared_fallback() {
    for extensions in [
        Extensions::new(),
        socket("0.0.0.0:1000"),
        socket("[::]:1000"),
        socket("224.0.0.1:1000"),
    ] {
        assert_eq!(
            source(&extensions).unwrap_err().status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }
    let mut extensions = socket("192.0.2.1:1000");
    extensions.insert(PeerExtension(Arc::new(ingress())));
    assert_eq!(
        source(&extensions).unwrap_err().status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
}

#[test]
fn verified_originating_clients_are_separate_behind_one_proxy() {
    let proxy = ingress();
    let mut first = socket("192.0.2.1:1000");
    first.insert(PeerExtension(Arc::new(proxy.clone())));
    first.insert(OriginatingPeerExtension(Arc::new(forwarded(
        "first.test",
        THUMB_A,
        &proxy,
    ))));
    let mut second = first.clone();
    second.insert(OriginatingPeerExtension(Arc::new(forwarded(
        "second.test",
        THUMB_B,
        &proxy,
    ))));
    assert_ne!(source(&first).unwrap(), source(&second).unwrap());
    second.remove::<PeerExtension>();
    assert_eq!(
        source(&second).unwrap_err().status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    first.insert(OriginatingPeerExtension(Arc::new(peer(
        "fake.test",
        THUMB_A,
        1,
    ))));
    assert_eq!(
        source(&first).unwrap_err().status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
}
