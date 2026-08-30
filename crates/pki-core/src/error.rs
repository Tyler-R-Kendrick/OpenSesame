//! Error type for the provider-agnostic X.509 engine (ADR 0066 domain model,
//! ADR 0067 revocation).
//!
//! Secrecy invariant: no variant of [`PkiError`] carries private-key bytes, a
//! PKCS#12 password, an enrollment secret, or any other secret material, and
//! no `Display` rendering interpolates caller-supplied input. Parse failures
//! are reported by *kind* so an error can be logged or returned to a caller
//! without becoming an oracle for the bytes that produced it.

use crate::policy::PolicyViolation;

/// Every way an operation in this crate can fail.
///
/// The variants are deliberately coarse. Fine-grained parse diagnostics would
/// leak structure about attacker-supplied input, which is exactly what the
/// bounded parsers in [`crate::csr`], [`crate::bundle`] and
/// [`crate::revocation`] exist to avoid.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[non_exhaustive]
pub enum PkiError {
    /// The requested key or signature algorithm is not supported by this build.
    #[error("algorithm is not supported")]
    UnsupportedAlgorithm,
    /// Key generation failed inside the underlying crypto backend.
    #[error("key generation failed")]
    KeyGeneration,
    /// A PEM document was malformed, empty, or carried an unexpected label.
    #[error("input is not valid PEM")]
    InvalidPem,
    /// A DER document was malformed or did not match the expected structure.
    #[error("input is not valid DER")]
    InvalidDer,
    /// A certificate signing request could not be parsed or failed its own
    /// self-signature check.
    #[error("certificate signing request is invalid")]
    CsrParse,
    /// A certificate could not be built from the supplied parameters.
    #[error("certificate could not be built")]
    CertificateBuild,
    /// A certificate chain was empty, out of order, over-long, or a link in it
    /// was not signed by the certificate above it.
    #[error("certificate chain is invalid")]
    ChainInvalid,
    /// A certificate's public key does not match the private key it was paired
    /// with.
    #[error("certificate and private key do not match")]
    KeyMismatch,
    /// A certificate's subject alternative names differ from those approved.
    #[error("certificate names differ from the approved request")]
    NamesMismatch,
    /// The issuer's basic constraints forbid issuing a further CA beneath it.
    #[error("issuer basic constraints forbid a further CA below it")]
    PathLenExceeded,
    /// The certificate offered as an issuer is not a usable signing authority.
    #[error("certificate is not a certificate authority")]
    NotACertificateAuthority,
    /// `not_before` is not strictly before `not_after`.
    #[error("certificate validity window is invalid")]
    InvalidValidity,
    /// A subject distinguished name or SAN entry was empty or contained
    /// characters that cannot be encoded.
    #[error("subject or subject alternative name is invalid")]
    InvalidName,
    /// The candidate was rejected by a certificate policy.
    #[error("policy rejected the request with {} violation(s)", .0.len())]
    PolicyViolations(Vec<PolicyViolation>),
    /// A PKCS#12 keystore could not be built, or could not be parsed with the
    /// supplied password.
    #[error("PKCS#12 keystore could not be built or opened")]
    Pkcs12,
    /// A certificate revocation list could not be built.
    #[error("certificate revocation list could not be built")]
    CrlBuild,
    /// A certificate revocation list could not be parsed.
    #[error("certificate revocation list could not be parsed")]
    CrlParse,
    /// An OCSP response could not be built.
    #[error("OCSP response could not be built")]
    OcspBuild,
    /// An OCSP request or response could not be parsed.
    #[error("OCSP message could not be parsed")]
    OcspParse,
    /// A signature did not verify against the public key it was checked with.
    #[error("signature verification failed")]
    SignatureInvalid,
    /// Signing failed inside the underlying crypto backend.
    #[error("signing failed")]
    Signing,
    /// Input exceeded a hard size or cardinality bound.
    #[error("input exceeds the permitted size")]
    TooLarge,
    /// A stored textual enum value did not name a known variant.
    #[error("value does not name a known variant")]
    UnknownEnumValue,
    /// A capability that is specified but not yet implemented in this build.
    #[error("not yet supported: {0}")]
    NotYetSupported(&'static str),
}
