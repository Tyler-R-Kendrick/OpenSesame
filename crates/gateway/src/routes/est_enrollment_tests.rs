//! Tests for the EST enrollment core: defaults merge, lifetime clamps, the
//! client-authentication usage profile, and a real sign-and-wrap round trip.

use opensesame_pki_core::ca::{self, CaParams};
use opensesame_pki_core::csr;
use opensesame_pki_core::keys;
use opensesame_pki_core::pkcs7;
use opensesame_pki_core::types::{ProfileDefaults, SanEntry, SubjectDn};
use opensesame_pki_core::KeyAlgorithm;
use time::{Duration, OffsetDateTime};

use super::*;

fn pem_to_der(pem: &str) -> Vec<u8> {
    use base64::Engine as _;
    let body: String = pem
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .collect();
    base64::engine::general_purpose::STANDARD
        .decode(body)
        .expect("pem body")
}

#[test]
fn merge_subject_fills_only_what_the_request_omitted() {
    let defaults = ProfileDefaults {
        subject: Some(SubjectDn {
            cn: Some("default-cn".into()),
            o: Some("default-o".into()),
            ..SubjectDn::default()
        }),
        ..ProfileDefaults::default()
    };
    let requested = SubjectDn {
        cn: Some("asked-for".into()),
        ..SubjectDn::default()
    };
    let merged = merge_subject(&requested, &defaults);
    assert_eq!(merged.cn.as_deref(), Some("asked-for"));
    assert_eq!(merged.o.as_deref(), Some("default-o"));
}

#[test]
fn lifetime_is_clamped_and_defaulted() {
    let defaults = ProfileDefaults::default();
    assert_eq!(ttl_seconds(&defaults, None), DEFAULT_TTL_SECONDS);
    assert_eq!(ttl_seconds(&defaults, Some(0)), 1);
    assert_eq!(ttl_seconds(&defaults, Some(u64::MAX)), MAX_TTL_SECONDS);
    let with_default = ProfileDefaults {
        ttl_seconds: Some(3_600),
        ..ProfileDefaults::default()
    };
    assert_eq!(ttl_seconds(&with_default, None), 3_600);
}

#[test]
fn the_default_profile_is_client_authentication_only() {
    let (keys, extended, constraints) = client_auth_usages();
    assert!(constraints.is_none());
    assert_eq!(extended, vec![ExtendedKeyUsage::ClientAuth]);
    assert_eq!(keys.len(), 2);
}

#[test]
fn a_real_request_signs_and_wraps_end_to_end() {
    let now = OffsetDateTime::now_utc();
    let authority = ca::generate_root(&CaParams {
        subject: SubjectDn::common_name("est tests"),
        key_algorithm: KeyAlgorithm::EcdsaP256,
        not_before: now - Duration::minutes(1),
        not_after: now + Duration::days(30),
        path_len: None,
        crl_distribution_points: Vec::new(),
    })
    .expect("root");
    let requester = keys::generate(KeyAlgorithm::EcdsaP256).expect("key");
    let csr_pem = csr::generate_csr(
        &SubjectDn::common_name("enrolled.example.com"),
        &[SanEntry::Dns("enrolled.example.com".into())],
        &requester,
    )
    .expect("csr");
    let facts = csr::parse_csr(&csr_pem).expect("facts");
    let defaults = ProfileDefaults::default();
    let request = candidate(&facts, &defaults, None);
    let issued = issue(
        &authority.certificate_pem,
        &authority.key,
        &pem_to_der(&csr_pem),
        &request,
    )
    .expect("issued");
    let p7 = response_p7(&issued).expect("p7");
    let certs = pkcs7::parse_certs_only(&p7).expect("parse");
    assert_eq!(certs.len(), 2, "leaf plus its issuing certificate");
}

#[test]
fn error_codes_are_stable() {
    assert_eq!(EstError::InvalidCsr.code(), "csr_invalid");
    assert_eq!(EstError::IssuerUnavailable.code(), "issuer_unavailable");
    assert_eq!(EstError::PolicyDenied(Vec::new()).code(), "policy_denied");
}
