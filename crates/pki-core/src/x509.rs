//! Bounded X.509 parsing helpers shared by the public modules (ADR 0066
//! domain model).
//!
//! Everything here takes attacker-controlled bytes, so every entry point is
//! size-capped, cardinality-capped and total: it returns [`PkiError`] rather
//! than panicking, and it never allocates proportionally to a length field it
//! has not already validated against the real input.
//!
//! Secrecy invariant: this module only ever sees *public* certificate
//! material — certificates, CSRs, CRLs and public keys. It has no access to
//! private keys and returns none.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use sha2::{Digest as _, Sha256};
use x509_parser::extensions::GeneralName;
use x509_parser::oid_registry::{
    OID_DOMAIN_COMPONENT, OID_KEY_TYPE_EC_PUBLIC_KEY, OID_PKCS1_RSAENCRYPTION,
    OID_PKCS1_SHA256WITHRSA, OID_PKCS1_SHA384WITHRSA, OID_PKCS1_SHA512WITHRSA,
    OID_SIG_ECDSA_WITH_SHA256, OID_SIG_ECDSA_WITH_SHA384, OID_SIG_ED25519, OID_X509_COMMON_NAME,
    OID_X509_COUNTRY_NAME, OID_X509_LOCALITY_NAME, OID_X509_ORGANIZATIONAL_UNIT,
    OID_X509_ORGANIZATION_NAME, OID_X509_STATE_OR_PROVINCE_NAME,
};
use x509_parser::pem::parse_x509_pem;
use x509_parser::prelude::{SubjectPublicKeyInfo, X509Name};
use x509_parser::public_key::PublicKey;

use crate::error::PkiError;
use crate::types::{KeyAlgorithm, SanEntry, SignatureAlgorithm, SubjectDn};

/// Hard cap on any PEM document accepted by this crate, matching the
/// `MAX_CERTIFICATE_CHAIN_BYTES` bound already enforced by the gateway's
/// external-certificate normalizer.
pub(crate) const MAX_PEM_BYTES: usize = 256 * 1024;

/// Hard cap on the number of certificates in one chain.
pub(crate) const MAX_CHAIN_CERTS: usize = 5;

/// Hard cap on DNS names carried by one CSR or certificate.
pub(crate) const MAX_DNS_NAMES: usize = 100;

/// Hard cap on IP address SANs carried by one CSR or certificate.
pub(crate) const MAX_IP_SANS: usize = 16;

/// Hard cap on subject alternative names of every class combined.
pub(crate) const MAX_TOTAL_SANS: usize = 256;

/// PEM label for a certificate.
pub(crate) const LABEL_CERTIFICATE: &str = "CERTIFICATE";

/// PEM label for a certificate signing request.
pub(crate) const LABEL_CSR: &str = "CERTIFICATE REQUEST";

/// PEM label for a certificate revocation list.
pub(crate) const LABEL_CRL: &str = "X509 CRL";

/// The Microsoft user-principal-name `otherName` OID, 1.3.6.1.4.1.311.20.2.3.
pub(crate) const UPN_OID: [u64; 10] = [1, 3, 6, 1, 4, 1, 311, 20, 2, 3];

/// Splits a PEM document into its DER blocks, rejecting anything oversized,
/// mislabelled, or carrying trailing junk.
///
/// # Errors
/// Returns [`PkiError::TooLarge`] when the document or its block count exceeds
/// the caps, and [`PkiError::InvalidPem`] when a block cannot be decoded or
/// carries an unexpected label.
pub(crate) fn parse_pem_blocks(
    input: &str,
    expected_label: &str,
    max_blocks: usize,
) -> Result<Vec<Vec<u8>>, PkiError> {
    if input.len() > MAX_PEM_BYTES {
        return Err(PkiError::TooLarge);
    }
    let mut remaining = input.as_bytes();
    let mut blocks: Vec<Vec<u8>> = Vec::new();
    while !remaining.iter().all(u8::is_ascii_whitespace) {
        if blocks.len() >= max_blocks {
            return Err(PkiError::TooLarge);
        }
        let before = remaining.len();
        let (rest, pem) = parse_x509_pem(remaining).map_err(|_| PkiError::InvalidPem)?;
        if pem.label != expected_label || rest.len() >= before {
            return Err(PkiError::InvalidPem);
        }
        blocks.push(pem.contents);
        remaining = rest;
    }
    if blocks.is_empty() {
        return Err(PkiError::InvalidPem);
    }
    Ok(blocks)
}

