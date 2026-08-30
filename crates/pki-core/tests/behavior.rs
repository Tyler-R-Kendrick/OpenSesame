//! End-to-end behaviour scenarios for the PKI engine, written given/when/then
//! (ADR 0066 domain model, ADR 0067 revocation).
//!
//! Each test walks one operator-visible story across module boundaries — CA
//! generation, policy evaluation, issuance, chain verification, revocation —
//! so a change that keeps every unit test green while breaking the *flow*
//! still fails here.

use opensesame_pki_core::policy::{self, PolicyCandidate};
use opensesame_pki_core::types::{
    BasicConstraints, ExtendedKeyUsage, KeyAlgorithm, KeyUsage, PolicyPreset, SanEntry,
    SignatureAlgorithm, SubjectDn,
};
use opensesame_pki_core::{bundle, ca, csr, keys, leaf, revocation, PkiError};
use time::{Duration, OffsetDateTime};

/// Given: a certificate authority this Host holds.
fn given_a_root_ca(algorithm: KeyAlgorithm, path_len: Option<u8>) -> ca::GeneratedCa {
    let now = OffsetDateTime::now_utc();
    ca::generate_root(&ca::CaParams {
        subject: SubjectDn {
            cn: Some("Behaviour Root".into()),
            o: Some("OpenSesame".into()),
            ..SubjectDn::default()
        },
        key_algorithm: algorithm,
        not_before: now - Duration::minutes(1),
        not_after: now + Duration::days(3650),
        path_len,
        crl_distribution_points: vec!["http://crl.example.com/root.crl".into()],
    })
    .unwrap()
}

/// Given: the issuance parameters an operator's request would produce.
fn given_leaf_params(names: &[&str]) -> leaf::LeafParams {
    let now = OffsetDateTime::now_utc();
    leaf::LeafParams {
        subject: SubjectDn::common_name(names[0]),
        sans: names
            .iter()
            .map(|name| SanEntry::Dns((*name).to_owned()))
            .collect(),
        not_before: now - Duration::minutes(1),
        not_after: now + Duration::days(90),
        key_usages: vec![KeyUsage::DigitalSignature, KeyUsage::KeyEncipherment],
        ext_key_usages: vec![ExtendedKeyUsage::ServerAuth],
        basic_constraints: Some(BasicConstraints {
            ca: false,
            max_path_len: None,
        }),
        crl_distribution_points: vec!["http://crl.example.com/root.crl".into()],
        ocsp_urls: vec!["http://ocsp.example.com".into()],
        serial: None,
    }
}

#[test]
fn given_a_root_and_a_tls_policy_when_a_leaf_is_requested_for_two_names_then_it_chains_and_carries_both(
) {
    // Given a root CA and the TLS-server policy preset.
    let root = given_a_root_ca(KeyAlgorithm::EcdsaP256, None);
    let rules = policy::preset(PolicyPreset::TlsServer);
    let names = ["api.example.com", "www.example.com"];

    // When an operator asks for a leaf covering two DNS names.
    let subject_key = keys::generate(KeyAlgorithm::EcdsaP256).unwrap();
    let request = csr::generate_csr(
        &SubjectDn::common_name(names[0]),
        &names
            .iter()
            .map(|name| SanEntry::Dns((*name).to_owned()))
            .collect::<Vec<_>>(),
        &subject_key,
    )
    .unwrap();
    let facts = csr::parse_csr(&request).unwrap();
    let params = given_leaf_params(&names);
    policy::evaluate(
        &rules,
        &PolicyCandidate {
            subject: facts.subject.clone(),
            sans: facts.sans.clone(),
            key_algorithm: Some(facts.key_algorithm),
            signature_algorithm: Some(SignatureAlgorithm::Sha256Ecdsa),
            key_usages: params.key_usages.clone(),
            ext_key_usages: params.ext_key_usages.clone(),
            basic_constraints: params.basic_constraints,
            ttl_seconds: Some(90 * 24 * 3600),
        },
    )
    .expect("the request conforms to the TLS server policy");
    let issued =
        leaf::issue_leaf_from_csr(&root.certificate_pem, &root.key, &request, &params).unwrap();

    // Then the certificate chains to the root and carries both names.
    let chain = format!("{}{}", issued.certificate_pem, issued.chain_pem);
    assert_eq!(bundle::normalize_chain(&chain).unwrap().len(), 2);
    bundle::verify_sans(
        &issued.certificate_pem,
        &names
            .iter()
            .map(|name| SanEntry::Dns((*name).to_owned()))
            .collect::<Vec<_>>(),
    )
    .unwrap();
    bundle::verify_key_match(&issued.certificate_pem, &subject_key).unwrap();
    assert_eq!(
        bundle::fingerprint_sha256(&issued.certificate_pem).unwrap(),
        issued.fingerprint_sha256
    );
}

