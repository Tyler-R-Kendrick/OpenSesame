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

// The omitted field carries private key material. Printing it would defeat the
// crate's secrecy invariant (see the crate docs) and leak keys into logs and
// panic output, so the redaction is deliberate.
#[allow(clippy::missing_fields_in_debug)]
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
    let blocks = x509::parse_pem_blocks(
        certificate_pem,
        x509::LABEL_CERTIFICATE,
        x509::MAX_CHAIN_CERTS,
    )?;
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
    let blocks = x509::parse_pem_blocks(
        certificate_pem,
        x509::LABEL_CERTIFICATE,
        x509::MAX_CHAIN_CERTS,
    )?;
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
/// The document is parsed as X.509 *before* it is hashed. The fingerprint is
/// an identity — discovery matches scanned installations to inventory rows by
/// it, and `issued_certificates.fingerprint_sha256` is indexed on it — so a
/// value must never be minted for bytes that are not a certificate. Hashing
/// unvalidated armour would hand two unrelated malformed documents stable
/// "certificate" identities.
///
/// # Errors
/// Returns [`PkiError::InvalidPem`] when the armour is malformed and
/// [`PkiError::InvalidDer`] when the body is not a parseable certificate.
/// Parses a PEM bundle into DER certificates, in order.
///
/// # Errors
/// Returns [`PkiError::InvalidPem`] when the bundle is malformed or empty,
/// [`PkiError::TooLarge`] past this crate's caps.
pub fn certificates_der(chain_pem: &str) -> Result<Vec<Vec<u8>>, PkiError> {
    x509::parse_pem_blocks(chain_pem, x509::LABEL_CERTIFICATE, x509::MAX_CHAIN_CERTS)
}

/// SHA-256 fingerprint, canonical lowercase hex, over a certificate's DER.
///
/// # Errors
/// Returns [`PkiError::InvalidPem`] when the document is not one certificate,
/// [`PkiError::TooLarge`] past this crate's caps.
pub fn fingerprint_sha256(cert_pem: &str) -> Result<String, PkiError> {
    let blocks = x509::parse_pem_blocks(cert_pem, x509::LABEL_CERTIFICATE, x509::MAX_CHAIN_CERTS)?;
    let der = blocks.first().ok_or(PkiError::InvalidPem)?;
    let (rest, _) = parse_x509_certificate(der).map_err(|_| PkiError::InvalidDer)?;
    if !rest.is_empty() {
        return Err(PkiError::InvalidDer);
    }
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
    store.writer(password).write().map_err(|_| PkiError::Pkcs12)
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
mod tests;