/// Re-encodes DER as a PEM document with `label`, 64 characters per line.
pub(crate) fn pem_encode(label: &str, der: &[u8]) -> String {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine as _;

    let encoded = STANDARD.encode(der);
    let mut body = String::with_capacity(encoded.len() + encoded.len() / 64 + 1);
    for (index, chunk) in encoded.as_bytes().chunks(64).enumerate() {
        if index > 0 {
            body.push('\n');
        }
        // `chunk` is a slice of an ASCII base64 string, so it is valid UTF-8.
        body.push_str(std::str::from_utf8(chunk).unwrap_or_default());
    }
    if !body.is_empty() {
        body.push('\n');
    }
    format!("-----BEGIN {label}-----\n{body}-----END {label}-----\n")
}

/// Projects an X.501 name onto the attribute subset the certificate manager
/// models, keeping the first occurrence of each single-valued attribute and
/// every `domainComponent` in order.
pub(crate) fn subject_dn(name: &X509Name<'_>) -> SubjectDn {
    let mut dn = SubjectDn::default();
    for attribute in name.iter_attributes() {
        let Ok(value) = attribute.as_str() else {
            continue;
        };
        let oid = attribute.attr_type();
        let slot = if *oid == OID_X509_COMMON_NAME {
            &mut dn.cn
        } else if *oid == OID_X509_ORGANIZATION_NAME {
            &mut dn.o
        } else if *oid == OID_X509_ORGANIZATIONAL_UNIT {
            &mut dn.ou
        } else if *oid == OID_X509_COUNTRY_NAME {
            &mut dn.c
        } else if *oid == OID_X509_STATE_OR_PROVINCE_NAME {
            &mut dn.st
        } else if *oid == OID_X509_LOCALITY_NAME {
            &mut dn.l
        } else {
            if *oid == OID_DOMAIN_COMPONENT && dn.dc.len() < 16 {
                dn.dc.push(value.to_owned());
            }
            continue;
        };
        if slot.is_none() {
            *slot = Some(value.to_owned());
        }
    }
    dn
}

