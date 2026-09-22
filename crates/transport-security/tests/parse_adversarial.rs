//! SEC-FUZZ (the part that runs in an ordinary `cargo test`).
//!
//! `cargo fuzz` needs a nightly toolchain and a sanitizer build; the
//! libFuzzer entry points for these same functions live in
//! `fuzz/fuzz_targets/transport_*.rs`. This file drives the *production*
//! parsers — `ParsedLeaf::parse`, the selector validator and
//! `ServiceBindingSet::parse_json`, never a substitute — over deterministic
//! mutations of real inputs, so the oracles are exercised on every run of
//! the normal suite rather than only when somebody installs cargo-fuzz.
//!
//! The property in every case is the same: a bounded refusal. No panic, no
//! hang, no partial value that later code could mistake for a verified one.

mod common;

use opensesame_domain::transport::{PeerIdentitySelector, ServiceBindingSet, TransportError};
use opensesame_transport_security::testkit::{DisposableCa, LeafSpec, SanEntry};
use opensesame_transport_security::ParsedLeaf;
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::CertificateDer;

/// Deterministic byte source; no `rand` dependency, reproducible failures.
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

fn real_leaf_der() -> Vec<u8> {
    let ca = DisposableCa::new("fuzz-ca");
    let leaf = ca.issue_with(&LeafSpec::client(vec![
        SanEntry::Dns("svc.internal".into()),
        SanEntry::Uri("spiffe://prod.example/svc".into()),
        SanEntry::Email("someone@corp.example".into()),
    ]));
    CertificateDer::from_pem_slice(&leaf.leaf_pem)
        .expect("leaf pem")
        .to_vec()
}

/// Single-byte and multi-byte mutations of a real certificate. Almost all of
/// them break the DER; the requirement is that every one is a refusal or a
/// well-formed parse, never a crash and never a leaf whose thumbprint does
/// not cover the bytes it was parsed from.
#[test]
fn mutated_certificates_are_refused_or_parsed_consistently() {
    let original = real_leaf_der();
    let mut parsed_ok = 0usize;
    for seed in 0..600u64 {
        let mut der = original.clone();
        let noise = pseudo_random(seed, 6);
        for chunk in noise.chunks(2) {
            let [at, value] = chunk else { continue };
            let index = (usize::from(*at) * 257 + usize::try_from(seed).unwrap_or(0)) % der.len();
            der[index] = *value;
        }
        let candidate = CertificateDer::from(der.clone());
        if let Ok(leaf) = ParsedLeaf::parse(&candidate) {
            parsed_ok += 1;
            assert_eq!(
                leaf.thumbprint_sha256,
                hex::encode(<sha2::Sha256 as sha2::Digest>::digest(&der)),
                "thumbprint does not cover the parsed bytes"
            );
            // Parsing does not decide validity — RFC 5280 does not forbid an
            // inverted window in the encoding, and a mutation can produce
            // one. What must hold is that such a leaf is never *usable*:
            // `is_valid_at` requires not_before <= now <= not_after, which an
            // inverted window can never satisfy, and `AttestedPeer` refuses
            // it outright (`attest.rs::check_window`).
            if leaf.not_before > leaf.not_after {
                assert!(
                    !leaf.is_valid_at(chrono::Utc::now()),
                    "an inverted validity window was usable"
                );
            }
            for selector in &leaf.selectors {
                selector
                    .validate()
                    .expect("an emitted selector must be valid");
            }
            assert!(
                leaf.selectors
                    .iter()
                    .any(PeerIdentitySelector::is_thumbprint),
                "the thumbprint selector is always present"
            );
            assert!(
                !leaf
                    .selectors
                    .iter()
                    .any(|s| s.value().contains('@') || s.value().contains('*')),
                "an address or a wildcard became a selector"
            );
        }
    }
    // A run where nothing parsed would be vacuous; a run where everything
    // parsed would mean the mutations missed the structure.
    assert!(
        parsed_ok > 0,
        "no mutation produced a parseable certificate"
    );
    assert!(
        parsed_ok < 600,
        "every mutation parsed; the fixture is inert"
    );
}

