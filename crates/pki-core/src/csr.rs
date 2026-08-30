//! Certificate signing request handling (ADR 0066 domain model).
//!
//! [`parse_csr`] is the crate's most exposed parser: an ACME, EST or SCEP
//! enrollment hands it bytes that nobody has authenticated yet. It is
//! therefore bounded on every axis (256 KiB document, 100 DNS names, 16 IP
//! SANs, 256 SANs overall), it verifies the request's own proof of possession
//! before reporting any fact about it, and it is total — hostile input yields
//! [`PkiError`], never a panic.
//!
//! Secrecy invariant: a CSR is public material. Nothing in this module reads
//! or emits private-key bytes; [`generate_csr`] borrows a [`KeyPair`] purely
//! to sign the request.

use rcgen::CertificateParams;
use x509_parser::certification_request::X509CertificationRequest;
use x509_parser::extensions::ParsedExtension;
use x509_parser::prelude::FromDer as _;

use crate::error::PkiError;
use crate::keys::KeyPair;
use crate::params::{apply_subject, san_to_rcgen};
use crate::signer;
use crate::types::{KeyAlgorithm, SanEntry, SubjectDn};
use crate::x509;

/// What a certificate signing request asserts about its subject.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CsrFacts {
    /// The requested subject distinguished name.
    pub subject: SubjectDn,
    /// The requested subject alternative names, in the order they appear.
    pub sans: Vec<SanEntry>,
    /// The algorithm of the public key being certified.
    pub key_algorithm: KeyAlgorithm,
    /// The DER-encoded `SubjectPublicKeyInfo` being certified.
    pub public_key_der: Vec<u8>,
}

/// Parses a PEM certificate signing request and verifies its proof of
/// possession.
///
/// The request's own signature is checked against the public key it carries,
/// so a caller can trust that whoever produced the request holds the matching
/// private key before any policy is applied to it.
///
/// # Errors
/// Returns [`PkiError::TooLarge`] when the document or its name counts exceed
/// this crate's caps, [`PkiError::InvalidPem`] for a malformed PEM wrapper,
/// [`PkiError::CsrParse`] when the DER is malformed or the self-signature does
/// not verify, [`PkiError::UnsupportedAlgorithm`] for a key or signature
/// algorithm this engine does not issue, and [`PkiError::InvalidName`] for a
/// SAN type it does not model.
pub fn parse_csr(csr_pem: &str) -> Result<CsrFacts, PkiError> {
    let blocks = x509::parse_pem_blocks(csr_pem, x509::LABEL_CSR, 1)?;
    let der = blocks.first().ok_or(PkiError::InvalidPem)?;
    let (rest, request) =
        X509CertificationRequest::from_der(der).map_err(|_| PkiError::CsrParse)?;
    if !rest.is_empty() {
        return Err(PkiError::CsrParse);
    }

    let info = &request.certification_request_info;
    let key_algorithm = x509::key_algorithm_from_spki(&info.subject_pki)?;
    let signature_algorithm =
        x509::signature_algorithm_from_oid(&request.signature_algorithm.algorithm)?;
    let signature = request.signature_value.as_ref().to_vec();
    signer::verify(
        signature_algorithm,
        info.subject_pki.raw,
        info.raw,
        &signature,
    )
    .map_err(|_| PkiError::CsrParse)?;

    let mut sans = Vec::new();
    if let Some(extensions) = request.requested_extensions() {
        for extension in extensions {
            if let ParsedExtension::SubjectAlternativeName(names) = extension {
                sans.extend(x509::general_names_to_sans(&names.general_names)?);
            }
        }
    }
    enforce_san_caps(&sans)?;

    Ok(CsrFacts {
        subject: x509::subject_dn(&info.subject),
        sans,
        key_algorithm,
        public_key_der: info.subject_pki.raw.to_vec(),
    })
}

