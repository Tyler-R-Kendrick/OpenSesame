//! SEC-FUZZ — the RFC 9440 field decoder, driven the way
//! `fuzz/fuzz_targets/transport_ingress_fields.rs` drives it, but in the
//! ordinary test suite so the oracle runs on every build rather than only
//! under a nightly sanitizer.
//!
//! The decoder is the first thing attacker-influenced bytes reach on the
//! trusted-ingress listener: it runs before any chain is verified. The
//! property is a bounded outcome — a refusal, or a chain that satisfies
//! every limit the decoder promises — for any header content at all.

use http::{HeaderMap, HeaderName, HeaderValue};
use opensesame_ingress_evidence::{parse_client_cert_fields, IngressLimits};

/// Deterministic byte source; reproducible failures, no `rand` dependency.
fn pseudo_random(seed: u64, len: usize) -> Vec<u8> {
    let mut state = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
    (0..len)
        .map(|_| {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            u8::try_from((state >> 33) & 0xFF).unwrap_or_default()
        })
        .collect()
}

fn headers_of(leaf: &[u8], chain: &[u8]) -> HeaderMap {
    let mut headers = HeaderMap::new();
    if let Ok(value) = HeaderValue::from_bytes(leaf) {
        headers.append(HeaderName::from_static("client-cert"), value);
    }
    if let Ok(value) = HeaderValue::from_bytes(chain) {
        headers.append(HeaderName::from_static("client-cert-chain"), value);
    }
    headers
}

/// Every accepted result satisfies the decoder's own limits; nothing panics.
fn assert_bounded(headers: &HeaderMap) {
    let limits = IngressLimits::DEFAULT;
    if let Ok(parsed) = parse_client_cert_fields(headers, &limits) {
        assert!(!parsed.leaf_der().is_empty(), "an empty leaf was accepted");
        assert!(parsed.leaf_der().len() <= limits.max_certificate_bytes);
        assert!(parsed.intermediates_der().len() <= limits.max_chain_certificates);
        for der in parsed.intermediates_der() {
            assert!(!der.is_empty());
            assert!(der.len() <= limits.max_certificate_bytes);
        }
        assert_eq!(parsed.leaf_thumbprint_sha256().len(), 64);
    }
}

#[test]
fn arbitrary_field_bytes_are_bounded() {
    for seed in 0..1_500u64 {
        let bytes = pseudo_random(seed, 48);
        let split = usize::from(bytes[0]) % bytes.len();
        let (leaf, chain) = bytes.split_at(split);
        assert_bounded(&headers_of(leaf, chain));
    }
}

/// Structured-field shapes that a lenient RFC 8941 parser would tolerate:
/// missing padding, stray pad bits, parameters, inner lists, obs-text,
/// repeated singletons and whitespace-only values. Each must be a refusal,
/// and the decoder must reach the same verdict every time.
#[test]
fn near_miss_structured_fields_are_refused_deterministically() {
    let hostile: [(&str, &str); 12] = [
        (":YWJj:", ""),               // leaf only, no chain: refused later
        (":YWJj", ""),                // unterminated byte sequence
        ("YWJj:", ""),                // missing opening colon
        (":YWJj:;p=1", ""),           // parameters
        ("(:YWJj:)", ""),             // inner list
        (":YWJjZA:", ""),             // missing padding
        (":YWJjZB==:", ""),           // stray pad bits
        ("::", ""),                   // empty member
        ("   ", ""),                  // whitespace only
        (":YWJj:, :ZGVm:", ""),       // a list where an item is required
        (":YWJj:", "(:ZGVm:)"),       // inner list in the chain
        (":YWJj:", ":ZGVm:;p=\"x\""), // parameters in the chain
    ];
    for (leaf, chain) in hostile {
        let headers = headers_of(leaf.as_bytes(), chain.as_bytes());
        let first = parse_client_cert_fields(&headers, &IngressLimits::DEFAULT)
            .map_err(|e| e.code().to_owned());
        assert!(first.is_err(), "{leaf:?}/{chain:?} was accepted");
        let again = parse_client_cert_fields(&headers, &IngressLimits::DEFAULT)
            .map_err(|e| e.code().to_owned());
        assert_eq!(
            first.map(|_| ()),
            again.map(|_| ()),
            "non-deterministic verdict"
        );
    }
}

/// A repeated `Client-Cert` is a singleton violation whatever the values
/// are: one forwarded leaf per request, so two proxies (or a proxy and a
/// forger) cannot both name a client.
#[test]
fn a_repeated_leaf_field_is_always_refused() {
    for seed in 0..64u64 {
        let payload = base64_of(&pseudo_random(seed, 16));
        let mut headers = HeaderMap::new();
        for _ in 0..2 {
            headers.append(
                HeaderName::from_static("client-cert"),
                HeaderValue::from_str(&payload).expect("ascii"),
            );
        }
        let error = parse_client_cert_fields(&headers, &IngressLimits::DEFAULT)
            .expect_err("two leaf fields accepted");
        assert_eq!(error.code(), "leaf_repeated");
    }
}

fn base64_of(bytes: &[u8]) -> String {
    use base64::Engine as _;
    format!(
        ":{}:",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}
