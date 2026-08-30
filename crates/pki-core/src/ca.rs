//! Certificate authority generation and validation (ADR 0066 domain model).
//!
//! A root is self-signed here; an intermediate is produced in two steps — a
//! CSR from [`generate_intermediate_csr`], signed either by a parent this Host
//! holds ([`sign_intermediate`]) or by an external CA. [`validate_ca`] is the
//! gate every issuance path runs first, and it preserves the checks the
//! gateway's `dev_pki::validate_ca` already enforces: basic constraints say
//! CA, key usage includes `keyCertSign`, the private key (when supplied)
//! matches the certificate's public key, and a self-signed certificate
//! verifies under its own key.
//!
//! Secrecy invariant: [`GeneratedCa`] carries a private key, so it implements
//! neither `Clone` nor `Serialize` and its `Debug` is redacted. `CaFacts`
//! carries only public material and is freely serializable.

use rcgen::{
    BasicConstraints, CertificateParams, CrlDistributionPoint, IsCa, KeyUsagePurpose, SerialNumber,
};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use x509_parser::prelude::{parse_x509_certificate, X509Certificate};

use crate::error::PkiError;
use crate::keys::{self, KeyPair};
use crate::params::{apply_subject, check_distribution_urls};
use crate::types::{KeyAlgorithm, SubjectDn};
use crate::x509;

/// Parameters for generating a certificate authority.
#[derive(Clone, Debug)]
pub struct CaParams {
    /// The authority's subject distinguished name.
    pub subject: SubjectDn,
    /// The key algorithm to generate.
    pub key_algorithm: KeyAlgorithm,
    /// Start of the validity window.
    pub not_before: OffsetDateTime,
    /// End of the validity window.
    pub not_after: OffsetDateTime,
    /// `pathLenConstraint`; `None` means unconstrained.
    pub path_len: Option<u8>,
    /// CRL distribution point URLs embedded in the authority certificate.
    pub crl_distribution_points: Vec<String>,
}

/// A newly generated certificate authority: its certificate, its private key,
/// and the serial it was issued under.
///
/// Not `Clone`, not `Serialize`, redacted `Debug` — see the module docs.
pub struct GeneratedCa {
    /// The authority certificate, PEM-encoded.
    pub certificate_pem: String,
    /// The authority's private key.
    pub key: KeyPair,
    /// The certificate's serial number, canonical lowercase hex.
    pub serial_hex: String,
}

impl std::fmt::Debug for GeneratedCa {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("GeneratedCa")
            .field("certificate_pem", &"[PUBLIC CERTIFICATE]")
            .field("key", &"<redacted>")
            .field("serial_hex", &self.serial_hex)
            .finish()
    }
}

/// What [`validate_ca`] established about a certificate authority.
///
/// Public material only.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CaFacts {
    /// The authority's subject distinguished name.
    pub subject: SubjectDn,
    /// Start of the validity window.
    #[serde(with = "time::serde::rfc3339")]
    pub not_before: OffsetDateTime,
    /// End of the validity window.
    #[serde(with = "time::serde::rfc3339")]
    pub not_after: OffsetDateTime,
    /// `pathLenConstraint`; `None` means unconstrained.
    pub path_len: Option<u8>,
    /// Whether the certificate verifies under its own public key.
    pub is_self_signed: bool,
    /// The certificate's serial number, canonical lowercase hex.
    pub serial_hex: String,
    /// Lowercase hex SHA-256 of the certificate's DER encoding.
    pub fingerprint_sha256: String,
}

/// The key usages every authority certificate this engine issues carries.
const CA_KEY_USAGES: [KeyUsagePurpose; 3] = [
    KeyUsagePurpose::DigitalSignature,
    KeyUsagePurpose::KeyCertSign,
    KeyUsagePurpose::CrlSign,
];

/// Builds the shared certificate parameters for an authority.
fn ca_params(params: &CaParams) -> Result<CertificateParams, PkiError> {
    if params.not_before >= params.not_after {
        return Err(PkiError::InvalidValidity);
    }
    check_distribution_urls(&params.crl_distribution_points)?;
    let mut built = CertificateParams::default();
    apply_subject(&mut built, &params.subject)?;
    built.is_ca = IsCa::Ca(params.path_len.map_or(
        BasicConstraints::Unconstrained,
        BasicConstraints::Constrained,
    ));
    built.key_usages = CA_KEY_USAGES.to_vec();
    built.not_before = params.not_before;
    built.not_after = params.not_after;
    built.subject_alt_names = Vec::new();
    if !params.crl_distribution_points.is_empty() {
        built.crl_distribution_points = vec![CrlDistributionPoint {
            uris: params.crl_distribution_points.clone(),
        }];
    }
    Ok(built)
}

