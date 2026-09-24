use super::*;
use crate::ca;
use time::Duration;

pub(crate) fn root(algorithm: KeyAlgorithm) -> ca::GeneratedCa {
    let now = OffsetDateTime::now_utc();
    ca::generate_root(&ca::CaParams {
        subject: SubjectDn::common_name("Leaf Test Root"),
        key_algorithm: algorithm,
        not_before: now - Duration::minutes(1),
        not_after: now + Duration::days(365),
        path_len: None,
        crl_distribution_points: Vec::new(),
    })
    .unwrap()
}

pub(crate) fn params() -> LeafParams {
    let now = OffsetDateTime::now_utc();
    LeafParams {
        subject: SubjectDn::common_name("leaf.example.com"),
        sans: vec![
            SanEntry::Dns("leaf.example.com".into()),
            SanEntry::Dns("alt.example.com".into()),
            SanEntry::Ip("10.9.8.7".parse().unwrap()),
        ],
        not_before: now - Duration::minutes(1),
        not_after: now + Duration::days(30),
        key_usages: vec![KeyUsage::DigitalSignature, KeyUsage::KeyEncipherment],
        ext_key_usages: vec![ExtendedKeyUsage::ServerAuth],
        basic_constraints: Some(BasicConstraints {
            ca: false,
            max_path_len: None,
        }),
        crl_distribution_points: vec!["http://crl.example.com/a.crl".into()],
        ocsp_urls: vec!["http://ocsp.example.com".into()],
        serial: None,
    }
}

#[test]
fn a_csr_signed_leaf_chains_to_its_issuer_for_every_algorithm() {
    for algorithm in [
        KeyAlgorithm::EcdsaP256,
        KeyAlgorithm::EcdsaP384,
        KeyAlgorithm::Ed25519,
    ] {
        let root = root(algorithm);
        let subject_key = keys::generate(algorithm).unwrap();
        let request = csr::generate_csr(
            &SubjectDn::common_name("leaf.example.com"),
            &[],
            &subject_key,
        )
        .unwrap();
        let leaf =
            issue_leaf_from_csr(&root.certificate_pem, &root.key, &request, &params()).unwrap();
        let chain = format!("{}{}", leaf.certificate_pem, leaf.chain_pem);
        assert_eq!(bundle::normalize_chain(&chain).unwrap().len(), 2);
        assert_eq!(leaf.fingerprint_sha256.len(), 64);
        assert!(!leaf.serial_hex.is_empty());
    }
}

#[test]
fn a_managed_key_leaf_matches_the_key_it_was_issued_for() {
    let root = root(KeyAlgorithm::EcdsaP256);
    let (leaf, key) = issue_leaf_with_generated_key(
        &root.certificate_pem,
        &root.key,
        &params(),
        KeyAlgorithm::Ed25519,
    )
    .unwrap();
    assert_eq!(key.algorithm(), KeyAlgorithm::Ed25519);
    bundle::verify_key_match(&leaf.certificate_pem, &key).unwrap();
    bundle::verify_sans(&leaf.certificate_pem, &params().sans).unwrap();
}

#[test]
fn a_self_signed_leaf_has_no_issuer_chain() {
    let (leaf, key) = issue_self_signed(&params(), KeyAlgorithm::EcdsaP256).unwrap();
    assert!(leaf.chain_pem.is_empty());
    bundle::verify_key_match(&leaf.certificate_pem, &key).unwrap();
}

#[test]
fn an_explicit_serial_is_carried_into_the_certificate() {
    let root = root(KeyAlgorithm::EcdsaP256);
    let mut parameters = params();
    parameters.serial = Some([
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
        0x10,
    ]);
    let (leaf, _) = issue_leaf_with_generated_key(
        &root.certificate_pem,
        &root.key,
        &parameters,
        KeyAlgorithm::EcdsaP256,
    )
    .unwrap();
    assert_eq!(leaf.serial_hex, "0102030405060708090a0b0c0d0e0f10");
}

#[test]
fn revocation_urls_are_actually_embedded() {
    let root = root(KeyAlgorithm::EcdsaP256);
    let (leaf, _) = issue_leaf_with_generated_key(
        &root.certificate_pem,
        &root.key,
        &params(),
        KeyAlgorithm::EcdsaP256,
    )
    .unwrap();
    let der = x509::parse_pem_blocks(&leaf.certificate_pem, x509::LABEL_CERTIFICATE, 1)
        .unwrap()
        .remove(0);
    let text = String::from_utf8_lossy(&der).into_owned();
    assert!(text.contains("http://crl.example.com/a.crl"));
    assert!(text.contains("http://ocsp.example.com"));
}

#[test]
fn the_issued_leaf_serializes_without_any_private_material() {
    let (leaf, _) = issue_self_signed(&params(), KeyAlgorithm::Ed25519).unwrap();
    let json = serde_json::to_string(&leaf).unwrap();
    assert!(!json.contains("PRIVATE KEY"));
    assert_eq!(serde_json::from_str::<IssuedLeaf>(&json).unwrap(), leaf);
}

#[test]
fn adversarial_issuance_refuses_an_inverted_window_and_an_unusable_issuer() {
    let root = root(KeyAlgorithm::EcdsaP256);
    let mut inverted = params();
    std::mem::swap(&mut inverted.not_before, &mut inverted.not_after);
    assert_eq!(
        issue_leaf_with_generated_key(
            &root.certificate_pem,
            &root.key,
            &inverted,
            KeyAlgorithm::EcdsaP256
        )
        .unwrap_err(),
        PkiError::InvalidValidity
    );
    let stranger = keys::generate(KeyAlgorithm::EcdsaP256).unwrap();
    assert_eq!(
        issue_leaf_with_generated_key(
            &root.certificate_pem,
            &stranger,
            &params(),
            KeyAlgorithm::EcdsaP256
        )
        .unwrap_err(),
        PkiError::KeyMismatch
    );
}

#[test]
fn adversarial_a_hostile_csr_never_reaches_the_signer() {
    let root = root(KeyAlgorithm::EcdsaP256);
    for hostile in [
        String::new(),
        "-----BEGIN CERTIFICATE REQUEST-----\nAAAA\n-----END CERTIFICATE REQUEST-----\n".into(),
        "A".repeat(1024 * 1024),
    ] {
        assert!(
            issue_leaf_from_csr(&root.certificate_pem, &root.key, &hostile, &params()).is_err()
        );
    }
}
