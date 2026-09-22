//! SEC-IDENTITIES — valid-but-unauthorized leaves, not only invalid ones.
//!
//! Every certificate here is issued by the listener's *own* trusted client
//! CA, so the chain is genuinely good and the handshake has no reason to
//! fail. What is under test is the next question: which identity the peer
//! gets to claim from such a certificate. The assertion is always the same
//! shape — the selectors the listener attested are exactly the ones the
//! contract allows, and nothing anywhere falls back to accepting whatever
//! text the subject or the SAN list happens to contain.
//!
//! Acceptance: AT-TLS-BADCHAIN (the refusal half), AT-SPIFFE-SAN,
//! AT-TLS-FAKECONTEXT (the certificate-text half).

mod common;
#[path = "common/reject.rs"]
mod reject;

use common::*;
use opensesame_domain::transport::PeerIdentitySelector;
use opensesame_transport_security::testkit::{IssuedLeaf, KeyAlgorithm, LeafSpec, SanEntry};
use reject::*;
use serde_json::Value;

/// Handshake with `leaf` and return the selectors the listener attested.
/// Fails the test if the handshake itself was refused — these fixtures are
/// deliberately *acceptable* chains.
async fn attested_selectors(stack: &Stack, leaf: &IssuedLeaf) -> Vec<String> {
    let config = raw_client(stack, leaf).expect("client config");
    let (status, body) = raw_get(config, stack.served.addr, localhost(), "/whoami")
        .await
        .expect("handshake should succeed: the chain is valid");
    assert_eq!(status, 200, "{body}");
    let json: Value = serde_json::from_str(&body).expect("whoami json");
    json["peer"]["identities"]
        .as_array()
        .expect("identities")
        .iter()
        .map(|selector| {
            let object = selector.as_object().expect("tagged selector");
            let (kind, value) = object.iter().next().expect("one tag");
            format!("{kind}={}", value.as_str().unwrap_or_default())
        })
        .collect()
}

fn thumbprint_only(selectors: &[String], leaf: &IssuedLeaf) -> bool {
    selectors == [format!("leaf_thumbprint_sha256={}", leaf.thumbprint)]
}

fn client_spec(sans: Vec<SanEntry>) -> LeafSpec {
    LeafSpec::client(sans)
}

// ---------------------------------------------------------------------------
// Subject and SAN text that must never become an identity
// ---------------------------------------------------------------------------

/// A genuinely issued client certificate whose *common name* is the string
/// an operator might have bound. CN is not a selector anywhere, so the peer
/// arrives with its thumbprint and nothing else.
#[tokio::test]
async fn attacker_controlled_common_name_is_not_an_identity() {
    let stack = stack().await;
    let mut spec = client_spec(Vec::new());
    spec.common_name = "spiffe://prod.example/admin".into();
    let leaf = stack.client_ca.issue_with(&spec);
    let selectors = attested_selectors(&stack, &leaf).await;
    assert!(
        thumbprint_only(&selectors, &leaf),
        "CN leaked into the identity: {selectors:?}"
    );
}

/// An `rfc822Name` SAN is an address, not a service. It must not appear.
#[tokio::test]
async fn email_san_never_becomes_a_selector() {
    let stack = stack().await;
    let leaf = stack.client_ca.issue_with(&client_spec(vec![
        SanEntry::Email("admin@corp.example".into()),
        SanEntry::Dns("bridge.internal".into()),
    ]));
    let selectors = attested_selectors(&stack, &leaf).await;
    assert!(
        selectors.iter().all(|s| !s.contains('@')),
        "email SAN became an identity: {selectors:?}"
    );
    assert!(selectors.contains(&"dns_name=bridge.internal".to_owned()));
}

/// An IP SAN is not a reference identity.
#[tokio::test]
async fn ip_san_never_becomes_a_selector() {
    let stack = stack().await;
    let leaf = stack.client_ca.issue_with(&client_spec(vec![SanEntry::Ip(
        "10.0.0.7".parse().unwrap(),
    )]));
    let selectors = attested_selectors(&stack, &leaf).await;
    assert!(
        thumbprint_only(&selectors, &leaf),
        "IP SAN became an identity: {selectors:?}"
    );
}

