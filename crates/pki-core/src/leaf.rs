//! End-entity certificate issuance (ADR 0066 domain model).
//!
//! Three entry points cover the enrollment shapes the certificate manager
//! supports: sign a client-supplied CSR, generate the key on the Host and sign
//! it, or self-sign for a profile with `issuer_type = 'self_signed'`. All
//! three share one parameter type, so a CRL distribution point or an OCSP
//! responder URL is embedded identically whichever path issued the
//! certificate.
//!
//! Secrecy invariant: [`IssuedLeaf`] is public material — certificate, chain,
//! serial, fingerprint and validity — so it is `Clone` and `Serialize`. When a
//! managed key is generated it is returned *beside* the leaf as a
//! [`KeyPair`], which is neither.

use rcgen::{CertificateParams, CrlDistributionPoint, IsCa, SerialNumber};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use x509_parser::prelude::parse_x509_certificate;

use crate::bundle;
use crate::csr;
use crate::error::PkiError;
use crate::keys::{self, KeyPair};
use crate::params::{
    apply_subject, authority_info_access, check_distribution_urls, ext_key_usage_to_rcgen,
    key_usage_to_rcgen, san_to_rcgen,
};
use crate::types::{BasicConstraints, ExtendedKeyUsage, KeyAlgorithm, KeyUsage, SanEntry, SubjectDn};
use crate::x509;

/// Everything an issuance decides about the certificate it is about to sign.
#[derive(Clone, Debug)]
pub struct LeafParams {
    /// The subject distinguished name to certify.
    pub subject: SubjectDn,
    /// The subject alternative names to certify.
    pub sans: Vec<SanEntry>,
    /// Start of the validity window.
    pub not_before: OffsetDateTime,
    /// End of the validity window.
    pub not_after: OffsetDateTime,
    /// Key usages to assert.
    pub key_usages: Vec<KeyUsage>,
    /// Extended key usages to assert.
    pub ext_key_usages: Vec<ExtendedKeyUsage>,
    /// Basic constraints; `None` omits the extension, which for an end-entity
    /// certificate is equivalent to `CA:FALSE`.
    pub basic_constraints: Option<BasicConstraints>,
    /// CRL distribution point URLs (extension OID 2.5.29.31).
    pub crl_distribution_points: Vec<String>,
    /// OCSP responder URLs, embedded as authority information access
    /// (extension OID 1.3.6.1.5.5.7.1.1, access method `id-ad-ocsp`).
    pub ocsp_urls: Vec<String>,
    /// An explicit 16-byte serial; a random one is generated when absent.
    pub serial: Option<[u8; 16]>,
}

impl LeafParams {
    /// Parameters for a plain end-entity certificate over `subject` and
    /// `sans`, valid across the supplied window, with no revocation URLs.
    pub fn new(
        subject: SubjectDn,
        sans: Vec<SanEntry>,
        not_before: OffsetDateTime,
        not_after: OffsetDateTime,
    ) -> Self {
        Self {
            subject,
            sans,
            not_before,
            not_after,
            key_usages: Vec::new(),
            ext_key_usages: Vec::new(),
            basic_constraints: None,
            crl_distribution_points: Vec::new(),
            ocsp_urls: Vec::new(),
            serial: None,
        }
    }
}

/// A signed end-entity certificate and the public facts about it.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct IssuedLeaf {
    /// The certificate, PEM-encoded.
    pub certificate_pem: String,
    /// The issuer chain, PEM-encoded, leaf **excluded**. Empty for a
    /// self-signed certificate.
    pub chain_pem: String,
    /// The certificate's serial number, canonical lowercase hex.
    pub serial_hex: String,
    /// Lowercase hex SHA-256 of the certificate's DER encoding.
    pub fingerprint_sha256: String,
    /// Start of the validity window, as encoded in the certificate.
    #[serde(with = "time::serde::rfc3339")]
    pub not_before: OffsetDateTime,
    /// End of the validity window, as encoded in the certificate.
    #[serde(with = "time::serde::rfc3339")]
    pub not_after: OffsetDateTime,
}

/// Builds the certificate parameters shared by every issuance path.
fn leaf_params(params: &LeafParams) -> Result<CertificateParams, PkiError> {
    if params.not_before >= params.not_after {
        return Err(PkiError::InvalidValidity);
    }
    if params.sans.len() > x509::MAX_TOTAL_SANS {
        return Err(PkiError::TooLarge);
    }
    check_distribution_urls(&params.crl_distribution_points)?;

    let mut built = CertificateParams::default();
    apply_subject(&mut built, &params.subject)?;
    built.subject_alt_names = params
        .sans
        .iter()
        .map(san_to_rcgen)
        .collect::<Result<Vec<_>, _>>()?;
    built.not_before = params.not_before;
    built.not_after = params.not_after;
    built.key_usages = params
        .key_usages
        .iter()
        .copied()
        .map(key_usage_to_rcgen)
        .collect();
    built.extended_key_usages = params
        .ext_key_usages
        .iter()
        .copied()
        .map(ext_key_usage_to_rcgen)
        .collect();
    built.is_ca = match params.basic_constraints {
        Some(BasicConstraints { ca: true, max_path_len }) => IsCa::Ca(max_path_len.map_or(
            rcgen::BasicConstraints::Unconstrained,
            rcgen::BasicConstraints::Constrained,
        )),
        Some(BasicConstraints { ca: false, .. }) => IsCa::ExplicitNoCa,
        None => IsCa::NoCa,
    };
    if !params.crl_distribution_points.is_empty() {
        built.crl_distribution_points = vec![CrlDistributionPoint {
            uris: params.crl_distribution_points.clone(),
        }];
    }
    if !params.ocsp_urls.is_empty() {
        built
            .custom_extensions
            .push(authority_info_access(&params.ocsp_urls)?);
    }
    built.serial_number = Some(params.serial.map_or_else(
        || SerialNumber::from_slice(&rand::random::<[u8; 16]>()),
        |bytes| SerialNumber::from_slice(&bytes),
    ));
    Ok(built)
}

