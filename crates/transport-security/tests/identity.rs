//! `TlsIdentity` load-time rules: AT-TLS-WRONGKEY (configuration side),
//! AT-TLS-TIME boundaries at load, CA-as-identity refusal, unsupported
//! critical extensions, selectors, and key redaction.

use std::sync::{Arc, Mutex};

use chrono::{Duration, Utc};
use opensesame_domain::transport::{PeerIdentitySelector, TransportError};
use opensesame_transport_security::testkit::{DisposableCa, KeyAlgorithm, LeafSpec, SanEntry};
use opensesame_transport_security::{SecretBytes, TlsIdentity};
use secrecy::ExposeSecret;

#[test]
fn valid_leaf_loads_with_selectors_and_thumbprint() {
    let ca = DisposableCa::new("root");
    let leaf = ca.issue_with(&LeafSpec::client(vec![
        SanEntry::Dns("Worker-1.Internal".into()),
        SanEntry::Uri("urn:opensesame:worker:1".into()),
        SanEntry::Email("nobody@example.invalid".into()),
    ]));
    let identity = leaf.identity();
    assert_eq!(identity.leaf_thumbprint_sha256(), leaf.thumbprint);
    assert_eq!(identity.dns_names(), ["worker-1.internal"]);
    assert!(identity.spiffe_id().is_none());
    assert_eq!(
        identity.selectors(),
        [
            PeerIdentitySelector::DnsName("worker-1.internal".into()),
            PeerIdentitySelector::UriSan("urn:opensesame:worker:1".into()),
            PeerIdentitySelector::LeafThumbprintSha256(leaf.thumbprint.clone()),
        ]
    );
    assert!(identity.usage().permits_client_auth());
    assert!(!identity.usage().permits_server_auth());
}

#[test]
fn spiffe_leaf_exposes_exactly_one_spiffe_id() {
    let ca = DisposableCa::new("root");
    let one = ca
        .issue_spiffe("spiffe://example.org/ns/default/sa/host")
        .identity();
    assert_eq!(
        one.spiffe_id(),
        Some("spiffe://example.org/ns/default/sa/host")
    );
    assert_eq!(
        one.selectors()[0],
        PeerIdentitySelector::SpiffeId("spiffe://example.org/ns/default/sa/host".into())
    );

    let mut two = LeafSpec::spiffe("spiffe://example.org/a");
    two.sans
        .push(SanEntry::Uri("spiffe://example.org/b".into()));
    let two = ca.issue_with(&two).identity();
    assert_eq!(two.spiffe_id(), None, "two SPIFFE URIs is not an SVID");
    assert!(two.selectors().iter().all(|s| !matches!(
        s,
        PeerIdentitySelector::SpiffeId(_) | PeerIdentitySelector::UriSan(_)
    )));
    assert_eq!(two.uri_sans().len(), 2);
}

#[test]
fn every_supported_key_algorithm_proves_possession() {
    let ca = DisposableCa::new("root");
    for key in [
        KeyAlgorithm::EcdsaP256,
        KeyAlgorithm::EcdsaP384,
        KeyAlgorithm::Ed25519,
        KeyAlgorithm::Rsa2048,
    ] {
        let leaf = ca.issue_with(&LeafSpec::client(vec![]).with_key(key));
        assert!(leaf.try_identity().is_ok(), "{key:?} loads");
    }
}

#[test]
fn wrong_key_is_key_pair_mismatch() {
    let ca = DisposableCa::new("root");
    let a = ca.issue_client(PeerIdentitySelector::DnsName("a.internal".into()));
    let b = ca.issue_client(PeerIdentitySelector::DnsName("b.internal".into()));
    assert_eq!(
        a.with_other_key(&b).try_identity().unwrap_err(),
        TransportError::KeyPairMismatch
    );
    // Different algorithm entirely.
    let rsa = ca.issue_with(&LeafSpec::client(vec![]).with_key(KeyAlgorithm::Rsa2048));
    assert_eq!(
        a.with_other_key(&rsa).try_identity().unwrap_err(),
        TransportError::KeyPairMismatch
    );
    let ed = ca.issue_with(&LeafSpec::client(vec![]).with_key(KeyAlgorithm::Ed25519));
    assert_eq!(
        a.with_other_key(&ed).try_identity().unwrap_err(),
        TransportError::KeyPairMismatch
    );
}

