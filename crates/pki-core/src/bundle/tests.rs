use super::*;
use crate::ca;
use crate::keys;
use crate::leaf;
use crate::types::{KeyAlgorithm, SubjectDn};
use time::{Duration, OffsetDateTime};

fn hierarchy() -> (ca::GeneratedCa, leaf::IssuedLeaf, KeyPair) {
    let now = OffsetDateTime::now_utc();
    let root = ca::generate_root(&ca::CaParams {
        subject: SubjectDn::common_name("Bundle Test Root"),
        key_algorithm: KeyAlgorithm::EcdsaP256,
        not_before: now - Duration::minutes(1),
        not_after: now + Duration::days(365),
        path_len: None,
        crl_distribution_points: Vec::new(),
    })
    .unwrap();
    let params = leaf::LeafParams::new(
        SubjectDn::common_name("bundle.example.com"),
        vec![SanEntry::Dns("bundle.example.com".into())],
        now - Duration::minutes(1),
        now + Duration::days(30),
    );
    let (issued, key) = leaf::issue_leaf_with_generated_key(
        &root.certificate_pem,
        &root.key,
        &params,
        KeyAlgorithm::EcdsaP256,
    )
    .unwrap();
    (root, issued, key)
}

#[test]
fn adversarial_a_fingerprint_is_never_minted_for_a_non_certificate() {
    for body in [
        "AAAA",
        "!!!!",
        "////////////////",
        "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A",
    ] {
        let document = format!("-----BEGIN CERTIFICATE-----\n{body}\n-----END CERTIFICATE-----\n");
        assert!(
            fingerprint_sha256(&document).is_err(),
            "minted a certificate identity for {body:?}"
        );
    }
    let (_, issued, _) = hierarchy();
    assert_eq!(
        fingerprint_sha256(&issued.certificate_pem).unwrap(),
        issued.fingerprint_sha256
    );
}

#[test]
fn a_well_ordered_chain_normalizes_and_verifies() {
    let (root, issued, _) = hierarchy();
    let chain = format!("{}{}", issued.certificate_pem, root.certificate_pem);
    let normalized = normalize_chain(&chain).unwrap();
    assert_eq!(normalized.len(), 2);
    assert_eq!(
        fingerprint_sha256(&normalized[0]).unwrap(),
        issued.fingerprint_sha256
    );
}

#[test]
fn adversarial_a_reversed_chain_fails_signature_verification() {
    let (root, issued, _) = hierarchy();
    let reversed = format!("{}{}", root.certificate_pem, issued.certificate_pem);
    assert_eq!(
        normalize_chain(&reversed).unwrap_err(),
        PkiError::ChainInvalid
    );
}

#[test]
fn adversarial_a_chain_from_a_foreign_root_is_refused() {
    let (_, issued, _) = hierarchy();
    let (foreign, _, _) = hierarchy();
    let spliced = format!("{}{}", issued.certificate_pem, foreign.certificate_pem);
    assert_eq!(
        normalize_chain(&spliced).unwrap_err(),
        PkiError::ChainInvalid
    );
}

#[test]
fn adversarial_an_oversized_or_overlong_chain_is_refused() {
    let (root, issued, _) = hierarchy();
    let too_many =
        format!("{}{}", issued.certificate_pem, root.certificate_pem).repeat(x509::MAX_CHAIN_CERTS);
    assert_eq!(normalize_chain(&too_many).unwrap_err(), PkiError::TooLarge);
    let padded = format!(
        "{}{}",
        issued.certificate_pem,
        " ".repeat(x509::MAX_PEM_BYTES)
    );
    assert_eq!(normalize_chain(&padded).unwrap_err(), PkiError::TooLarge);
}

#[test]
fn key_and_name_checks_catch_a_substituted_certificate() {
    let (_, issued, key) = hierarchy();
    verify_key_match(&issued.certificate_pem, &key).unwrap();
    verify_sans(
        &issued.certificate_pem,
        &[SanEntry::Dns("bundle.example.com".into())],
    )
    .unwrap();

    let stranger = keys::generate(KeyAlgorithm::EcdsaP256).unwrap();
    assert_eq!(
        verify_key_match(&issued.certificate_pem, &stranger).unwrap_err(),
        PkiError::KeyMismatch
    );
    assert_eq!(
        verify_sans(
            &issued.certificate_pem,
            &[SanEntry::Dns("substituted.example.com".into())]
        )
        .unwrap_err(),
        PkiError::NamesMismatch
    );
    assert_eq!(
        verify_sans(&issued.certificate_pem, &[]).unwrap_err(),
        PkiError::NamesMismatch
    );
}