/// A fresh random 16-byte serial number.
fn random_serial() -> SerialNumber {
    SerialNumber::from_slice(&rand::random::<[u8; 16]>())
}

/// Generates a self-signed root certificate authority.
///
/// The certificate is marked `CA:TRUE`, carries `digitalSignature`,
/// `keyCertSign` and `cRLSign`, and — like every certificate this builder
/// emits — a subject key identifier derived from the public key.
///
/// # Errors
/// Returns [`PkiError::InvalidValidity`] for an inverted validity window,
/// [`PkiError::InvalidName`] for an unusable subject,
/// [`PkiError::KeyGeneration`] when the key cannot be produced, and
/// [`PkiError::CertificateBuild`] when the builder refuses the parameters.
pub fn generate_root(params: &CaParams) -> Result<GeneratedCa, PkiError> {
    let mut built = ca_params(params)?;
    let serial = random_serial();
    let serial_hex = x509::serial_hex(&serial.to_bytes());
    built.serial_number = Some(serial);
    let key = keys::generate(params.key_algorithm)?;
    let certificate = built
        .self_signed(key.rcgen())
        .map_err(|_| PkiError::CertificateBuild)?;
    Ok(GeneratedCa {
        certificate_pem: certificate.pem(),
        key,
        serial_hex,
    })
}

/// Generates a key and a certificate signing request for a subordinate
/// authority, to be signed by a parent CA — this Host's, via
/// [`sign_intermediate`], or an external one.
///
/// # Errors
/// Returns [`PkiError::InvalidValidity`] for an inverted validity window,
/// [`PkiError::InvalidName`] for an unusable subject,
/// [`PkiError::KeyGeneration`] when the key cannot be produced, and
/// [`PkiError::CertificateBuild`] when the request cannot be serialized.
pub fn generate_intermediate_csr(params: &CaParams) -> Result<(String, KeyPair), PkiError> {
    let built = ca_params(params)?;
    let key = keys::generate(params.key_algorithm)?;
    let csr_pem = built
        .serialize_request(key.rcgen())
        .map_err(|_| PkiError::CertificateBuild)?
        .pem()
        .map_err(|_| PkiError::CertificateBuild)?;
    Ok((csr_pem, key))
}

/// Signs a subordinate authority certificate under `parent_cert_pem`.
///
/// The subject, validity window, path length and distribution points come from
/// `params`, not from the request: a CA decides what it certifies. Only the
/// public key is taken from the CSR.
///
/// The parent's own `basicConstraints` budget is enforced. A parent with
/// `pathLenConstraint: 0` may not certify another authority at all, and a
/// parent with `pathLenConstraint: n` may not certify a child asking for more
/// than `n - 1`, nor one asking to be unconstrained.
///
/// # Errors
/// Returns [`PkiError::PathLenExceeded`] when the parent's budget forbids the
/// child, [`PkiError::NotACertificateAuthority`] when the parent is not a
/// usable authority, [`PkiError::CsrParse`] for an unusable request,
/// [`PkiError::InvalidValidity`] for an inverted window, and
/// [`PkiError::CertificateBuild`] when signing fails.
pub fn sign_intermediate(
    parent_cert_pem: &str,
    parent_key: &KeyPair,
    csr_pem: &str,
    params: &CaParams,
) -> Result<String, PkiError> {
    let parent = validate_ca(parent_cert_pem, Some(parent_key))?;
    check_path_len_budget(parent.path_len, params.path_len)?;

    let request = crate::csr::parse_csr(csr_pem)?;
    let public_key = rcgen::SubjectPublicKeyInfo::from_der(&request.public_key_der)
        .map_err(|_| PkiError::CsrParse)?;

    let mut built = ca_params(params)?;
    built.serial_number = Some(random_serial());
    built.use_authority_key_identifier_extension = true;

    let issuer_params =
        CertificateParams::from_ca_cert_pem(parent_cert_pem).map_err(|_| PkiError::InvalidPem)?;
    let issuer = issuer_params
        .self_signed(parent_key.rcgen())
        .map_err(|_| PkiError::CertificateBuild)?;

    let certificate = built
        .signed_by(&public_key, &issuer, parent_key.rcgen())
        .map_err(|_| PkiError::CertificateBuild)?;
    Ok(certificate.pem())
}

/// Enforces the parent's `pathLenConstraint` budget against a child CA.
///
/// # Errors
/// Returns [`PkiError::PathLenExceeded`] when the child would exceed it.
fn check_path_len_budget(parent: Option<u8>, child: Option<u8>) -> Result<(), PkiError> {
    let Some(parent_budget) = parent else {
        return Ok(());
    };
    if parent_budget == 0 {
        return Err(PkiError::PathLenExceeded);
    }
    match child {
        None => Err(PkiError::PathLenExceeded),
        Some(child_budget) if child_budget > parent_budget - 1 => Err(PkiError::PathLenExceeded),
        Some(_) => Ok(()),
    }
}