#[test]
fn ca_certificate_is_not_an_identity() {
    let ca = DisposableCa::new("root");
    let mut spec = LeafSpec::client(vec![]);
    spec.is_ca = true;
    let err = ca.issue_with(&spec).try_identity().unwrap_err();
    assert_eq!(err.code(), "malformed_configuration");
    assert!(err.to_string().contains("CA"), "{err}");
}

#[test]
fn expired_and_not_yet_valid_are_refused_with_boundary_seconds() {
    let ca = DisposableCa::new("root");
    let now = Utc::now();
    let expired = ca.issue_with(
        &LeafSpec::client(vec![])
            .valid_between(now - Duration::hours(2), now - Duration::seconds(2)),
    );
    assert_eq!(
        expired.try_identity().unwrap_err(),
        TransportError::EvidenceExpired
    );
    let future = ca.issue_with(
        &LeafSpec::client(vec![])
            .valid_between(now + Duration::seconds(5), now + Duration::hours(1)),
    );
    assert_eq!(
        future.try_identity().unwrap_err().code(),
        "malformed_configuration"
    );
    // Still valid for a few seconds: loads; the remaining window is honored.
    let edge = ca.issue_with(
        &LeafSpec::client(vec![])
            .valid_between(now - Duration::hours(1), now + Duration::seconds(30)),
    );
    let identity = edge.identity();
    assert!(identity.not_after() - now <= Duration::seconds(31));
    assert!(identity.is_valid_at(now));
    assert!(!identity.is_valid_at(now + Duration::seconds(31)));
}

#[test]
fn unsupported_critical_extension_is_refused() {
    let ca = DisposableCa::new("root");
    let mut spec = LeafSpec::client(vec![]);
    spec.unknown_critical_extension = true;
    let err = ca.issue_with(&spec).try_identity().unwrap_err();
    assert!(err.to_string().contains("critical extension"), "{err}");
}

#[test]
fn malformed_pem_is_refused_without_panicking() {
    let key = SecretBytes::new(Box::new(b"not a key".to_vec()));
    assert_eq!(
        TlsIdentity::from_pem(b"garbage", &key).unwrap_err().code(),
        "malformed_configuration"
    );
    let ca = DisposableCa::new("root");
    let leaf = ca.issue_client(PeerIdentitySelector::DnsName("a.internal".into()));
    assert_eq!(
        TlsIdentity::from_pem(&leaf.cert_pem, &key)
            .unwrap_err()
            .code(),
        "malformed_configuration"
    );
    assert_eq!(
        TlsIdentity::from_pem(b"", &leaf.key_secret())
            .unwrap_err()
            .code(),
        "malformed_configuration"
    );
}

#[test]
fn chain_deeper_than_bound_is_refused_at_load() {
    let root = DisposableCa::new("root");
    let mut ca = root.intermediate("i1");
    for name in ["i2", "i3", "i4", "i5"] {
        ca = ca.intermediate(name);
    }
    let leaf = ca.issue_client(PeerIdentitySelector::DnsName("deep.internal".into()));
    let err = leaf.try_identity().unwrap_err();
    assert!(err.to_string().contains("exceeds"), "{err}");
}

#[derive(Clone, Default)]
struct Sink(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Sink {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[test]
fn debug_and_tracing_never_contain_the_private_key() {
    let ca = DisposableCa::new("root");
    let leaf = ca.issue_client(PeerIdentitySelector::DnsName("a.internal".into()));
    let identity = leaf.identity();
    let key_pem = String::from_utf8(leaf.key_pem.expose_secret().clone()).unwrap();
    let key_body: String = key_pem
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .collect();
    assert!(key_body.len() > 40);

    let debug = format!("{identity:?}");
    assert!(!debug.contains("PRIVATE KEY"));
    assert!(!debug.contains(&key_body[..32]));
    assert!(debug.contains("<redacted>"));

    let sink = Sink::default();
    let writer = sink.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(move || writer.clone())
        .with_ansi(false)
        .finish();
    tracing::subscriber::with_default(subscriber, || {
        tracing::info!(identity = ?identity, thumbprint = %identity.leaf_thumbprint_sha256(), "loaded identity");
    });
    let logged = String::from_utf8(sink.0.lock().unwrap().clone()).unwrap();
    assert!(logged.contains("loaded identity"));
    assert!(!logged.contains("PRIVATE KEY"));
    assert!(!logged.contains(&key_body[..32]));
    assert!(!format!("{leaf:?}").contains(&key_body[..32]));
}
