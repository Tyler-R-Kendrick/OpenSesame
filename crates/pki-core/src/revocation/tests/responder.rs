use super::*;

#[test]
fn every_responder_key_algorithm_produces_a_verifiable_response() {
    let now = OffsetDateTime::now_utc().replace_nanosecond(0).unwrap();
    for algorithm in [
        KeyAlgorithm::EcdsaP256,
        KeyAlgorithm::EcdsaP384,
        KeyAlgorithm::Ed25519,
        KeyAlgorithm::Rsa2048,
        KeyAlgorithm::Rsa4096,
    ] {
        let root = ca::generate_root(&ca::CaParams {
            subject: SubjectDn::common_name("Responder Root"),
            key_algorithm: algorithm,
            not_before: now - Duration::minutes(1),
            not_after: now + Duration::days(365),
            path_len: None,
            crl_distribution_points: Vec::new(),
        })
        .unwrap();
        let der = build_ocsp_response(
            &root.certificate_pem,
            &root.key,
            OcspCertStatus::Good,
            &request_facts(),
            now,
            now + Duration::hours(1),
        )
        .unwrap();
        verify_ocsp_response(&der, &root.key.public_key_der()).unwrap();
    }
}