/// Converts parsed `GeneralName`s into [`SanEntry`] values.
///
/// # Errors
/// Returns [`PkiError::TooLarge`] when the caps in this module are exceeded
/// and [`PkiError::InvalidName`] for a name type the certificate manager does
/// not model, so an unrecognized SAN can never be silently dropped from a
/// comparison.
pub(crate) fn general_names_to_sans(names: &[GeneralName<'_>]) -> Result<Vec<SanEntry>, PkiError> {
    if names.len() > MAX_TOTAL_SANS {
        return Err(PkiError::TooLarge);
    }
    let mut entries = Vec::with_capacity(names.len());
    let mut dns = 0usize;
    let mut ips = 0usize;
    for name in names {
        let entry = match name {
            GeneralName::DNSName(value) => {
                dns += 1;
                SanEntry::Dns((*value).to_owned())
            }
            GeneralName::IPAddress(bytes) => {
                ips += 1;
                SanEntry::Ip(ip_from_bytes(bytes)?)
            }
            GeneralName::RFC822Name(value) => SanEntry::Email((*value).to_owned()),
            GeneralName::URI(value) => SanEntry::Uri((*value).to_owned()),
            GeneralName::OtherName(oid, bytes) => {
                if oid.iter().is_some_and(|arcs| arcs.eq(UPN_OID)) {
                    SanEntry::Upn(decode_upn_value(bytes)?)
                } else {
                    return Err(PkiError::InvalidName);
                }
            }
            _ => return Err(PkiError::InvalidName),
        };
        if dns > MAX_DNS_NAMES || ips > MAX_IP_SANS {
            return Err(PkiError::TooLarge);
        }
        entries.push(entry);
    }
    Ok(entries)
}

/// Decodes the 4- or 16-byte network-order body of an `iPAddress` SAN.
fn ip_from_bytes(bytes: &[u8]) -> Result<IpAddr, PkiError> {
    match bytes.len() {
        4 => {
            let mut octets = [0u8; 4];
            octets.copy_from_slice(bytes);
            Ok(IpAddr::V4(Ipv4Addr::from(octets)))
        }
        16 => {
            let mut octets = [0u8; 16];
            octets.copy_from_slice(bytes);
            Ok(IpAddr::V6(Ipv6Addr::from(octets)))
        }
        _ => Err(PkiError::InvalidName),
    }
}

/// Decodes the `[0] EXPLICIT UTF8String` body of a UPN `otherName`.
fn decode_upn_value(bytes: &[u8]) -> Result<String, PkiError> {
    let (tag, value, rest) = read_tlv(bytes).ok_or(PkiError::InvalidName)?;
    if tag != 0xA0 || !rest.is_empty() {
        return Err(PkiError::InvalidName);
    }
    let (inner_tag, inner, inner_rest) = read_tlv(value).ok_or(PkiError::InvalidName)?;
    if inner_tag != 0x0C || !inner_rest.is_empty() {
        return Err(PkiError::InvalidName);
    }
    String::from_utf8(inner.to_vec()).map_err(|_| PkiError::InvalidName)
}

/// Reads one DER tag-length-value triple, returning `(tag, value, rest)`.
///
/// Rejects indefinite-length and any length header that does not fit the
/// remaining input, so a hostile length field cannot drive an allocation.
pub(crate) fn read_tlv(bytes: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    let tag = *bytes.first()?;
    let first_length = *bytes.get(1)?;
    let (length, header) = if first_length < 0x80 {
        (usize::from(first_length), 2usize)
    } else {
        let count = usize::from(first_length & 0x7f);
        if count == 0 || count > 4 {
            return None;
        }
        let raw = bytes.get(2..2 + count)?;
        let mut length = 0usize;
        for byte in raw {
            length = length.checked_mul(256)?.checked_add(usize::from(*byte))?;
        }
        (length, 2 + count)
    };
    let value = bytes.get(header..header.checked_add(length)?)?;
    Some((tag, value, &bytes[header + length..]))
}

/// Encodes one DER tag-length-value triple.
pub(crate) fn write_tlv(tag: u8, value: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(value.len() + 6);
    out.push(tag);
    let length = value.len();
    if length < 0x80 {
        // A length below 128 is its own short-form header byte.
        #[allow(clippy::cast_possible_truncation)]
        out.push(length as u8);
    } else {
        let bytes = length.to_be_bytes();
        let significant: Vec<u8> = bytes
            .iter()
            .copied()
            .skip_while(|byte| *byte == 0)
            .collect();
        // `significant` holds at most 8 bytes, so the cast cannot truncate.
        #[allow(clippy::cast_possible_truncation)]
        out.push(0x80 | significant.len() as u8);
        out.extend_from_slice(&significant);
    }
    out.extend_from_slice(value);
    out
}

/// Determines the key algorithm a `SubjectPublicKeyInfo` describes.
///
/// # Errors
/// Returns [`PkiError::UnsupportedAlgorithm`] for a key type or curve outside
/// the five algorithms this engine issues.
pub(crate) fn key_algorithm_from_spki(
    spki: &SubjectPublicKeyInfo<'_>,
) -> Result<KeyAlgorithm, PkiError> {
    let algorithm = &spki.algorithm.algorithm;
    if *algorithm == OID_SIG_ED25519 {
        return Ok(KeyAlgorithm::Ed25519);
    }
    let parsed = spki.parsed().map_err(|_| PkiError::UnsupportedAlgorithm)?;
    if *algorithm == OID_PKCS1_RSAENCRYPTION {
        return match parsed {
            PublicKey::RSA(key) => match key.key_size() {
                2048 => Ok(KeyAlgorithm::Rsa2048),
                4096 => Ok(KeyAlgorithm::Rsa4096),
                _ => Err(PkiError::UnsupportedAlgorithm),
            },
            _ => Err(PkiError::UnsupportedAlgorithm),
        };
    }
    if *algorithm == OID_KEY_TYPE_EC_PUBLIC_KEY {
        return match parsed.key_size() {
            256 => Ok(KeyAlgorithm::EcdsaP256),
            384 => Ok(KeyAlgorithm::EcdsaP384),
            _ => Err(PkiError::UnsupportedAlgorithm),
        };
    }
    Err(PkiError::UnsupportedAlgorithm)
}

/// Maps a signature `AlgorithmIdentifier` OID onto [`SignatureAlgorithm`].
///
/// # Errors
/// Returns [`PkiError::UnsupportedAlgorithm`] for an algorithm this engine
/// cannot verify.
pub(crate) fn signature_algorithm_from_oid(
    oid: &x509_parser::der_parser::Oid<'_>,
) -> Result<SignatureAlgorithm, PkiError> {
    if *oid == OID_PKCS1_SHA256WITHRSA {
        Ok(SignatureAlgorithm::Sha256Rsa)
    } else if *oid == OID_PKCS1_SHA384WITHRSA {
        Ok(SignatureAlgorithm::Sha384Rsa)
    } else if *oid == OID_PKCS1_SHA512WITHRSA {
        Ok(SignatureAlgorithm::Sha512Rsa)
    } else if *oid == OID_SIG_ECDSA_WITH_SHA256 {
        Ok(SignatureAlgorithm::Sha256Ecdsa)
    } else if *oid == OID_SIG_ECDSA_WITH_SHA384 {
        Ok(SignatureAlgorithm::Sha384Ecdsa)
    } else if *oid == OID_SIG_ED25519 {
        Ok(SignatureAlgorithm::Ed25519)
    } else {
        Err(PkiError::UnsupportedAlgorithm)
    }
}

/// Lowercase hex SHA-256 digest of DER bytes — the fingerprint form stored in
/// `issued_certificates.fingerprint_sha256`.
pub(crate) fn fingerprint_of_der(der: &[u8]) -> String {
    hex::encode(Sha256::digest(der))
}

/// Canonical lowercase hex form of a serial number: leading zero octets are
/// dropped, but at least one octet always remains.
pub(crate) fn serial_hex(bytes: &[u8]) -> String {
    let trimmed = bytes
        .iter()
        .position(|byte| *byte != 0)
        .map_or(&bytes[bytes.len().saturating_sub(1)..], |index| {
            &bytes[index..]
        });
    if trimmed.is_empty() {
        "00".to_owned()
    } else {
        hex::encode(trimmed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tlv_round_trips_across_length_forms() {
        for length in [0usize, 1, 127, 128, 300, 70_000] {
            let value = vec![0x41u8; length];
            let encoded = write_tlv(0x04, &value);
            let (tag, decoded, rest) = read_tlv(&encoded).unwrap();
            assert_eq!(tag, 0x04);
            assert_eq!(decoded, &value[..]);
            assert!(rest.is_empty());
        }
    }

    #[test]
    fn adversarial_tlv_lengths_are_refused_not_allocated() {
        assert!(read_tlv(&[]).is_none());
        assert!(read_tlv(&[0x04]).is_none());
        // Length claims 65535 bytes but only two follow.
        assert!(read_tlv(&[0x04, 0x82, 0xff, 0xff, 0x00, 0x00]).is_none());
        // Indefinite length is refused outright.
        assert!(read_tlv(&[0x30, 0x80, 0x00, 0x00]).is_none());
        // A five-byte length header is beyond anything this engine accepts.
        assert!(read_tlv(&[0x04, 0x85, 0, 0, 0, 0, 1, 0]).is_none());
    }

    #[test]
    fn serial_hex_is_canonical() {
        assert_eq!(serial_hex(&[0x00, 0x01, 0x02]), "0102");
        assert_eq!(serial_hex(&[0x00, 0x00]), "00");
        assert_eq!(serial_hex(&[0xff]), "ff");
    }

    #[test]
    fn pem_encoding_wraps_at_sixty_four_columns() {
        let der = vec![0xABu8; 100];
        let pem = pem_encode(LABEL_CERTIFICATE, &der);
        assert!(pem.starts_with("-----BEGIN CERTIFICATE-----\n"));
        assert!(pem.ends_with("-----END CERTIFICATE-----\n"));
        let body: Vec<&str> = pem
            .lines()
            .filter(|line| !line.starts_with("-----"))
            .collect();
        assert!(body.iter().all(|line| line.len() <= 64));
        let round_tripped = parse_pem_blocks(&pem, LABEL_CERTIFICATE, 1).unwrap();
        assert_eq!(round_tripped, vec![der]);
    }

    #[test]
    fn pem_encoding_handles_every_padding_residue() {
        for length in 0..8usize {
            let der: Vec<u8> = (0..length)
                .map(|index| u8::try_from(index).unwrap_or_default())
                .collect();
            let pem = pem_encode(LABEL_CERTIFICATE, &der);
            assert_eq!(
                parse_pem_blocks(&pem, LABEL_CERTIFICATE, 1).unwrap(),
                vec![der]
            );
        }
    }

    #[test]
    fn adversarial_pem_input_is_bounded_and_labelled() {
        let der = vec![0x01u8; 8];
        let pem = pem_encode(LABEL_CERTIFICATE, &der);
        assert_eq!(
            parse_pem_blocks(&pem, LABEL_CSR, 1).unwrap_err(),
            PkiError::InvalidPem
        );
        assert_eq!(
            parse_pem_blocks(&pem.repeat(3), LABEL_CERTIFICATE, 2).unwrap_err(),
            PkiError::TooLarge
        );
        assert_eq!(
            parse_pem_blocks(&"x".repeat(MAX_PEM_BYTES + 1), LABEL_CERTIFICATE, 1).unwrap_err(),
            PkiError::TooLarge
        );
        assert_eq!(
            parse_pem_blocks("", LABEL_CERTIFICATE, 1).unwrap_err(),
            PkiError::InvalidPem
        );
        assert_eq!(
            parse_pem_blocks("   \n\t ", LABEL_CERTIFICATE, 1).unwrap_err(),
            PkiError::InvalidPem
        );
    }

    #[test]
    fn upn_other_name_decoding_rejects_malformed_bodies() {
        let good = write_tlv(0xA0, &write_tlv(0x0C, b"ops@corp.example"));
        assert_eq!(decode_upn_value(&good).unwrap(), "ops@corp.example");
        assert!(decode_upn_value(&write_tlv(0xA1, &write_tlv(0x0C, b"x"))).is_err());
        assert!(decode_upn_value(&write_tlv(0xA0, &write_tlv(0x04, b"x"))).is_err());
        assert!(decode_upn_value(&[]).is_err());
        let trailing = {
            let mut bytes = write_tlv(0xA0, &write_tlv(0x0C, b"x"));
            bytes.push(0x00);
            bytes
        };
        assert!(decode_upn_value(&trailing).is_err());
    }

    #[test]
    fn ip_san_bodies_of_the_wrong_width_are_rejected() {
        assert_eq!(
            ip_from_bytes(&[10, 0, 0, 1]).unwrap(),
            IpAddr::from([10, 0, 0, 1])
        );
        assert!(ip_from_bytes(&[0u8; 16]).is_ok());
        assert!(ip_from_bytes(&[0u8; 5]).is_err());
        assert!(ip_from_bytes(&[]).is_err());
    }

    #[test]
    fn fingerprints_are_lowercase_hex_sha256() {
        let fingerprint = fingerprint_of_der(b"");
        assert_eq!(fingerprint.len(), 64);
        assert_eq!(
            fingerprint,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}
