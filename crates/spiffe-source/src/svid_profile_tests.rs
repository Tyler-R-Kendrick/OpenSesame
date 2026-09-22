use std::time::Duration;

use chrono::Utc;
use rcgen::KeyUsagePurpose;

use super::{validate_leaf, SvidExpectation, SvidProfileError, SvidRole};
use crate::fake::{Eku, FakeTrustDomain, SvidSpec};

const TD: &str = "example.test";
const ID: &str = "spiffe://example.test/opensesame/gateway";

fn expect(id: Option<&'static str>, role: SvidRole) -> SvidExpectation<'static> {
    SvidExpectation {
        trust_domain: TD,
        spiffe_id: id,
        role,
    }
}

fn check(spec: &SvidSpec, exp: &SvidExpectation<'_>) -> Result<String, SvidProfileError> {
    let td = FakeTrustDomain::new(TD);
    let leaf = td.issue(spec);
    validate_leaf(leaf.leaf_der(), exp, Utc::now()).map(|f| f.spiffe_id)
}

#[test]
fn conforming_svid_passes_for_both_roles_and_reports_facts() {
    let td = FakeTrustDomain::new(TD);
    let leaf = td.issue_svid(ID, Duration::from_secs(600));
    for role in [SvidRole::Client, SvidRole::Server] {
        let facts = validate_leaf(leaf.leaf_der(), &expect(Some(ID), role), Utc::now()).unwrap();
        assert_eq!(facts.spiffe_id, ID);
        assert_eq!(facts.trust_domain, TD);
        assert_eq!(facts.leaf_thumbprint_sha256, leaf.leaf_thumbprint_sha256);
        assert!(facts.not_after > Utc::now());
    }
}

#[test]
fn at_spiffe_san_extra_uri_san_is_rejected() {
    let mut spec = SvidSpec::conforming(ID, Duration::from_secs(60));
    spec.uri_sans.push("spiffe://example.test/other".into());
    assert_eq!(
        check(&spec, &expect(None, SvidRole::Client)),
        Err(SvidProfileError::MultipleUriSans(2))
    );
}

#[test]
fn at_spiffe_san_dns_only_leaf_is_not_an_svid() {
    let mut spec = SvidSpec::conforming(ID, Duration::from_secs(60));
    spec.uri_sans.clear();
    spec.dns_sans.push("gateway.example.test".into());
    assert_eq!(
        check(&spec, &expect(None, SvidRole::Client)),
        Err(SvidProfileError::NoUriSan)
    );
    spec.dns_sans.clear();
    assert_eq!(
        check(&spec, &expect(None, SvidRole::Client)),
        Err(SvidProfileError::NoSubjectAltName)
    );
}

#[test]
fn at_spiffe_san_wrong_trust_domain_is_rejected_before_identity() {
    let spec = SvidSpec::conforming(
        "spiffe://other.test/opensesame/gateway",
        Duration::from_secs(60),
    );
    assert_eq!(
        check(&spec, &expect(Some(ID), SvidRole::Client)),
        Err(SvidProfileError::TrustDomainMismatch {
            expected: TD.into(),
            presented: "other.test".into()
        })
    );
}

#[test]
fn exact_identity_mismatch_is_rejected_even_in_the_right_domain() {
    let spec = SvidSpec::conforming(
        "spiffe://example.test/opensesame/worker",
        Duration::from_secs(60),
    );
    assert!(matches!(
        check(&spec, &expect(Some(ID), SvidRole::Client)),
        Err(SvidProfileError::IdentityMismatch { .. })
    ));
    assert!(check(&spec, &expect(None, SvidRole::Client)).is_ok());
}

#[test]
fn at_spiffe_san_confusables_are_not_valid_spiffe_ids() {
    for (uri, err) in [
        // The SDK lowercases the trust domain; the SAN is then not byte-equal
        // to its canonical form and is refused on that ground.
        (
            "spiffe://EXAMPLE.test/opensesame/gateway",
            SvidProfileError::NonCanonicalSpiffeId,
        ),
        (
            "spiffe://example.test/opensesame/%67ateway",
            SvidProfileError::InvalidSpiffeId,
        ),
        (
            "spiffe://example.test/opensesame/gateway/",
            SvidProfileError::InvalidSpiffeId,
        ),
        (
            "spiffe://example.test/opensesame/../gateway",
            SvidProfileError::InvalidSpiffeId,
        ),
        (
            "spiffe://example.test/opensesame/gateway?x=1",
            SvidProfileError::InvalidSpiffeId,
        ),
        (
            "SPIFFE://example.test/opensesame/gateway",
            SvidProfileError::NonCanonicalSpiffeId,
        ),
        (
            "https://example.test/opensesame/gateway",
            SvidProfileError::InvalidSpiffeId,
        ),
        ("spiffe://example.test", SvidProfileError::RootSpiffeId),
    ] {
        let mut spec = SvidSpec::conforming(ID, Duration::from_secs(60));
        spec.uri_sans = vec![uri.into()];
        assert_eq!(
            check(&spec, &expect(None, SvidRole::Client)),
            Err(err),
            "{uri}"
        );
    }
}

#[test]
fn at_spiffe_san_case_variant_path_is_a_different_identity_not_a_match() {
    let spec = SvidSpec::conforming(
        "spiffe://example.test/opensesame/Gateway",
        Duration::from_secs(60),
    );
    assert!(matches!(
        check(&spec, &expect(Some(ID), SvidRole::Client)),
        Err(SvidProfileError::IdentityMismatch { .. })
    ));
}

#[test]
fn at_tls_purpose_ca_leaf_and_signing_key_usage_are_rejected() {
    let mut ca = SvidSpec::conforming(ID, Duration::from_secs(60));
    ca.is_ca = true;
    ca.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::DigitalSignature,
    ];
    assert_eq!(
        check(&ca, &expect(None, SvidRole::Client)),
        Err(SvidProfileError::LeafIsCa)
    );

    let mut signer = SvidSpec::conforming(ID, Duration::from_secs(60));
    signer.key_usages = vec![
        KeyUsagePurpose::DigitalSignature,
        KeyUsagePurpose::KeyCertSign,
    ];
    assert_eq!(
        check(&signer, &expect(None, SvidRole::Client)),
        Err(SvidProfileError::KeyUsageSigning)
    );
    signer.key_usages = vec![KeyUsagePurpose::DigitalSignature, KeyUsagePurpose::CrlSign];
    assert_eq!(
        check(&signer, &expect(None, SvidRole::Client)),
        Err(SvidProfileError::KeyUsageSigning)
    );
}

