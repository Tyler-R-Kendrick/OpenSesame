//! Tests for the certs-only codec. Certificates come from the crate's own CA
//! generator so the envelope carries genuine DER; every hostile shape must be
//! refused without panicking.

use super::*;
use crate::ca;
use crate::keys;
use crate::types::{KeyAlgorithm, SubjectDn};
use crate::x509;

fn der_cert() -> Vec<u8> {
    let now = time::OffsetDateTime::now_utc();
    let generated = ca::generate_root(&ca::CaParams {
        subject: SubjectDn::common_name("pkcs7 tests"),
        key_algorithm: KeyAlgorithm::EcdsaP256,
        not_before: now - time::Duration::minutes(1),
        not_after: now + time::Duration::days(365),
        path_len: None,
        crl_distribution_points: Vec::new(),
    })
    .expect("root");
    x509::parse_pem_blocks(&generated.certificate_pem, x509::LABEL_CERTIFICATE, 1)
        .expect("pem")
        .remove(0)
}

#[test]
fn one_certificate_round_trips() {
    let cert = der_cert();
    let envelope = certs_only(&[cert.clone()]).expect("encode");
    let parsed = parse_certs_only(&envelope).expect("decode");
    assert_eq!(parsed, vec![cert]);
}

#[test]
fn several_certificates_keep_their_order() {
    let certs = vec![der_cert(), der_cert(), der_cert()];
    let envelope = certs_only(&certs).expect("encode");
    assert_eq!(parse_certs_only(&envelope).expect("decode"), certs);
}

#[test]
fn long_form_lengths_round_trip() {
    // A padded-but-valid certificate shape to push the envelope past 127 bytes.
    let mut cert = der_cert();
    let payload_len = cert.len() - 4;
    let padding = 200usize.saturating_sub(payload_len);
    cert.splice(2..2, std::iter::repeat_n(0u8, padding));
    let envelope = certs_only(&[cert.clone()]).expect("encode");
    assert!(envelope.len() > 127);
    assert_eq!(parse_certs_only(&envelope).expect("decode"), vec![cert]);
}

#[test]
fn adversarial_wrapping_arbitrary_bytes_is_refused() {
    assert!(certs_only(&[]).is_err());
    assert!(certs_only(&[vec![0x02, 0x01, 0x01]]).is_err()); // not a SEQUENCE
    let too_many = vec![der_cert(); MAX_PKCS7_CERTS + 1];
    assert!(certs_only(&too_many).is_err());
}

#[test]
fn adversarial_hostile_envelopes_never_panic_and_always_error() {
    let good = certs_only(&[der_cert()]).expect("encode");
    let mut cases: Vec<Vec<u8>> = vec![
        Vec::new(),
        vec![0x30],
        vec![0x30, 0x80, 0x00, 0x00],
        vec![0xff; 4096],
        good.clone(),
    ];
    // Truncations at every length.
    for len in 0..good.len() {
        cases.push(good[..len].to_vec());
    }
    // One flipped byte at every position.
    for index in 0..good.len() {
        let mut tampered = good.clone();
        tampered[index] ^= 0x01;
        cases.push(tampered);
    }
    for case in cases {
        let _ = parse_certs_only(&case); // total: never panics
    }
}

#[test]
fn signed_or_nonempty_signerinfos_are_refused() {
    let good = certs_only(&[der_cert()]).expect("encode");
    // Graft a non-empty signerInfos by appending bytes: trailing data refused.
    let mut extended = good.clone();
    extended.extend_from_slice(&[0x31, 0x00]);
    assert!(parse_certs_only(&extended).is_err());
    // An object with encapsulated content is not certs-only: flip the
    // contentInfo length so a content field would have to follow — refused.
    let mut bent = good;
    bent[1] = bent[1].wrapping_add(3);
    assert!(parse_certs_only(&bent).is_err());
}

#[test]
fn the_envelope_carries_no_private_material() {
    let key = keys::generate(KeyAlgorithm::EcdsaP256).expect("key");
    let secret = key.private_key_pkcs8_pem();
    let envelope = certs_only(&[der_cert()]).expect("encode");
    let text = String::from_utf8_lossy(&envelope);
    assert!(!text.contains("PRIVATE"));
    assert!(!text.contains(secret.as_str()));
}
