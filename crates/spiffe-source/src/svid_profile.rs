//! X509-SVID profile validation (SPIFFE X509-SVID standard §4–§5), pure.
//!
//! This module answers one question about one DER leaf: is it an X509-SVID
//! for the expected trust domain (and, optionally, the exact expected SPIFFE
//! ID) that may act in the given TLS role? It performs no chain building and
//! no signature verification — that is `rustls-webpki`'s job in
//! [`crate::bundles`] and in `opensesame_transport_security`'s verifiers, which
//! call this after the chain has been verified so that a certificate that
//! chains correctly but is not an SVID is still refused.
//!
//! Rules enforced (each one is its own error variant so a rejection is
//! explainable without the certificate):
//! * exactly one URI SAN, and it is a valid SPIFFE ID in canonical form
//!   (byte-for-byte equal to its parsed serialization: no uppercase trust
//!   domain, no percent-encoding, no non-ASCII confusables, no `.`/`..`
//!   segments, no trailing slash) with a non-root path;
//! * the trust domain is the expected one; the ID is the exact expected one
//!   when an exact ID is given;
//! * `cA` is false (absent basic constraints count as false); a signing
//!   certificate is never a caller;
//! * key usage is present and critical, sets `digitalSignature`, and sets
//!   neither `keyCertSign` nor `cRLSign`;
//! * extended key usage, when present, carries both `serverAuth` and
//!   `clientAuth` (standard §4.4) and in particular the one the role needs;
//! * no unknown critical extension;
//! * the validity window contains `now`.

use chrono::{DateTime, TimeZone as _, Utc};
use sha2::{Digest as _, Sha256};
use spiffe::SpiffeId;
use x509_parser::extensions::{GeneralName, ParsedExtension};
use x509_parser::prelude::{FromDer as _, X509Certificate};

/// Which side of the TLS handshake the leaf is about to take.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SvidRole {
    /// The leaf authenticates a client (needs `clientAuth` when EKU is present).
    Client,
    /// The leaf authenticates a server (needs `serverAuth` when EKU is present).
    Server,
}

impl SvidRole {
    const fn name(self) -> &'static str {
        match self {
            Self::Client => "client_auth",
            Self::Server => "server_auth",
        }
    }
}

/// What the validator was told to expect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SvidExpectation<'a> {
    /// Trust domain name, e.g. `example.test`.
    pub trust_domain: &'a str,
    /// Exact SPIFFE ID, when the caller knows which identity it wants.
    pub spiffe_id: Option<&'a str>,
    /// TLS role the leaf will take.
    pub role: SvidRole,
}

/// Non-secret facts about a leaf that passed the profile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SvidFacts {
    /// The one SPIFFE ID the leaf carries.
    pub spiffe_id: String,
    /// Its trust domain name.
    pub trust_domain: String,
    /// Validity start.
    pub not_before: DateTime<Utc>,
    /// Validity end.
    pub not_after: DateTime<Utc>,
    /// SHA-256 of the leaf DER, 64 lowercase hex characters.
    pub leaf_thumbprint_sha256: String,
}

