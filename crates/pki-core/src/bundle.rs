//! PEM chain assembly and PKCS#12 keystores (ADR 0066 domain model).
//!
//! [`normalize_chain`] generalizes the gateway's
//! `cert_issuers::model::normalize_external_certificate`: it keeps that
//! function's 256 KiB cap, five-certificate limit, and adjacent-pair signature
//! verification, and splits the two checks that needed a request context —
//! "does the leaf match this private key" and "does the leaf carry exactly
//! these names" — into [`verify_key_match`] and [`verify_sans`], so an
//! importer, a renewal and an external-issuer response can all reuse them.
//!
//! Secrecy invariant: a parsed PKCS#12 keystore may contain private keys, so
//! [`Pkcs12Entry`] holds them as [`Zeroizing<String>`], is not `Serialize`,
//! and renders `<redacted>` in `Debug`.

use std::collections::BTreeSet;

use p12_keystore::{
    Certificate as P12Certificate, KeyStore, KeyStoreEntry, Pkcs12ImportPolicy, PrivateKey,
    PrivateKeyChain,
};
use x509_parser::prelude::parse_x509_certificate;
use zeroize::Zeroizing;

use crate::error::PkiError;
use crate::keys::KeyPair;
use crate::types::SanEntry;
use crate::x509;

/// One entry enumerated out of a PKCS#12 keystore.
///
/// Secret-bearing: not `Clone`, not `Serialize`, redacted `Debug`.
pub struct Pkcs12Entry {
    /// The entry's friendly name (alias), when the keystore recorded one.
    pub friendly_name: Option<String>,
    /// The entry's certificate, PEM-encoded.
    pub certificate_pem: String,
    /// Any further certificates in the entry's chain, PEM-encoded, ordered
    /// from the issuer of `certificate_pem` upward.
    pub chain_pem: Vec<String>,
    /// The entry's private key as PKCS#8 PEM, when the entry carried one.
    pub private_key_pkcs8_pem: Option<Zeroizing<String>>,
}