/// Validates that a certificate is a usable signing authority and reports what
/// it says about itself.
///
/// When `key` is supplied its public half must match the certificate's, which
/// is the check that catches a CA record whose sealed key and certificate have
/// drifted apart. A self-signed certificate must additionally verify under its
/// own key.
///
/// # Errors
/// Returns [`PkiError::InvalidPem`] or [`PkiError::InvalidDer`] for
/// unparseable input, [`PkiError::NotACertificateAuthority`] when basic
/// constraints or key usage do not permit signing, [`PkiError::KeyMismatch`]
/// when `key` does not match, and [`PkiError::ChainInvalid`] when a self-signed
/// certificate fails its own signature check.
pub fn validate_ca(cert_pem: &str, key: Option<&KeyPair>) -> Result<CaFacts, PkiError> {
    let blocks = x509::parse_pem_blocks(cert_pem, x509::LABEL_CERTIFICATE, 1)?;
    let der = blocks.first().ok_or(PkiError::InvalidPem)?;
    let (rest, certificate) =
        parse_x509_certificate(der).map_err(|_| PkiError::InvalidDer)?;
    if !rest.is_empty() {
        return Err(PkiError::InvalidDer);
    }

    let constraints = certificate
        .basic_constraints()
        .map_err(|_| PkiError::InvalidDer)?
        .map(|extension| extension.value);
    let is_ca = constraints.is_some_and(|value| value.ca);
    let can_sign = certificate
        .key_usage()
        .map_err(|_| PkiError::InvalidDer)?
        .is_some_and(|usage| usage.value.key_cert_sign());
    if !is_ca || !can_sign {
        return Err(PkiError::NotACertificateAuthority);
    }

    if let Some(key) = key {
        if certificate.public_key().raw != key.public_key_der() {
            return Err(PkiError::KeyMismatch);
        }
    }

    let is_self_signed = certificate.subject() == certificate.issuer()
        && certificate.verify_signature(None).is_ok();
    if certificate.subject() == certificate.issuer() && !is_self_signed {
        return Err(PkiError::ChainInvalid);
    }

    Ok(CaFacts {
        subject: x509::subject_dn(certificate.subject()),
        not_before: certificate.validity().not_before.to_datetime(),
        not_after: certificate.validity().not_after.to_datetime(),
        path_len: path_len_of(&certificate),
        is_self_signed,
        serial_hex: x509::serial_hex(certificate.raw_serial()),
        fingerprint_sha256: x509::fingerprint_of_der(der),
    })
}