/// Every way a leaf can fail the profile. Messages never include the
/// certificate; identifiers are echoed only when they are already the
/// caller's own expectation or a parsed SPIFFE ID.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SvidProfileError {
    #[error("leaf certificate is not valid DER")]
    Malformed,
    #[error("leaf certificate has no subject alternative name extension")]
    NoSubjectAltName,
    #[error("leaf certificate carries no URI SAN")]
    NoUriSan,
    #[error("leaf certificate carries {0} URI SANs; an X509-SVID has exactly one")]
    MultipleUriSans(usize),
    #[error("URI SAN is not a valid SPIFFE ID")]
    InvalidSpiffeId,
    #[error("URI SAN is not in canonical SPIFFE ID form")]
    NonCanonicalSpiffeId,
    #[error("SPIFFE ID has no path; a leaf SVID must not be a trust-domain root ID")]
    RootSpiffeId,
    #[error("SVID trust domain {presented} is not the expected {expected}")]
    TrustDomainMismatch { expected: String, presented: String },
    #[error("SVID {presented} is not the expected identity {expected}")]
    IdentityMismatch { expected: String, presented: String },
    #[error("leaf certificate is a CA (cA=true); signing certificates never authenticate")]
    LeafIsCa,
    #[error("key usage extension is absent")]
    KeyUsageMissing,
    #[error("key usage extension is not critical")]
    KeyUsageNotCritical,
    #[error("key usage lacks digitalSignature")]
    KeyUsageNoDigitalSignature,
    #[error("key usage sets keyCertSign or cRLSign; signing certificates never authenticate")]
    KeyUsageSigning,
    #[error("extended key usage is present but lacks {needed}")]
    ExtendedKeyUsageLacks { needed: &'static str },
    #[error("leaf certificate carries an unknown critical extension")]
    UnknownCriticalExtension,
    #[error("leaf certificate is not yet valid")]
    NotYetValid,
    #[error("leaf certificate has expired")]
    Expired,
}

/// Validate one DER leaf against the expectation at time `now`.
///
/// # Errors
/// The first profile rule the leaf breaks, in the order listed in the module
/// documentation.
pub fn validate_leaf(
    leaf_der: &[u8],
    expectation: &SvidExpectation<'_>,
    now: DateTime<Utc>,
) -> Result<SvidFacts, SvidProfileError> {
    let (rest, cert) =
        X509Certificate::from_der(leaf_der).map_err(|_| SvidProfileError::Malformed)?;
    if !rest.is_empty() {
        return Err(SvidProfileError::Malformed);
    }
    let id = single_spiffe_id(&cert)?;
    if id.trust_domain().as_str() != expectation.trust_domain {
        return Err(SvidProfileError::TrustDomainMismatch {
            expected: expectation.trust_domain.to_owned(),
            presented: id.trust_domain().to_string(),
        });
    }
    if let Some(expected) = expectation.spiffe_id {
        if id.to_string() != expected {
            return Err(SvidProfileError::IdentityMismatch {
                expected: expected.to_owned(),
                presented: id.to_string(),
            });
        }
    }
    check_leaf_constraints(&cert)?;
    check_key_usage(&cert)?;
    check_extended_key_usage(&cert, expectation.role)?;
    check_no_unknown_critical(&cert)?;
    let (not_before, not_after) = validity(&cert)?;
    if now < not_before {
        return Err(SvidProfileError::NotYetValid);
    }
    if now > not_after {
        return Err(SvidProfileError::Expired);
    }
    Ok(SvidFacts {
        spiffe_id: id.to_string(),
        trust_domain: id.trust_domain().to_string(),
        not_before,
        not_after,
        leaf_thumbprint_sha256: hex::encode(Sha256::digest(leaf_der)),
    })
}

/// The SPIFFE ID of a leaf that has exactly one canonical URI SAN, with no
/// other profile checks. Used to route a presented peer to its own trust
/// domain's bundle before the full profile runs.
///
/// # Errors
/// Parse, SAN-count, and SPIFFE-ID-syntax failures.
pub fn presented_spiffe_id(leaf_der: &[u8]) -> Result<SpiffeId, SvidProfileError> {
    let (rest, cert) =
        X509Certificate::from_der(leaf_der).map_err(|_| SvidProfileError::Malformed)?;
    if !rest.is_empty() {
        return Err(SvidProfileError::Malformed);
    }
    single_spiffe_id(&cert)
}