/// Turns a freshly signed certificate into an [`IssuedLeaf`].
fn issued_leaf(certificate_pem: String, chain_pem: String) -> Result<IssuedLeaf, PkiError> {
    let blocks = x509::parse_pem_blocks(&certificate_pem, x509::LABEL_CERTIFICATE, 1)?;
    let der = blocks.first().ok_or(PkiError::InvalidPem)?;
    let (_, parsed) = parse_x509_certificate(der).map_err(|_| PkiError::InvalidDer)?;
    Ok(IssuedLeaf {
        serial_hex: x509::serial_hex(parsed.raw_serial()),
        fingerprint_sha256: x509::fingerprint_of_der(der),
        not_before: parsed.validity().not_before.to_datetime(),
        not_after: parsed.validity().not_after.to_datetime(),
        certificate_pem,
        chain_pem,
    })
}

/// Reconstructs the issuer as a signing context and normalizes its chain.
fn issuer_context(
    issuer_cert_pem: &str,
    issuer_key: &KeyPair,
) -> Result<(rcgen::Certificate, String), PkiError> {
    let chain = bundle::normalize_chain(issuer_cert_pem)?;
    let issuer_leaf = chain.first().ok_or(PkiError::ChainInvalid)?;
    crate::ca::validate_ca(issuer_leaf, Some(issuer_key))?;
    let issuer_params =
        CertificateParams::from_ca_cert_pem(issuer_leaf).map_err(|_| PkiError::InvalidPem)?;
    let issuer = issuer_params
        .self_signed(issuer_key.rcgen())
        .map_err(|_| PkiError::CertificateBuild)?;
    Ok((issuer, chain.join("")))
}

/// Signs a client-supplied CSR under `issuer_cert_pem`.
///
/// Only the public key is taken from the request. Subject, SANs, usages,
/// validity and extension URLs all come from `params`, so a policy decision
/// made before this call cannot be smuggled past by a crafted request.
///
/// # Errors
/// Returns [`PkiError::CsrParse`] for an unusable request,
/// [`PkiError::ChainInvalid`] or [`PkiError::NotACertificateAuthority`] for an
/// unusable issuer, [`PkiError::KeyMismatch`] when the issuer key does not
/// match its certificate, [`PkiError::InvalidValidity`] for an inverted
/// window, and [`PkiError::CertificateBuild`] when signing fails.
pub fn issue_leaf_from_csr(
    issuer_cert_pem: &str,
    issuer_key: &KeyPair,
    csr_pem: &str,
    params: &LeafParams,
) -> Result<IssuedLeaf, PkiError> {
    let request = csr::parse_csr(csr_pem)?;
    let public_key = rcgen::SubjectPublicKeyInfo::from_der(&request.public_key_der)
        .map_err(|_| PkiError::CsrParse)?;
    let (issuer, chain_pem) = issuer_context(issuer_cert_pem, issuer_key)?;
    let mut built = leaf_params(params)?;
    built.use_authority_key_identifier_extension = true;
    let certificate = built
        .signed_by(&public_key, &issuer, issuer_key.rcgen())
        .map_err(|_| PkiError::CertificateBuild)?;
    issued_leaf(certificate.pem(), chain_pem)
}

/// Generates a key on the Host and signs a certificate for it under
/// `issuer_cert_pem`.
///
/// # Errors
/// As [`issue_leaf_from_csr`], plus [`PkiError::KeyGeneration`] when the
/// managed key cannot be produced.
pub fn issue_leaf_with_generated_key(
    issuer_cert_pem: &str,
    issuer_key: &KeyPair,
    params: &LeafParams,
    key_algorithm: KeyAlgorithm,
) -> Result<(IssuedLeaf, KeyPair), PkiError> {
    let (issuer, chain_pem) = issuer_context(issuer_cert_pem, issuer_key)?;
    let key = keys::generate(key_algorithm)?;
    let mut built = leaf_params(params)?;
    built.use_authority_key_identifier_extension = true;
    let certificate = built
        .signed_by(key.rcgen(), &issuer, issuer_key.rcgen())
        .map_err(|_| PkiError::CertificateBuild)?;
    Ok((issued_leaf(certificate.pem(), chain_pem)?, key))
}

/// Generates a key and a self-signed certificate for it — the
/// `issuer_type = 'self_signed'` profile shape.
///
/// # Errors
/// Returns [`PkiError::InvalidValidity`] for an inverted window,
/// [`PkiError::InvalidName`] for an unusable subject or SAN,
/// [`PkiError::KeyGeneration`] when the key cannot be produced, and
/// [`PkiError::CertificateBuild`] when signing fails.
pub fn issue_self_signed(
    params: &LeafParams,
    key_algorithm: KeyAlgorithm,
) -> Result<(IssuedLeaf, KeyPair), PkiError> {
    let key = keys::generate(key_algorithm)?;
    let built = leaf_params(params)?;
    let certificate = built
        .self_signed(key.rcgen())
        .map_err(|_| PkiError::CertificateBuild)?;
    Ok((issued_leaf(certificate.pem(), String::new())?, key))
}

#[cfg(test)]
mod tests {
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
            let request =
                csr::generate_csr(&SubjectDn::common_name("leaf.example.com"), &[], &subject_key)
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
            0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
            0x0f, 0x10,
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
}