#[test]
fn given_a_path_len_zero_intermediate_when_signing_another_ca_then_issuance_is_refused() {
    // Given a root that permits exactly one intermediate beneath it, and an
    // intermediate issued with pathLenConstraint 0.
    let root = given_a_root_ca(KeyAlgorithm::EcdsaP256, Some(1));
    let now = OffsetDateTime::now_utc();
    let intermediate_params = ca::CaParams {
        subject: SubjectDn::common_name("Behaviour Intermediate"),
        key_algorithm: KeyAlgorithm::EcdsaP256,
        not_before: now - Duration::minutes(1),
        not_after: now + Duration::days(1825),
        path_len: Some(0),
        crl_distribution_points: Vec::new(),
    };
    let (request, intermediate_key) = ca::generate_intermediate_csr(&intermediate_params).unwrap();
    let intermediate = ca::sign_intermediate(
        &root.certificate_pem,
        &root.key,
        &request,
        &intermediate_params,
    )
    .unwrap();
    assert_eq!(
        ca::validate_ca(&intermediate, Some(&intermediate_key))
            .unwrap()
            .path_len,
        Some(0)
    );

    // When that intermediate is asked to certify a third authority.
    let grandchild_params = ca::CaParams {
        subject: SubjectDn::common_name("Behaviour Grandchild"),
        path_len: Some(0),
        ..intermediate_params.clone()
    };
    let (grandchild_request, _) = ca::generate_intermediate_csr(&grandchild_params).unwrap();
    let outcome = ca::sign_intermediate(
        &intermediate,
        &intermediate_key,
        &grandchild_request,
        &grandchild_params,
    );

    // Then issuance is refused on the path-length budget.
    assert_eq!(outcome.unwrap_err(), PkiError::PathLenExceeded);
}

#[test]
fn given_a_three_level_hierarchy_when_a_leaf_is_issued_then_the_whole_chain_verifies() {
    // Given a root, an intermediate beneath it, and a leaf beneath that.
    let root = given_a_root_ca(KeyAlgorithm::EcdsaP384, Some(1));
    let now = OffsetDateTime::now_utc();
    let intermediate_params = ca::CaParams {
        subject: SubjectDn::common_name("Three Level Intermediate"),
        key_algorithm: KeyAlgorithm::EcdsaP256,
        not_before: now - Duration::minutes(1),
        not_after: now + Duration::days(1825),
        path_len: Some(0),
        crl_distribution_points: Vec::new(),
    };
    let (request, intermediate_key) = ca::generate_intermediate_csr(&intermediate_params).unwrap();
    let intermediate = ca::sign_intermediate(
        &root.certificate_pem,
        &root.key,
        &request,
        &intermediate_params,
    )
    .unwrap();

    // When a leaf is issued under the intermediate.
    let params = given_leaf_params(&["deep.example.com"]);
    let (issued, _) = leaf::issue_leaf_with_generated_key(
        &intermediate,
        &intermediate_key,
        &params,
        KeyAlgorithm::Ed25519,
    )
    .unwrap();

    // Then leaf → intermediate → root verifies as one chain.
    let chain = format!(
        "{}{}{}",
        issued.certificate_pem, intermediate, root.certificate_pem
    );
    assert_eq!(bundle::normalize_chain(&chain).unwrap().len(), 3);
}