#[test]
fn at_tls_purpose_key_usage_must_be_present_critical_and_digital_signature() {
    let mut spec = SvidSpec::conforming(ID, Duration::from_secs(60));
    spec.key_usages = vec![KeyUsagePurpose::KeyEncipherment];
    assert_eq!(
        check(&spec, &expect(None, SvidRole::Client)),
        Err(SvidProfileError::KeyUsageNoDigitalSignature)
    );
    spec.key_usages.clear();
    assert_eq!(
        check(&spec, &expect(None, SvidRole::Client)),
        Err(SvidProfileError::KeyUsageMissing)
    );
    spec.non_critical_key_usage = true;
    assert_eq!(
        check(&spec, &expect(None, SvidRole::Client)),
        Err(SvidProfileError::KeyUsageNotCritical)
    );
}

#[test]
fn at_tls_purpose_eku_must_match_role_and_be_dual_when_present() {
    let mut spec = SvidSpec::conforming(ID, Duration::from_secs(60));
    spec.eku = Eku::ServerOnly;
    assert_eq!(
        check(&spec, &expect(None, SvidRole::Client)),
        Err(SvidProfileError::ExtendedKeyUsageLacks {
            needed: "client_auth"
        })
    );
    assert_eq!(
        check(&spec, &expect(None, SvidRole::Server)),
        Err(SvidProfileError::ExtendedKeyUsageLacks {
            needed: "client_auth"
        }),
        "standard §4.4: when present, both serverAuth and clientAuth must be set"
    );
    spec.eku = Eku::ClientOnly;
    assert_eq!(
        check(&spec, &expect(None, SvidRole::Server)),
        Err(SvidProfileError::ExtendedKeyUsageLacks {
            needed: "server_auth"
        })
    );
    spec.eku = Eku::CodeSigningOnly;
    assert!(check(&spec, &expect(None, SvidRole::Client)).is_err());
    spec.eku = Eku::Absent;
    assert!(check(&spec, &expect(None, SvidRole::Client)).is_ok());
    assert!(check(&spec, &expect(None, SvidRole::Server)).is_ok());
}

#[test]
fn unknown_critical_extension_and_validity_window_are_enforced() {
    let mut spec = SvidSpec::conforming(ID, Duration::from_secs(60));
    spec.unknown_critical_extension = true;
    assert_eq!(
        check(&spec, &expect(None, SvidRole::Client)),
        Err(SvidProfileError::UnknownCriticalExtension)
    );
    let mut future = SvidSpec::conforming(ID, Duration::from_secs(60));
    future.not_before = Utc::now() + chrono::Duration::hours(1);
    future.not_after = Utc::now() + chrono::Duration::hours(2);
    assert_eq!(
        check(&future, &expect(None, SvidRole::Client)),
        Err(SvidProfileError::NotYetValid)
    );
    let mut past = SvidSpec::conforming(ID, Duration::from_secs(60));
    past.not_before = Utc::now() - chrono::Duration::hours(2);
    past.not_after = Utc::now() - chrono::Duration::hours(1);
    assert_eq!(
        check(&past, &expect(None, SvidRole::Client)),
        Err(SvidProfileError::Expired)
    );
}

#[test]
fn garbage_is_malformed_not_a_panic() {
    assert_eq!(
        validate_leaf(&[0x30, 0x01], &expect(None, SvidRole::Client), Utc::now()),
        Err(SvidProfileError::Malformed)
    );
    let td = FakeTrustDomain::new(TD);
    let mut der = td
        .issue_svid(ID, Duration::from_secs(60))
        .leaf_der()
        .to_vec();
    der.push(0);
    assert_eq!(
        validate_leaf(&der, &expect(None, SvidRole::Client), Utc::now()),
        Err(SvidProfileError::Malformed),
        "trailing bytes"
    );
}
