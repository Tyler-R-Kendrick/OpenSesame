//! The untrusted forwarded chain and the checks that admit one for verification.

use sha2::{Digest as _, Sha256};
use x509_parser::prelude::{FromDer as _, X509Certificate};

use crate::error::{Field, IngressError};
use crate::fields;
use crate::limits::IngressLimits;

/// Certificates a proxy claims its client presented. **Untrusted.**
///
/// Nothing here has been checked against a trust bundle, a validity window or
/// a key-usage rule; the only guarantees are that each member is exactly one
/// DER certificate within the configured limits, that the leaf is a single
/// end-entity certificate, and that the chain holds no second end-entity
/// certificate. Pass it to [`crate::verify_originating`] before deriving any
/// identity from it.
#[derive(Clone, PartialEq, Eq)]
pub struct ForwardedChain {
    leaf: Vec<u8>,
    intermediates: Vec<Vec<u8>>,
    leaf_thumbprint: String,
}

impl ForwardedChain {
    /// DER of the end-entity certificate from `Client-Cert`.
    #[must_use]
    pub fn leaf_der(&self) -> &[u8] {
        &self.leaf
    }

    /// DER of every `Client-Cert-Chain` member in wire order, a leading
    /// duplicate of the leaf removed.
    #[must_use]
    pub fn intermediates_der(&self) -> &[Vec<u8>] {
        &self.intermediates
    }

    /// Lowercase hex SHA-256 of the leaf DER. Safe to log; it identifies
    /// public bytes, not a person.
    #[must_use]
    pub fn leaf_thumbprint_sha256(&self) -> &str {
        &self.leaf_thumbprint
    }
}

impl std::fmt::Debug for ForwardedChain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ForwardedChain")
            .field("leaf_thumbprint", &self.leaf_thumbprint)
            .field("intermediates", &self.intermediates.len())
            .finish_non_exhaustive()
    }
}

/// Parses `Client-Cert` and `Client-Cert-Chain` (RFC 9440) out of `headers`.
///
/// `Client-Cert` must occur exactly once and be a single parameter-free byte
/// sequence. `Client-Cert-Chain` may be absent, or occur one or more times;
/// every physical field is a List of parameter-free byte sequences and the
/// lists are concatenated in wire order (RFC 8941 §4.2), so a chain split
/// across fields decodes exactly like the same chain in one field.
///
/// # Errors
/// One deterministic [`IngressError`] per failure class, chosen in a fixed
/// order: total bytes, leaf multiplicity, leaf presence, structured-field
/// syntax (including non-canonical base64), member type, parameters, empty
/// members, decoded size, chain length, DER shape, then leaf/chain conflict.
/// The function never panics on any header content.
pub fn parse_client_cert_fields(
    headers: &http::HeaderMap,
    limits: &IngressLimits,
) -> Result<ForwardedChain, IngressError> {
    let raw = fields::collect(headers, limits)?;
    let leaf = fields::decode_leaf(raw.leaf[0])?;
    let mut members = Vec::new();
    for value in &raw.chain {
        members.extend(fields::decode_chain_field(value)?);
    }
    check_size(&leaf, Field::ClientCert, limits)?;
    for member in &members {
        check_size(member, Field::ClientCertChain, limits)?;
    }
    if members.first().is_some_and(|first| *first == leaf) {
        members.remove(0);
    }
    if members.len() > limits.max_chain_certificates {
        return Err(IngressError::ChainTooLong);
    }
    let leaf_is_ca = parse_der(&leaf, Field::ClientCert)?;
    if leaf_is_ca {
        return Err(IngressError::ConflictingLeaf);
    }
    for member in &members {
        let is_ca = parse_der(member, Field::ClientCertChain)?;
        if !is_ca || *member == leaf {
            return Err(IngressError::ConflictingLeaf);
        }
    }
    let leaf_thumbprint = hex::encode(Sha256::digest(&leaf));
    Ok(ForwardedChain {
        leaf,
        intermediates: members,
        leaf_thumbprint,
    })
}

fn check_size(der: &[u8], field: Field, limits: &IngressLimits) -> Result<(), IngressError> {
    if der.len() > limits.max_certificate_bytes {
        Err(IngressError::CertificateTooLarge(field))
    } else {
        Ok(())
    }
}

/// Confirms `der` is exactly one X.509 certificate and reports whether it is
/// a CA (basicConstraints cA=TRUE). Absent basicConstraints means end-entity.
fn parse_der(der: &[u8], field: Field) -> Result<bool, IngressError> {
    let (rest, cert) =
        X509Certificate::from_der(der).map_err(|_| IngressError::NotDerCertificate(field))?;
    if !rest.is_empty() {
        return Err(IngressError::NotDerCertificate(field));
    }
    let is_ca = cert
        .basic_constraints()
        .map_err(|_| IngressError::NotDerCertificate(field))?
        .is_some_and(|ext| ext.value.ca);
    Ok(is_ca)
}