/// Rejects a SAN set that exceeds this crate's per-class or overall caps.
fn enforce_san_caps(sans: &[SanEntry]) -> Result<(), PkiError> {
    if sans.len() > x509::MAX_TOTAL_SANS {
        return Err(PkiError::TooLarge);
    }
    let dns = sans
        .iter()
        .filter(|entry| matches!(entry, SanEntry::Dns(_)))
        .count();
    let ips = sans
        .iter()
        .filter(|entry| matches!(entry, SanEntry::Ip(_)))
        .count();
    if dns > x509::MAX_DNS_NAMES || ips > x509::MAX_IP_SANS {
        return Err(PkiError::TooLarge);
    }
    Ok(())
}

/// Builds and signs a PEM certificate signing request for `key`.
///
/// # Errors
/// Returns [`PkiError::InvalidName`] when a subject attribute or SAN cannot be
/// encoded, [`PkiError::TooLarge`] when the SAN caps are exceeded, and
/// [`PkiError::CertificateBuild`] when the underlying builder refuses the
/// parameters.
pub fn generate_csr(
    subject: &SubjectDn,
    sans: &[SanEntry],
    key: &KeyPair,
) -> Result<String, PkiError> {
    enforce_san_caps(sans)?;
    let mut params = CertificateParams::default();
    apply_subject(&mut params, subject)?;
    params.subject_alt_names = sans
        .iter()
        .map(san_to_rcgen)
        .collect::<Result<Vec<_>, _>>()?;
    params
        .serialize_request(key.rcgen())
        .map_err(|_| PkiError::CertificateBuild)?
        .pem()
        .map_err(|_| PkiError::CertificateBuild)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys;

    fn subject() -> SubjectDn {
        SubjectDn {
            cn: Some("leaf.example.com".into()),
            o: Some("OpenSesame".into()),
            ou: Some("Platform".into()),
            c: Some("US".into()),
            st: Some("WA".into()),
            l: Some("Seattle".into()),
            dc: vec!["example".into()],
        }
    }

    fn sans() -> Vec<SanEntry> {
        vec![
            SanEntry::Dns("leaf.example.com".into()),
            SanEntry::Dns("alt.example.com".into()),
            SanEntry::Ip("10.1.2.3".parse().unwrap()),
            SanEntry::Email("ops@example.com".into()),
            SanEntry::Uri("https://example.com/leaf".into()),
            SanEntry::Upn("ops@corp.example".into()),
        ]
    }

    #[test]
    fn a_generated_request_round_trips_for_every_algorithm() {
        for algorithm in [
            KeyAlgorithm::EcdsaP256,
            KeyAlgorithm::EcdsaP384,
            KeyAlgorithm::Ed25519,
            KeyAlgorithm::Rsa2048,
        ] {
            let key = keys::generate(algorithm).unwrap();
            let pem = generate_csr(&subject(), &sans(), &key).unwrap();
            let facts = parse_csr(&pem).unwrap();
            assert_eq!(facts.key_algorithm, algorithm);
            assert_eq!(facts.subject, subject());
            assert_eq!(facts.sans, sans());
            assert_eq!(facts.public_key_der, key.public_key_der());
        }
    }

    #[test]
    fn a_request_with_no_sans_parses_with_an_empty_san_list() {
        let key = keys::generate(KeyAlgorithm::Ed25519).unwrap();
        let pem = generate_csr(&SubjectDn::common_name("bare"), &[], &key).unwrap();
        let facts = parse_csr(&pem).unwrap();
        assert!(facts.sans.is_empty());
        assert_eq!(facts.subject.cn.as_deref(), Some("bare"));
    }

    #[test]
    fn adversarial_a_tampered_request_fails_proof_of_possession() {
        let key = keys::generate(KeyAlgorithm::EcdsaP256).unwrap();
        let pem = generate_csr(&subject(), &sans(), &key).unwrap();
        let mut der = x509::parse_pem_blocks(&pem, x509::LABEL_CSR, 1).unwrap()[0].clone();
        // Flip a byte inside the subject, which the signature covers.
        let position = der.len() / 3;
        der[position] ^= 0x01;
        let tampered = x509::pem_encode(x509::LABEL_CSR, &der);
        assert!(parse_csr(&tampered).is_err());
    }

    #[test]
    fn adversarial_hostile_bytes_never_panic_and_always_error() {
        let hostile: Vec<String> = vec![
            String::new(),
            "-----BEGIN CERTIFICATE REQUEST-----".into(),
            "-----BEGIN CERTIFICATE REQUEST-----\n!!!!\n-----END CERTIFICATE REQUEST-----\n".into(),
            x509::pem_encode(x509::LABEL_CSR, &[]),
            x509::pem_encode(x509::LABEL_CSR, &[0x30, 0x80, 0x00, 0x00]),
            x509::pem_encode(x509::LABEL_CSR, &vec![0xffu8; 4096]),
            "\u{0}\u{0}\u{0}".into(),
        ];
        for input in hostile {
            assert!(parse_csr(&input).is_err());
        }
    }

    #[test]
    fn adversarial_a_megabyte_of_garbage_is_refused_on_size_alone() {
        let blob = "A".repeat(1024 * 1024);
        assert_eq!(parse_csr(&blob).unwrap_err(), PkiError::TooLarge);
    }

    #[test]
    fn adversarial_trailing_bytes_after_the_request_are_rejected() {
        let key = keys::generate(KeyAlgorithm::Ed25519).unwrap();
        let pem = generate_csr(&SubjectDn::common_name("x"), &[], &key).unwrap();
        let mut der = x509::parse_pem_blocks(&pem, x509::LABEL_CSR, 1).unwrap()[0].clone();
        der.push(0x00);
        assert!(parse_csr(&x509::pem_encode(x509::LABEL_CSR, &der)).is_err());
    }

    #[test]
    fn generation_refuses_more_names_than_the_engine_will_issue() {
        let key = keys::generate(KeyAlgorithm::Ed25519).unwrap();
        let too_many: Vec<SanEntry> = (0..=x509::MAX_DNS_NAMES)
            .map(|index| SanEntry::Dns(format!("host{index}.example.com")))
            .collect();
        assert_eq!(
            generate_csr(&SubjectDn::common_name("x"), &too_many, &key).unwrap_err(),
            PkiError::TooLarge
        );
        let too_many_ips: Vec<SanEntry> = (0..=x509::MAX_IP_SANS)
            .map(|index| {
                SanEntry::Ip(std::net::IpAddr::from([
                    10,
                    0,
                    0,
                    u8::try_from(index).unwrap_or_default(),
                ]))
            })
            .collect();
        assert_eq!(
            generate_csr(&SubjectDn::common_name("x"), &too_many_ips, &key).unwrap_err(),
            PkiError::TooLarge
        );
    }

    #[test]
    fn generation_refuses_an_empty_subject_and_empty_names() {
        let key = keys::generate(KeyAlgorithm::Ed25519).unwrap();
        assert_eq!(
            generate_csr(&SubjectDn::default(), &[], &key).unwrap_err(),
            PkiError::InvalidName
        );
        assert_eq!(
            generate_csr(
                &SubjectDn::common_name("x"),
                &[SanEntry::Dns(String::new())],
                &key
            )
            .unwrap_err(),
            PkiError::InvalidName
        );
    }

    #[test]
    fn a_request_at_exactly_the_name_caps_is_accepted() {
        let key = keys::generate(KeyAlgorithm::Ed25519).unwrap();
        let names: Vec<SanEntry> = (0..x509::MAX_DNS_NAMES)
            .map(|index| SanEntry::Dns(format!("host{index}.example.com")))
            .collect();
        let pem = generate_csr(&SubjectDn::common_name("many"), &names, &key).unwrap();
        assert_eq!(parse_csr(&pem).unwrap().sans.len(), x509::MAX_DNS_NAMES);
    }
}