/// Reads a certificate's `pathLenConstraint`, clamped into a `u8`.
fn path_len_of(certificate: &X509Certificate<'_>) -> Option<u8> {
    certificate
        .basic_constraints()
        .ok()
        .flatten()
        .and_then(|extension| extension.value.path_len_constraint)
        .and_then(|value| u8::try_from(value).ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::Duration;

    pub(crate) fn window() -> (OffsetDateTime, OffsetDateTime) {
        let now = OffsetDateTime::now_utc();
        (now - Duration::minutes(1), now + Duration::days(365))
    }

    pub(crate) fn root_params(algorithm: KeyAlgorithm, path_len: Option<u8>) -> CaParams {
        let (not_before, not_after) = window();
        CaParams {
            subject: SubjectDn {
                cn: Some("OpenSesame Test Root".into()),
                o: Some("OpenSesame".into()),
                ..SubjectDn::default()
            },
            key_algorithm: algorithm,
            not_before,
            not_after,
            path_len,
            crl_distribution_points: vec!["http://crl.example.com/root.crl".into()],
        }
    }

    #[test]
    fn a_root_is_self_signed_and_reports_its_own_facts() {
        for algorithm in [
            KeyAlgorithm::EcdsaP256,
            KeyAlgorithm::EcdsaP384,
            KeyAlgorithm::Ed25519,
        ] {
            let root = generate_root(&root_params(algorithm, None)).unwrap();
            let facts = validate_ca(&root.certificate_pem, Some(&root.key)).unwrap();
            assert!(facts.is_self_signed);
            assert_eq!(facts.path_len, None);
            assert_eq!(facts.serial_hex, root.serial_hex);
            assert_eq!(facts.subject.cn.as_deref(), Some("OpenSesame Test Root"));
            assert_eq!(facts.fingerprint_sha256.len(), 64);
        }
    }

    #[test]
    fn a_root_with_a_path_length_reports_it() {
        let root = generate_root(&root_params(KeyAlgorithm::EcdsaP256, Some(2))).unwrap();
        assert_eq!(
            validate_ca(&root.certificate_pem, None).unwrap().path_len,
            Some(2)
        );
    }

    #[test]
    fn an_intermediate_is_signed_by_its_parent_and_is_not_self_signed() {
        let root = generate_root(&root_params(KeyAlgorithm::EcdsaP256, Some(1))).unwrap();
        let mut child = root_params(KeyAlgorithm::EcdsaP256, Some(0));
        child.subject = SubjectDn::common_name("OpenSesame Test Intermediate");
        let (csr, child_key) = generate_intermediate_csr(&child).unwrap();
        let intermediate =
            sign_intermediate(&root.certificate_pem, &root.key, &csr, &child).unwrap();
        let facts = validate_ca(&intermediate, Some(&child_key)).unwrap();
        assert!(!facts.is_self_signed);
        assert_eq!(facts.path_len, Some(0));
        assert_eq!(
            facts.subject.cn.as_deref(),
            Some("OpenSesame Test Intermediate")
        );
    }

    #[test]
    fn adversarial_a_path_len_zero_parent_refuses_to_sign_another_ca() {
        let root = generate_root(&root_params(KeyAlgorithm::EcdsaP256, Some(0))).unwrap();
        let mut child = root_params(KeyAlgorithm::EcdsaP256, Some(0));
        child.subject = SubjectDn::common_name("Forbidden Intermediate");
        let (csr, _) = generate_intermediate_csr(&child).unwrap();
        assert_eq!(
            sign_intermediate(&root.certificate_pem, &root.key, &csr, &child).unwrap_err(),
            PkiError::PathLenExceeded
        );
    }

    #[test]
    fn adversarial_a_child_may_not_widen_its_parents_budget() {
        assert!(check_path_len_budget(None, None).is_ok());
        assert!(check_path_len_budget(None, Some(5)).is_ok());
        assert!(check_path_len_budget(Some(2), Some(1)).is_ok());
        assert!(check_path_len_budget(Some(2), Some(0)).is_ok());
        assert_eq!(
            check_path_len_budget(Some(2), Some(2)).unwrap_err(),
            PkiError::PathLenExceeded
        );
        assert_eq!(
            check_path_len_budget(Some(2), None).unwrap_err(),
            PkiError::PathLenExceeded
        );
        assert_eq!(
            check_path_len_budget(Some(0), Some(0)).unwrap_err(),
            PkiError::PathLenExceeded
        );
    }

    #[test]
    fn adversarial_validation_rejects_a_mismatched_key() {
        let root = generate_root(&root_params(KeyAlgorithm::EcdsaP256, None)).unwrap();
        let other = keys::generate(KeyAlgorithm::EcdsaP256).unwrap();
        assert_eq!(
            validate_ca(&root.certificate_pem, Some(&other)).unwrap_err(),
            PkiError::KeyMismatch
        );
    }

    #[test]
    fn adversarial_validation_rejects_a_leaf_offered_as_an_authority() {
        let root = generate_root(&root_params(KeyAlgorithm::EcdsaP256, None)).unwrap();
        let leaf_key = keys::generate(KeyAlgorithm::EcdsaP256).unwrap();
        let mut params = CertificateParams::new(vec!["leaf.example.com".to_owned()]).unwrap();
        params.is_ca = IsCa::NoCa;
        let issuer_params = CertificateParams::from_ca_cert_pem(&root.certificate_pem).unwrap();
        let issuer = issuer_params.self_signed(root.key.rcgen()).unwrap();
        let leaf = params
            .signed_by(leaf_key.rcgen(), &issuer, root.key.rcgen())
            .unwrap()
            .pem();
        assert_eq!(
            validate_ca(&leaf, None).unwrap_err(),
            PkiError::NotACertificateAuthority
        );
    }

    #[test]
    fn adversarial_hostile_certificate_bytes_never_panic() {
        for hostile in [
            String::new(),
            "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n".into(),
            x509::pem_encode(x509::LABEL_CERTIFICATE, &[0x30, 0x82, 0xff, 0xff]),
            "A".repeat(1024 * 1024),
        ] {
            assert!(validate_ca(&hostile, None).is_err());
        }
    }

    #[test]
    fn an_inverted_validity_window_is_refused() {
        let mut params = root_params(KeyAlgorithm::EcdsaP256, None);
        std::mem::swap(&mut params.not_before, &mut params.not_after);
        assert_eq!(
            generate_root(&params).unwrap_err(),
            PkiError::InvalidValidity
        );
    }

    #[test]
    fn generated_ca_debug_never_renders_private_material() {
        let root = generate_root(&root_params(KeyAlgorithm::Ed25519, None)).unwrap();
        let rendered = format!("{root:?}");
        assert!(rendered.contains("<redacted>"));
        assert!(!rendered.contains("BEGIN PRIVATE KEY"));
    }
}