/// Arbitrary bytes are never a certificate.
#[test]
fn arbitrary_bytes_never_parse_as_a_leaf() {
    for seed in 0..400u64 {
        for len in [0usize, 1, 7, 64, 900] {
            let bytes = pseudo_random(seed, len);
            let candidate = CertificateDer::from(bytes);
            assert!(
                ParsedLeaf::parse(&candidate).is_err(),
                "random bytes parsed as a certificate (seed {seed}, len {len})"
            );
        }
    }
}

const VALID_BINDINGS: &str = r#"{
  "revision": 1,
  "bindings": [{
    "id": "worker-1",
    "revision": 1,
    "enabled": true,
    "revoked": false,
    "scope": "deployment",
    "trust_profile": { "name": "clients" },
    "peer": { "dns_name": "worker.internal" },
    "service_principal": "worker",
    "purpose": "worker_client",
    "allowed_operations": ["worker.providers.list"],
    "allowed_audiences": [],
    "denied_thumbprints": []
  }]
}"#;

/// Byte-level mutations of a valid bindings document. Anything that parses
/// must be structurally valid — the decoder is the only place a binding set
/// becomes authority, so a half-decoded set must not exist — and no error
/// message may echo the document back (it can carry operator topology).
#[test]
fn mutated_binding_documents_are_refused_or_fully_valid() {
    let original = VALID_BINDINGS.as_bytes().to_vec();
    let mut accepted = 0usize;
    for seed in 0..800u64 {
        let mut bytes = original.clone();
        let noise = pseudo_random(seed, 4);
        for chunk in noise.chunks(2) {
            let [at, value] = chunk else { continue };
            let index = (usize::from(*at) * 131 + usize::try_from(seed).unwrap_or(0)) % bytes.len();
            bytes[index] = *value;
        }
        let Ok(text) = std::str::from_utf8(&bytes) else {
            continue;
        };
        match ServiceBindingSet::parse_json(text) {
            Ok(set) => {
                accepted += 1;
                set.validate().expect("a parsed set must be valid");
            }
            Err(TransportError::MalformedConfiguration(detail)) => {
                assert!(
                    !detail.contains("worker.internal"),
                    "the refusal echoed the document: {detail}"
                );
            }
            Err(other) => panic!("unexpected error kind: {other:?}"),
        }
    }
    assert!(accepted > 0, "no mutation parsed; the fixture is inert");
}

/// Arbitrary text is never a binding set, and the refusal is always the
/// configuration error — never a panic and never another variant that a
/// caller might treat as transient.
#[test]
fn arbitrary_text_never_parses_as_a_binding_set() {
    for seed in 0..500u64 {
        let bytes = pseudo_random(seed, 96);
        let text = String::from_utf8_lossy(&bytes).to_string();
        match ServiceBindingSet::parse_json(&text) {
            Err(TransportError::MalformedConfiguration(_)) => {}
            Ok(_) => panic!("random text parsed as a binding set: {text:?}"),
            Err(other) => panic!("unexpected error kind: {other:?}"),
        }
    }
}

/// The selector validator over arbitrary strings: it either accepts a value
/// or refuses it, and an accepted value always round-trips through the
/// deserializer (the decoder and the validator cannot drift apart).
#[test]
fn selector_validation_never_panics_and_round_trips() {
    for seed in 0..1_000u64 {
        let bytes = pseudo_random(seed, 40);
        let value = String::from_utf8_lossy(&bytes).to_string();
        for selector in [
            PeerIdentitySelector::SpiffeId(value.clone()),
            PeerIdentitySelector::DnsName(value.clone()),
            PeerIdentitySelector::UriSan(value.clone()),
            PeerIdentitySelector::LeafThumbprintSha256(value.clone()),
        ] {
            if selector.validate().is_ok() {
                let json = serde_json::to_string(&selector).expect("serialize");
                let back: PeerIdentitySelector =
                    serde_json::from_str(&json).expect("a valid selector must decode");
                assert_eq!(back, selector);
            }
        }
    }
}