/// Wildcards, trailing dots and uppercase are each handled the same way:
/// the name is not a reference identity, so it is dropped rather than
/// normalized into one. Uppercase is the exception the DNS standard makes —
/// it is case-folded, not dropped — and that is asserted explicitly so a
/// future change to the folding rule is visible.
#[tokio::test]
async fn wildcard_and_trailing_dot_names_are_dropped_and_case_is_folded() {
    let stack = stack().await;
    let leaf = stack.client_ca.issue_with(&client_spec(vec![
        SanEntry::Dns("*.internal".into()),
        SanEntry::Dns("bridge.internal.".into()),
        SanEntry::Dns("BRIDGE.Internal".into()),
    ]));
    let selectors = attested_selectors(&stack, &leaf).await;
    assert!(
        !selectors.iter().any(|s| s.contains('*')),
        "wildcard survived: {selectors:?}"
    );
    assert!(
        !selectors.iter().any(|s| s.ends_with("internal.")),
        "trailing dot survived: {selectors:?}"
    );
    assert!(
        selectors.contains(&"dns_name=bridge.internal".to_owned()),
        "case folding changed: {selectors:?}"
    );
}

/// Two SPIFFE URI SANs are an ambiguous SVID. The contract is that no
/// SPIFFE identity is derived at all — not that the first one wins.
#[tokio::test]
async fn conflicting_spiffe_sans_yield_no_spiffe_identity() {
    let stack = stack().await;
    let leaf = stack.client_ca.issue_with(&client_spec(vec![
        SanEntry::Uri("spiffe://prod.example/bridge".into()),
        SanEntry::Uri("spiffe://prod.example/admin".into()),
    ]));
    let selectors = attested_selectors(&stack, &leaf).await;
    assert!(
        thumbprint_only(&selectors, &leaf),
        "one of two SPIFFE SANs was picked: {selectors:?}"
    );
}

/// A single SPIFFE SAN plus an unrelated URI SAN: the SPIFFE ID is still
/// exactly one, and the extra URI is a separate exact selector, never
/// merged into the SPIFFE one.
#[tokio::test]
async fn an_extra_uri_san_does_not_widen_the_spiffe_identity() {
    let stack = stack().await;
    let leaf = stack.client_ca.issue_with(&client_spec(vec![
        SanEntry::Uri("spiffe://prod.example/bridge".into()),
        SanEntry::Uri("https://prod.example/admin".into()),
    ]));
    let selectors = attested_selectors(&stack, &leaf).await;
    assert!(selectors.contains(&"spiffe_id=spiffe://prod.example/bridge".to_owned()));
    assert!(selectors.contains(&"uri_san=https://prod.example/admin".to_owned()));
    assert!(!selectors.contains(&"spiffe_id=https://prod.example/admin".to_owned()));
}

/// Encodings that look like a different SPIFFE ID to a lenient reader:
/// percent-encoded separators, an uppercase trust domain, a dot-dot segment,
/// a query and a fragment. None of them is a SPIFFE selector, and none of
/// them is silently downgraded to a plain URI selector either (the `spiffe`
/// scheme is refused by `uri_san`).
#[tokio::test]
async fn percent_encoded_and_confusable_spiffe_ids_are_not_identities() {
    let stack = stack().await;
    for hostile in [
        "spiffe://prod.example/%2e%2e/admin",
        "spiffe://prod.example/bridge%2fadmin",
        "spiffe://PROD.example/bridge",
        "spiffe://prod.example/bridge?as=admin",
        "spiffe://prod.example/bridge#admin",
        "spiffe://prod.example/../admin",
        "spiffe://prod.example",
    ] {
        let leaf = stack
            .client_ca
            .issue_with(&client_spec(vec![SanEntry::Uri(hostile.into())]));
        let selectors = attested_selectors(&stack, &leaf).await;
        assert!(
            thumbprint_only(&selectors, &leaf),
            "{hostile} became an identity: {selectors:?}"
        );
    }
}