#[test]
fn given_a_revoked_certificate_when_a_crl_and_an_ocsp_answer_are_produced_then_both_agree() {
    // Given a root that has issued a certificate and then revoked it.
    let root = given_a_root_ca(KeyAlgorithm::EcdsaP256, None);
    let params = given_leaf_params(&["revoked.example.com"]);
    let (issued, _) = leaf::issue_leaf_with_generated_key(
        &root.certificate_pem,
        &root.key,
        &params,
        KeyAlgorithm::EcdsaP256,
    )
    .unwrap();
    let now = OffsetDateTime::now_utc().replace_nanosecond(0).unwrap();
    let entry = revocation::RevokedEntry {
        serial_hex: issued.serial_hex.clone(),
        revoked_at: now - Duration::minutes(5),
        reason_code: 1,
    };

    // When a CRL is generated and an OCSP request is answered for that serial.
    let crl = revocation::build_crl(
        &root.certificate_pem,
        &root.key,
        std::slice::from_ref(&entry),
        1,
        now,
        now + Duration::days(1),
    )
    .unwrap();
    let request_facts = revocation::OcspRequestFacts {
        serial_hex: issued.serial_hex.clone(),
        issuer_name_hash: vec![0x01; 20],
        issuer_key_hash: vec![0x02; 20],
        hash_algorithm_oid: "1.3.14.3.2.26".into(),
    };
    let status = revocation::status_for(
        &issued.serial_hex,
        std::slice::from_ref(&issued.serial_hex),
        std::slice::from_ref(&entry),
    );
    let response = revocation::build_ocsp_response(
        &root.certificate_pem,
        &root.key,
        status,
        &request_facts,
        now,
        now + Duration::hours(12),
    )
    .unwrap();

    // Then both report revoked, with the same reason code.
    let crl_facts = revocation::parse_crl(&crl).unwrap();
    revocation::verify_crl(&crl, &root.certificate_pem).unwrap();
    assert!(crl_facts.serials.contains(&issued.serial_hex));

    let ocsp_facts =
        revocation::verify_ocsp_response(&response, &root.key.public_key_der()).unwrap();
    assert_eq!(ocsp_facts.serial_hex, issued.serial_hex);
    assert_eq!(
        ocsp_facts.cert_status,
        revocation::OcspCertStatus::Revoked {
            at: entry.revoked_at,
            reason: 1,
        }
    );
}

#[test]
fn given_a_policy_forbidding_ca_certificates_when_a_request_asks_for_ca_true_then_it_is_rejected_naming_the_field(
) {
    // Given the TLS-server policy, which forbids CA certificates.
    let rules = policy::preset(PolicyPreset::TlsServer);

    // When a request arrives asking for basicConstraints CA:TRUE. (The request
    // body carries the requested constraints alongside the CSR, because a
    // PKCS#10 request built by this engine cannot itself assert CA:TRUE.)
    let key = keys::generate(KeyAlgorithm::EcdsaP256).unwrap();
    let request = csr::generate_csr(
        &SubjectDn::common_name("sneaky.example.com"),
        &[SanEntry::Dns("sneaky.example.com".into())],
        &key,
    )
    .unwrap();
    let facts = csr::parse_csr(&request).unwrap();
    let candidate = PolicyCandidate {
        subject: facts.subject,
        sans: facts.sans,
        key_algorithm: Some(facts.key_algorithm),
        signature_algorithm: Some(SignatureAlgorithm::Sha256Ecdsa),
        key_usages: vec![KeyUsage::DigitalSignature],
        ext_key_usages: vec![ExtendedKeyUsage::ServerAuth],
        basic_constraints: Some(BasicConstraints {
            ca: true,
            max_path_len: None,
        }),
        ttl_seconds: Some(3600),
    };

    // Then evaluation fails, naming the offending field.
    let violations = policy::evaluate(&rules, &candidate).unwrap_err();
    assert_eq!(violations.len(), 1);
    assert_eq!(violations[0].field, "basic_constraints.ca");
    assert_eq!(
        violations[0].reason,
        "certificate authority certificates are forbidden"
    );
    match policy::enforce(&rules, &candidate).unwrap_err() {
        PkiError::PolicyViolations(reported) => assert_eq!(reported, violations),
        other => panic!("unexpected error {other:?}"),
    }
}

