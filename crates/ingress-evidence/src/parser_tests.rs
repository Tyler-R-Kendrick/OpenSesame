//! Parser behaviour the corpus cannot express: default-limit sizes and the
//! never-panics property over arbitrary header bytes.

use http::{HeaderMap, HeaderName, HeaderValue};
use proptest::prelude::*;

use crate::{has_client_cert_fields, parse_client_cert_fields, IngressError, IngressLimits};

fn map(pairs: &[(&'static str, &[u8])]) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (name, value) in pairs {
        map.append(
            HeaderName::from_static(name),
            HeaderValue::from_bytes(value).expect("header value"),
        );
    }
    map
}

#[test]
fn no_fields_is_leaf_missing_and_not_present() {
    let headers = map(&[("host", b"example")]);
    assert!(!has_client_cert_fields(&headers));
    assert_eq!(
        parse_client_cert_fields(&headers, &IngressLimits::DEFAULT),
        Err(IngressError::LeafMissing)
    );
}

#[test]
fn chain_alone_counts_as_present() {
    assert!(has_client_cert_fields(&map(&[(
        "client-cert-chain",
        b":AAAA:"
    )])));
}

#[test]
fn default_total_header_limit_is_enforced_before_decoding() {
    let big = vec![b'A'; 64 * 1024 + 1];
    let headers = map(&[("client-cert", &big)]);
    assert_eq!(
        parse_client_cert_fields(&headers, &IngressLimits::DEFAULT),
        Err(IngressError::HeaderBytesExceeded)
    );
    let split_a = vec![b'A'; 40 * 1024];
    let split_b = vec![b'A'; 24 * 1024 + 1];
    let headers = map(&[("client-cert", &split_a), ("client-cert-chain", &split_b)]);
    assert_eq!(
        parse_client_cert_fields(&headers, &IngressLimits::DEFAULT),
        Err(IngressError::HeaderBytesExceeded)
    );
}

#[test]
fn default_certificate_limit_is_enforced_before_der() {
    use base64::Engine as _;
    let over = base64::engine::general_purpose::STANDARD.encode(vec![0u8; 16 * 1024 + 1]);
    let value = format!(":{over}:");
    let headers = map(&[("client-cert", value.as_bytes())]);
    assert_eq!(
        parse_client_cert_fields(&headers, &IngressLimits::DEFAULT),
        Err(IngressError::CertificateTooLarge(crate::Field::ClientCert))
    );
}

#[test]
fn error_codes_are_snake_case_and_stable() {
    for (err, code) in [
        (IngressError::HeaderBytesExceeded, "header_bytes_exceeded"),
        (IngressError::LeafMissing, "leaf_missing"),
        (IngressError::LeafRepeated, "leaf_repeated"),
        (IngressError::ChainTooLong, "chain_too_long"),
        (IngressError::ConflictingLeaf, "conflicting_leaf"),
        (
            IngressError::EmptyItem(crate::Field::ClientCertChain),
            "empty_item",
        ),
    ] {
        assert_eq!(err.code(), code);
        assert!(
            !format!("{err}").contains("MII"),
            "message never carries certificate text"
        );
    }
}

fn header_bytes() -> impl Strategy<Value = Vec<u8>> {
    // Visible ASCII plus obs-text, weighted toward the structured-field alphabet.
    prop::collection::vec(
        prop_oneof![
            8 => prop::sample::select(b":;,=() \t\"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".to_vec()),
            1 => 0x20u8..=0x7e,
            1 => 0x80u8..=0xff,
        ],
        0..300,
    )
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    #[test]
    fn never_panics_on_arbitrary_fields(
        leaf in prop::collection::vec(header_bytes(), 0..3),
        chain in prop::collection::vec(header_bytes(), 0..4),
    ) {
        let mut headers = HeaderMap::new();
        for value in &leaf {
            headers.append(HeaderName::from_static("client-cert"), HeaderValue::from_bytes(value).unwrap());
        }
        for value in &chain {
            headers.append(HeaderName::from_static("client-cert-chain"), HeaderValue::from_bytes(value).unwrap());
        }
        let first = parse_client_cert_fields(&headers, &IngressLimits::DEFAULT);
        let second = parse_client_cert_fields(&headers, &IngressLimits::DEFAULT);
        prop_assert_eq!(&first, &second, "deterministic");
        // Random text essentially never forms a DER certificate; what matters is a typed error, not a panic.
        prop_assert!(first.is_err());
    }
}