impl std::fmt::Debug for Pkcs12Entry {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Pkcs12Entry")
            .field("friendly_name", &self.friendly_name)
            .field("certificate_pem", &"[PUBLIC CERTIFICATE]")
            .field("chain_pem", &self.chain_pem.len())
            .field(
                "private_key_pkcs8_pem",
                &self.private_key_pkcs8_pem.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

/// Splits a PEM chain into its certificates, leaf first, verifying that each
/// certificate is signed by the one after it.
///
/// # Errors
/// Returns [`PkiError::TooLarge`] when the document exceeds 256 KiB or five
/// certificates, [`PkiError::InvalidPem`] for a malformed wrapper,
/// [`PkiError::InvalidDer`] for a malformed certificate, and
/// [`PkiError::ChainInvalid`] when a link is not signed by the certificate
/// above it.
pub fn normalize_chain(chain_pem: &str) -> Result<Vec<String>, PkiError> {
    let blocks = x509::parse_pem_blocks(chain_pem, x509::LABEL_CERTIFICATE, x509::MAX_CHAIN_CERTS)?;
    for block in &blocks {
        let (rest, _) = parse_x509_certificate(block).map_err(|_| PkiError::InvalidDer)?;
        if !rest.is_empty() {
            return Err(PkiError::InvalidDer);
        }
    }
    for pair in blocks.windows(2) {
        let (_, child) = parse_x509_certificate(&pair[0]).map_err(|_| PkiError::InvalidDer)?;
        let (_, parent) = parse_x509_certificate(&pair[1]).map_err(|_| PkiError::InvalidDer)?;
        child
            .verify_signature(Some(parent.public_key()))
            .map_err(|_| PkiError::ChainInvalid)?;
    }
    Ok(blocks
        .iter()
        .map(|der| x509::pem_encode(x509::LABEL_CERTIFICATE, der))
        .collect())
}

/// Checks that the leaf of `certificate_pem` certifies `key`'s public half.
///
/// # Errors
/// Returns [`PkiError::InvalidPem`] or [`PkiError::InvalidDer`] for
/// unparseable input and [`PkiError::KeyMismatch`] when the public keys differ.
pub fn verify_key_match(certificate_pem: &str, key: &KeyPair) -> Result<(), PkiError> {
    let blocks =
        x509::parse_pem_blocks(certificate_pem, x509::LABEL_CERTIFICATE, x509::MAX_CHAIN_CERTS)?;
    let der = blocks.first().ok_or(PkiError::InvalidPem)?;
    let (_, certificate) = parse_x509_certificate(der).map_err(|_| PkiError::InvalidDer)?;
    if certificate.public_key().raw == key.public_key_der() {
        Ok(())
    } else {
        Err(PkiError::KeyMismatch)
    }
}

/// Checks that the leaf of `certificate_pem` carries exactly `expected` as its
/// subject alternative names, as an unordered set.
///
/// # Errors
/// Returns [`PkiError::InvalidPem`] or [`PkiError::InvalidDer`] for
/// unparseable input, [`PkiError::InvalidName`] for a SAN type this engine
/// does not model, and [`PkiError::NamesMismatch`] when the sets differ or the
/// certificate carries no SAN extension while names were expected.
pub fn verify_sans(certificate_pem: &str, expected: &[SanEntry]) -> Result<(), PkiError> {
    let blocks =
        x509::parse_pem_blocks(certificate_pem, x509::LABEL_CERTIFICATE, x509::MAX_CHAIN_CERTS)?;
    let der = blocks.first().ok_or(PkiError::InvalidPem)?;
    let (_, certificate) = parse_x509_certificate(der).map_err(|_| PkiError::InvalidDer)?;
    let extension = certificate
        .subject_alternative_name()
        .map_err(|_| PkiError::InvalidDer)?;
    let actual = match extension {
        Some(extension) => x509::general_names_to_sans(&extension.value.general_names)?,
        None => Vec::new(),
    };
    let actual: BTreeSet<String> = actual
        .iter()
        .map(|entry| format!("{}:{}", entry.class(), entry.value()))
        .collect();
    let wanted: BTreeSet<String> = expected
        .iter()
        .map(|entry| format!("{}:{}", entry.class(), entry.value()))
        .collect();
    if actual == wanted {
        Ok(())
    } else {
        Err(PkiError::NamesMismatch)
    }
}

/// Lowercase hex SHA-256 fingerprint of the first certificate in a PEM
/// document.
///
/// # Errors
/// Returns [`PkiError::InvalidPem`] when the document cannot be decoded.
pub fn fingerprint_sha256(cert_pem: &str) -> Result<String, PkiError> {
    let blocks =
        x509::parse_pem_blocks(cert_pem, x509::LABEL_CERTIFICATE, x509::MAX_CHAIN_CERTS)?;
    let der = blocks.first().ok_or(PkiError::InvalidPem)?;
    Ok(x509::fingerprint_of_der(der))
}

/// Builds a password-protected PKCS#12 keystore holding one key entry: the
/// leaf, its chain, and the private key, under `friendly_name`.
///
/// The keystore is written with PBES2 / AES-256 encryption and an HMAC-SHA-256
/// integrity MAC — the defaults a current JVM or OpenSSL 3 reads without a
/// legacy provider.
///
/// # Errors
/// Returns [`PkiError::InvalidPem`], [`PkiError::InvalidDer`] or
/// [`PkiError::ChainInvalid`] for unusable inputs and [`PkiError::Pkcs12`]
/// when the keystore cannot be encoded.
pub fn build_pkcs12(
    cert_pem: &str,
    chain_pem: &str,
    key: &KeyPair,
    password: &str,
    friendly_name: &str,
) -> Result<Vec<u8>, PkiError> {
    let leaf = x509::parse_pem_blocks(cert_pem, x509::LABEL_CERTIFICATE, 1)?;
    let leaf_der = leaf.first().ok_or(PkiError::InvalidPem)?;
    let mut certificates = vec![P12Certificate::from_der(leaf_der).map_err(|_| PkiError::Pkcs12)?];
    if !chain_pem.trim().is_empty() {
        for pem in normalize_chain(chain_pem)? {
            let der = x509::parse_pem_blocks(&pem, x509::LABEL_CERTIFICATE, 1)?;
            certificates.push(
                P12Certificate::from_der(der.first().ok_or(PkiError::InvalidPem)?)
                    .map_err(|_| PkiError::Pkcs12)?,
            );
        }
    }

    let private_pem = key.private_key_pkcs8_pem();
    let private_der = pkcs8_pem_to_der(&private_pem)?;
    let private = PrivateKey::from_der(&private_der).map_err(|_| PkiError::Pkcs12)?;
    let local_key_id = x509::fingerprint_of_der(leaf_der);

    let mut store = KeyStore::new();
    store.add_entry(
        friendly_name,
        KeyStoreEntry::PrivateKeyChain(PrivateKeyChain::new(
            local_key_id.into_bytes(),
            private,
            certificates,
        )),
    );
    store
        .writer(password)
        .write()
        .map_err(|_| PkiError::Pkcs12)
}

/// Enumerates every entry in a PKCS#12 keystore.
///
/// Key entries come back with their chain and private key; trusted-certificate
/// entries come back with `private_key_pkcs8_pem: None`.
///
/// # Errors
/// Returns [`PkiError::TooLarge`] when the keystore exceeds 8 MiB and
/// [`PkiError::Pkcs12`] when it cannot be opened with `password` or an entry
/// cannot be decoded.
pub fn parse_pkcs12(der: &[u8], password: &str) -> Result<Vec<Pkcs12Entry>, PkiError> {
    /// Hard cap on a keystore this engine will open.
    const MAX_PKCS12_BYTES: usize = 8 * 1024 * 1024;

    if der.len() > MAX_PKCS12_BYTES {
        return Err(PkiError::TooLarge);
    }
    let store = KeyStore::from_pkcs12(der, password, Pkcs12ImportPolicy::Relaxed)
        .map_err(|_| PkiError::Pkcs12)?;
    let mut entries = Vec::with_capacity(store.entries_len());
    for (alias, entry) in store.entries() {
        match entry {
            KeyStoreEntry::PrivateKeyChain(chain) => {
                let certificates = chain.certs();
                let leaf = certificates.first().ok_or(PkiError::Pkcs12)?;
                entries.push(Pkcs12Entry {
                    friendly_name: Some(alias.clone()),
                    certificate_pem: x509::pem_encode(x509::LABEL_CERTIFICATE, leaf.as_der()),
                    chain_pem: certificates
                        .iter()
                        .skip(1)
                        .map(|certificate| {
                            x509::pem_encode(x509::LABEL_CERTIFICATE, certificate.as_der())
                        })
                        .collect(),
                    private_key_pkcs8_pem: Some(Zeroizing::new(x509::pem_encode(
                        "PRIVATE KEY",
                        chain.key().as_der(),
                    ))),
                });
            }
            KeyStoreEntry::Certificate(certificate) => entries.push(Pkcs12Entry {
                friendly_name: Some(alias.clone()),
                certificate_pem: x509::pem_encode(x509::LABEL_CERTIFICATE, certificate.as_der()),
                chain_pem: Vec::new(),
                private_key_pkcs8_pem: None,
            }),
            KeyStoreEntry::Secret(_) => {}
        }
    }
    Ok(entries)
}

/// Strips the PEM armour from a PKCS#8 private key.
fn pkcs8_pem_to_der(pem: &str) -> Result<Zeroizing<Vec<u8>>, PkiError> {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine as _;

    let body: String = pem
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .flat_map(str::chars)
        .filter(|character| !character.is_whitespace())
        .collect();
    if body.is_empty() {
        return Err(PkiError::InvalidPem);
    }
    STANDARD
        .decode(body)
        .map(Zeroizing::new)
        .map_err(|_| PkiError::InvalidPem)
}

#[cfg(test)]
mod tests {
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
        let too_many = format!("{}{}", issued.certificate_pem, root.certificate_pem)
            .repeat(x509::MAX_CHAIN_CERTS);
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
        let der =
            build_pkcs12(&issued.certificate_pem, &root.certificate_pem, &key, "pw", "leaf")
                .unwrap();
        let entries = parse_pkcs12(&der, "pw").unwrap();
        let rendered = format!("{:?}", entries[0]);
        assert!(rendered.contains("<redacted>"));
        assert!(!rendered.contains("BEGIN PRIVATE KEY"));
    }

    #[test]
    fn pkcs8_armour_stripping_rejects_an_empty_body() {
        assert_eq!(
            pkcs8_pem_to_der("-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----\n")
                .unwrap_err(),
            PkiError::InvalidPem
        );
        assert!(pkcs8_pem_to_der("-----BEGIN PRIVATE KEY-----\n!!\n-----END PRIVATE KEY-----\n")
            .is_err());
    }
}