#[test]
fn given_an_issued_certificate_when_it_is_exported_as_a_keystore_then_it_reimports_intact() {
    // Given an issued certificate with a Host-managed key.
    let root = given_a_root_ca(KeyAlgorithm::EcdsaP256, None);
    let params = given_leaf_params(&["export.example.com"]);
    let (issued, key) = leaf::issue_leaf_with_generated_key(
        &root.certificate_pem,
        &root.key,
        &params,
        KeyAlgorithm::EcdsaP256,
    )
    .unwrap();

    // When an operator exports it as a password-protected keystore.
    let store = bundle::build_pkcs12(
        &issued.certificate_pem,
        &issued.chain_pem,
        &key,
        "ceremony-password",
        "export.example.com",
    )
    .unwrap();

    // Then re-importing it yields the same certificate, chain and key.
    let entries = bundle::parse_pkcs12(&store, "ceremony-password").unwrap();
    assert_eq!(entries.len(), 1);
    let entry = &entries[0];
    assert_eq!(entry.friendly_name.as_deref(), Some("export.example.com"));
    assert_eq!(
        bundle::fingerprint_sha256(&entry.certificate_pem).unwrap(),
        issued.fingerprint_sha256
    );
    assert_eq!(entry.chain_pem.len(), 1);
    let recovered = keys::from_pkcs8_pem(
        entry.private_key_pkcs8_pem.as_ref().unwrap(),
        KeyAlgorithm::EcdsaP256,
    )
    .unwrap();
    assert_eq!(recovered.public_key_der(), key.public_key_der());
}

#[test]
fn given_a_profile_default_when_it_conflicts_with_its_policy_then_the_conflict_is_reported_at_write_time(
) {
    // Given a code-signing policy and profile defaults that ask for a TLS EKU.
    let rules = policy::preset(PolicyPreset::CodeSigning);
    let defaults = opensesame_pki_core::types::ProfileDefaults {
        ext_key_usages: vec![ExtendedKeyUsage::ServerAuth],
        ..opensesame_pki_core::types::ProfileDefaults::default()
    };

    // When the profile is validated against its policy.
    let violations = policy::validate_defaults_against_policy(&defaults, &rules).unwrap_err();

    // Then the conflict is reported before any certificate is issued.
    assert_eq!(violations[0].field, "ext_key_usages");
    assert_eq!(
        violations[0].reason,
        "value \"server_auth\" is not permitted"
    );
}

#[test]
fn given_a_self_signed_profile_when_a_certificate_is_issued_then_it_stands_alone() {
    // Given a profile whose issuer type is self-signed.
    let params = given_leaf_params(&["standalone.example.com"]);

    // When a certificate is issued under it.
    let (issued, key) = leaf::issue_self_signed(&params, KeyAlgorithm::Ed25519).unwrap();

    // Then it carries no issuer chain but is otherwise a complete certificate.
    assert!(issued.chain_pem.is_empty());
    bundle::verify_key_match(&issued.certificate_pem, &key).unwrap();
    bundle::verify_sans(
        &issued.certificate_pem,
        &[SanEntry::Dns("standalone.example.com".into())],
    )
    .unwrap();
    assert_eq!(
        bundle::normalize_chain(&issued.certificate_pem)
            .unwrap()
            .len(),
        1
    );
}
