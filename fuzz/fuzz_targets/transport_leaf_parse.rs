#![no_main]

//! Certificate/identity extraction (ADR 0130).
//!
//! `ParsedLeaf::parse` reads the facts that become peer identity selectors
//! out of a certificate rustls has already verified — and, on the ingress
//! path, out of one a proxy merely forwarded. It must be total over
//! arbitrary DER, and every selector it emits must satisfy the shared
//! validator: no CN, no address, no wildcard, no unvalidated text.

use libfuzzer_sys::fuzz_target;
use opensesame_domain::transport::PeerIdentitySelector;
use opensesame_transport_security::ParsedLeaf;
use rustls_pki_types::CertificateDer;

fuzz_target!(|data: &[u8]| {
    let der = CertificateDer::from(data.to_vec());
    let Ok(leaf) = ParsedLeaf::parse(&der) else {
        return;
    };
    assert_eq!(leaf.thumbprint_sha256.len(), 64);
    assert!(leaf
        .thumbprint_sha256
        .bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    for selector in &leaf.selectors {
        selector
            .validate()
            .expect("an emitted selector must satisfy the shared validator");
        assert!(!selector.value().contains('@'), "an address became an identity");
        assert!(!selector.value().contains('*'), "a wildcard became an identity");
    }
    assert!(
        leaf.selectors.iter().any(PeerIdentitySelector::is_thumbprint),
        "the thumbprint selector is always present"
    );
    // At most one SPIFFE identity, and only when the certificate carries
    // exactly one well-formed spiffe:// URI SAN.
    let spiffe = leaf
        .selectors
        .iter()
        .filter(|s| matches!(s, PeerIdentitySelector::SpiffeId(_)))
        .count();
    assert!(spiffe <= 1, "an ambiguous SVID produced two identities");
    if spiffe == 1 {
        assert_eq!(
            leaf.uri_sans
                .iter()
                .filter(|u| u.starts_with("spiffe://"))
                .count(),
            1
        );
    }
});