/// Non-ASCII and NUL cannot even be encoded as an `IA5String` SAN, so they are
/// asserted at the selector boundary the attested identities pass through.
/// A confusable Cyrillic host and an embedded NUL are both refused.
#[test]
fn unicode_and_nul_are_refused_by_the_selector_validator() {
    for hostile in [
        "prоd.example",            // Cyrillic \u{43e}
        "bridge\u{0}.internal",    // embedded NUL
        "bridge\u{200b}.internal", // zero-width space
    ] {
        assert!(
            PeerIdentitySelector::DnsName(hostile.to_owned())
                .validate()
                .is_err(),
            "{hostile:?} accepted as a DNS selector"
        );
    }
    for hostile in [
        "spiffe://prоd.example/bridge",
        "spiffe://prod.example/brid\u{0}ge",
    ] {
        assert!(
            PeerIdentitySelector::SpiffeId(hostile.to_owned())
                .validate()
                .is_err(),
            "{hostile:?} accepted as a SPIFFE selector"
        );
    }
}

/// A SAN longer than the selector ceiling is dropped, not truncated.
#[tokio::test]
async fn oversized_sans_are_dropped_not_truncated() {
    let stack = stack().await;
    let long = format!("https://prod.example/{}", "a".repeat(2100));
    let leaf = stack
        .client_ca
        .issue_with(&client_spec(vec![SanEntry::Uri(long)]));
    let selectors = attested_selectors(&stack, &leaf).await;
    assert!(
        thumbprint_only(&selectors, &leaf),
        "oversized SAN survived: {selectors:?}"
    );
}

/// Identical repeated SANs must collapse to one selector rather than
/// producing a duplicate that `AttestedPeer` would refuse outright — a
/// certificate an operator can legitimately be handed must not become an
/// un-servable peer, and must not count twice.
#[tokio::test]
async fn duplicate_identical_sans_collapse_to_one_selector() {
    let stack = stack().await;
    let leaf = stack.client_ca.issue_with(&client_spec(vec![
        SanEntry::Dns("bridge.internal".into()),
        SanEntry::Dns("bridge.internal".into()),
    ]));
    let selectors = attested_selectors(&stack, &leaf).await;
    assert_eq!(
        selectors
            .iter()
            .filter(|s| *s == "dns_name=bridge.internal")
            .count(),
        1,
        "{selectors:?}"
    );
}

// ---------------------------------------------------------------------------
// Certificates the real verifier must refuse outright
// ---------------------------------------------------------------------------

/// A CA certificate offered as a client leaf. The chain is signed by the
/// trusted root, so only `basicConstraints` refuses it.
#[tokio::test]
async fn a_ca_certificate_offered_as_a_leaf_is_refused() {
    let stack = stack().await;
    let mut spec = client_spec(vec![SanEntry::Dns("bridge.internal".into())]);
    spec.is_ca = true;
    let leaf = stack.client_ca.issue_with(&spec);
    let config = raw_client(&stack, &leaf).expect("client config");
    expect_refused(&stack, config, "CA used as an end entity").await;
}

/// `serverAuth`-only EKU cannot authenticate a client, even from the right
/// CA with the right name.
#[tokio::test]
async fn a_server_only_leaf_cannot_authenticate_a_client() {
    let stack = stack().await;
    let mut spec = client_spec(vec![SanEntry::Dns("bridge.internal".into())]);
    spec.client_auth = false;
    spec.server_auth = true;
    let leaf = stack.client_ca.issue_with(&spec);
    let config = raw_client(&stack, &leaf).expect("client config");
    expect_refused(&stack, config, "serverAuth-only EKU").await;
}

/// A critical extension the verifier does not understand is refused however
/// good the chain is. rustls refuses such a certificate on *both* sides, so
/// the assertion is that it can never be put on the wire at all: the
/// identity loader refuses it, and rustls's own client builder refuses it,
/// for every key algorithm the testkit can issue.
#[tokio::test]
async fn an_unknown_critical_extension_can_never_be_presented() {
    let stack = stack().await;
    for algorithm in [
        KeyAlgorithm::EcdsaP256,
        KeyAlgorithm::EcdsaP384,
        KeyAlgorithm::Ed25519,
    ] {
        let mut spec =
            client_spec(vec![SanEntry::Dns("bridge.internal".into())]).with_key(algorithm);
        spec.unknown_critical_extension = true;
        let leaf = stack.client_ca.issue_with(&spec);
        assert!(
            leaf.try_identity().is_err(),
            "{algorithm:?}: loaded as an identity"
        );
        assert!(
            raw_client(&stack, &leaf).is_err(),
            "{algorithm:?}: rustls built a client config for it"
        );
    }
}