fn single_spiffe_id(cert: &X509Certificate<'_>) -> Result<SpiffeId, SvidProfileError> {
    let san = cert
        .subject_alternative_name()
        .map_err(|_| SvidProfileError::Malformed)?
        .ok_or(SvidProfileError::NoSubjectAltName)?;
    let uris: Vec<&str> = san
        .value
        .general_names
        .iter()
        .filter_map(|name| match name {
            GeneralName::URI(uri) => Some(*uri),
            _ => None,
        })
        .collect();
    let uri = match uris.as_slice() {
        [] => return Err(SvidProfileError::NoUriSan),
        [one] => *one,
        many => return Err(SvidProfileError::MultipleUriSans(many.len())),
    };
    let id = SpiffeId::new(uri).map_err(|_| SvidProfileError::InvalidSpiffeId)?;
    if id.to_string() != uri {
        return Err(SvidProfileError::NonCanonicalSpiffeId);
    }
    if id.path().is_empty() {
        return Err(SvidProfileError::RootSpiffeId);
    }
    Ok(id)
}

fn check_leaf_constraints(cert: &X509Certificate<'_>) -> Result<(), SvidProfileError> {
    let bc = cert
        .basic_constraints()
        .map_err(|_| SvidProfileError::Malformed)?;
    if bc.is_some_and(|ext| ext.value.ca) {
        return Err(SvidProfileError::LeafIsCa);
    }
    Ok(())
}

fn check_key_usage(cert: &X509Certificate<'_>) -> Result<(), SvidProfileError> {
    let ku = cert
        .key_usage()
        .map_err(|_| SvidProfileError::Malformed)?
        .ok_or(SvidProfileError::KeyUsageMissing)?;
    if !ku.critical {
        return Err(SvidProfileError::KeyUsageNotCritical);
    }
    if ku.value.key_cert_sign() || ku.value.crl_sign() {
        return Err(SvidProfileError::KeyUsageSigning);
    }
    if !ku.value.digital_signature() {
        return Err(SvidProfileError::KeyUsageNoDigitalSignature);
    }
    Ok(())
}

fn check_extended_key_usage(
    cert: &X509Certificate<'_>,
    role: SvidRole,
) -> Result<(), SvidProfileError> {
    let Some(eku) = cert
        .extended_key_usage()
        .map_err(|_| SvidProfileError::Malformed)?
    else {
        return Ok(());
    };
    let has_role = match role {
        SvidRole::Client => eku.value.client_auth,
        SvidRole::Server => eku.value.server_auth,
    };
    if !has_role {
        return Err(SvidProfileError::ExtendedKeyUsageLacks {
            needed: role.name(),
        });
    }
    // Standard §4.4: when included, both serverAuth and clientAuth MUST be set.
    if !eku.value.server_auth {
        return Err(SvidProfileError::ExtendedKeyUsageLacks {
            needed: "server_auth",
        });
    }
    if !eku.value.client_auth {
        return Err(SvidProfileError::ExtendedKeyUsageLacks {
            needed: "client_auth",
        });
    }
    Ok(())
}

fn check_no_unknown_critical(cert: &X509Certificate<'_>) -> Result<(), SvidProfileError> {
    let unknown_critical = cert.extensions().iter().any(|ext| {
        ext.critical
            && matches!(
                ext.parsed_extension(),
                ParsedExtension::UnsupportedExtension { .. } | ParsedExtension::ParseError { .. }
            )
    });
    if unknown_critical {
        return Err(SvidProfileError::UnknownCriticalExtension);
    }
    Ok(())
}

fn validity(
    cert: &X509Certificate<'_>,
) -> Result<(DateTime<Utc>, DateTime<Utc>), SvidProfileError> {
    let v = cert.validity();
    let nb = Utc
        .timestamp_opt(v.not_before.timestamp(), 0)
        .single()
        .ok_or(SvidProfileError::Malformed)?;
    let na = Utc
        .timestamp_opt(v.not_after.timestamp(), 0)
        .single()
        .ok_or(SvidProfileError::Malformed)?;
    Ok((nb, na))
}

#[cfg(all(test, feature = "fake-workload-api"))]
#[path = "svid_profile_tests.rs"]
mod tests;