#[test]
fn a_keystore_round_trips_a_key_and_its_chain() {
    let (root, issued, key) = hierarchy();
    let der = build_pkcs12(
        &issued.certificate_pem,
        &root.certificate_pem,
        &key,
        "correct horse",
        "leaf",
    )
    .unwrap();
    let entries = parse_pkcs12(&der, "correct horse").unwrap();
    assert_eq!(entries.len(), 1);
    let entry = &entries[0];
    assert_eq!(entry.friendly_name.as_deref(), Some("leaf"));
    assert_eq!(
        fingerprint_sha256(&entry.certificate_pem).unwrap(),
        issued.fingerprint_sha256
    );
    assert_eq!(entry.chain_pem.len(), 1);
    let recovered = entry.private_key_pkcs8_pem.as_ref().unwrap();
    let reimported = keys::from_pkcs8_pem(recovered, KeyAlgorithm::EcdsaP256).unwrap();
    assert_eq!(reimported.public_key_der(), key.public_key_der());
}

#[test]
fn a_multi_entry_keystore_enumerates_every_alias() {
    let (root_a, leaf_a, key_a) = hierarchy();
    let (root_b, leaf_b, key_b) = hierarchy();
    let first = build_pkcs12(
        &leaf_a.certificate_pem,
        &root_a.certificate_pem,
        &key_a,
        "pw",
        "alpha",
    )
    .unwrap();
    let mut store = KeyStore::from_pkcs12(&first, "pw", Pkcs12ImportPolicy::Relaxed).unwrap();
    let second = build_pkcs12(
        &leaf_b.certificate_pem,
        &root_b.certificate_pem,
        &key_b,
        "pw",
        "beta",
    )
    .unwrap();
    let other = KeyStore::from_pkcs12(&second, "pw", Pkcs12ImportPolicy::Relaxed).unwrap();
    for (alias, entry) in other.entries() {
        store.add_entry(alias, entry.clone());
    }
    let trusted = x509::parse_pem_blocks(&root_a.certificate_pem, x509::LABEL_CERTIFICATE, 1)
        .unwrap()
        .remove(0);
    store.add_entry(
        "trusted-root",
        KeyStoreEntry::Certificate(P12Certificate::from_der(&trusted).unwrap()),
    );

    let combined = store.writer("pw").write().unwrap();
    let entries = parse_pkcs12(&combined, "pw").unwrap();
    let aliases: BTreeSet<String> = entries
        .iter()
        .filter_map(|entry| entry.friendly_name.clone())
        .collect();
    assert!(aliases.contains("alpha"));
    assert!(aliases.contains("beta"));
    assert!(aliases.contains("trusted-root"));
    let trusted_entry = entries
        .iter()
        .find(|entry| entry.friendly_name.as_deref() == Some("trusted-root"))
        .unwrap();
    assert!(trusted_entry.private_key_pkcs8_pem.is_none());
}

#[test]
fn adversarial_a_wrong_password_never_opens_a_keystore() {
    let (root, issued, key) = hierarchy();
    let der = build_pkcs12(
        &issued.certificate_pem,
        &root.certificate_pem,
        &key,
        "right",
        "leaf",
    )
    .unwrap();
    assert_eq!(parse_pkcs12(&der, "wrong").unwrap_err(), PkiError::Pkcs12);
    assert_eq!(parse_pkcs12(&der, "").unwrap_err(), PkiError::Pkcs12);
}

#[test]
fn adversarial_hostile_keystore_bytes_never_panic() {
    for hostile in [
        Vec::new(),
        vec![0x00],
        vec![0x30, 0x82, 0xff, 0xff],
        vec![0xffu8; 4096],
    ] {
        assert!(parse_pkcs12(&hostile, "pw").is_err());
    }
    let huge = vec![0x41u8; 9 * 1024 * 1024];
    assert_eq!(parse_pkcs12(&huge, "pw").unwrap_err(), PkiError::TooLarge);
}

#[test]
fn entry_debug_never_renders_private_material() {
    let (root, issued, key) = hierarchy();
    let der = build_pkcs12(
        &issued.certificate_pem,
        &root.certificate_pem,
        &key,
        "pw",
        "leaf",
    )
    .unwrap();
    let entries = parse_pkcs12(&der, "pw").unwrap();
    let rendered = format!("{:?}", entries[0]);
    assert!(rendered.contains("<redacted>"));
    assert!(!rendered.contains("BEGIN PRIVATE KEY"));
}

#[test]
fn pkcs8_armour_stripping_rejects_an_empty_body() {
    assert_eq!(
        pkcs8_pem_to_der("-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----\n") // gitleaks:allow -- PEM delimiter or invalid-key test, not private key material
            .unwrap_err(),
        PkiError::InvalidPem
    );
    assert!(
        pkcs8_pem_to_der("-----BEGIN PRIVATE KEY-----\n!!\n-----END PRIVATE KEY-----\n").is_err()
    );
}
