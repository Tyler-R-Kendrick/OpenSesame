#![no_main]

//! RFC 9440 `Client-Cert` / `Client-Cert-Chain` decoding (ADR 0130).
//!
//! These fields arrive from a proxy on the trusted-ingress listener and are
//! decoded *before* anything is verified, so the decoder is the first thing
//! attacker-influenced bytes reach. It must be total and bounded, and it
//! must never hand back a chain that breaks its own documented limits.

use http::{HeaderMap, HeaderName, HeaderValue};
use libfuzzer_sys::fuzz_target;
use opensesame_ingress_evidence::{parse_client_cert_fields, IngressLimits};

fuzz_target!(|data: &[u8]| {
    // The first byte splits the input between the two fields so both the
    // singleton-item and the list parser are reached.
    let split = usize::from(*data.first().unwrap_or(&0)) % data.len().max(1);
    let (leaf, chain) = data.split_at(split.min(data.len()));
    let mut headers = HeaderMap::new();
    if let Ok(value) = HeaderValue::from_bytes(leaf) {
        headers.append(HeaderName::from_static("client-cert"), value);
    }
    if let Ok(value) = HeaderValue::from_bytes(chain) {
        headers.append(HeaderName::from_static("client-cert-chain"), value);
    }
    let limits = IngressLimits::DEFAULT;
    if let Ok(parsed) = parse_client_cert_fields(&headers, &limits) {
        assert!(!parsed.leaf_der().is_empty(), "an empty leaf was accepted");
        assert!(parsed.leaf_der().len() <= limits.max_certificate_bytes);
        assert!(parsed.intermediates_der().len() <= limits.max_chain_certificates);
        for der in parsed.intermediates_der() {
            assert!(!der.is_empty());
            assert!(der.len() <= limits.max_certificate_bytes);
        }
        assert_eq!(parsed.leaf_thumbprint_sha256().len(), 64);
    }
});
