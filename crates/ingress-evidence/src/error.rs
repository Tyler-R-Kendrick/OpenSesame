//! Deterministic failure codes for forwarded-evidence processing.
//!
//! Every code here has a byte-identical twin in `@opensesame/ingress-evidence`
//! (`packages/ingress-evidence/src/error.ts`). The shared corpus under
//! `fixtures/` pins each one, so a divergence between the two parsers fails
//! both suites.

use std::fmt;

/// Which RFC 9440 field a problem was found in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Field {
    /// `Client-Cert`, the singleton end-entity certificate.
    ClientCert,
    /// `Client-Cert-Chain`, the list of issuing certificates.
    ClientCertChain,
}

impl Field {
    /// Canonical lowercase header name.
    #[must_use]
    pub const fn header_name(self) -> &'static str {
        match self {
            Self::ClientCert => "client-cert",
            Self::ClientCertChain => "client-cert-chain",
        }
    }
}

impl fmt::Display for Field {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.header_name())
    }
}

/// A forwarded-evidence rejection. The variant is the contract; the payload
/// only says where. No certificate bytes, subjects or header text are carried,
/// so a value is safe to log and to return in a response body.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum IngressError {
    /// The combined size of every `Client-Cert*` physical field exceeded the limit.
    #[error("client certificate header fields exceed the byte limit")]
    HeaderBytesExceeded,
    /// `Client-Cert-Chain` was present without `Client-Cert` (RFC 9440 §2.3),
    /// or no evidence was present at all.
    #[error("client-cert is missing")]
    LeafMissing,
    /// More than one physical `Client-Cert` field (RFC 9440 §2.2: singleton).
    #[error("client-cert occurs more than once")]
    LeafRepeated,
    /// The field value is not a well-formed RFC 8941 value of the required
    /// type, including any non-canonical base64 inside a byte sequence.
    #[error("{0} is not a well-formed structured field")]
    MalformedStructuredField(Field),
    /// An item was not a byte sequence (a string, token, inner list, ...).
    #[error("{0} contains a member that is not a byte sequence")]
    NotByteSequence(Field),
    /// An item carried parameters; RFC 9440 defines none.
    #[error("{0} carries parameters")]
    ParametersPresent(Field),
    /// A byte sequence decoded to zero bytes, or a chain field had no members.
    #[error("{0} contains an empty item")]
    EmptyItem(Field),
    /// A decoded certificate is larger than the configured limit.
    #[error("{0} contains a certificate over the size limit")]
    CertificateTooLarge(Field),
    /// More chain certificates than the configured limit.
    #[error("client-cert-chain has too many certificates")]
    ChainTooLong,
    /// A byte sequence is not exactly one DER-encoded X.509 certificate.
    #[error("{0} contains bytes that are not a DER certificate")]
    NotDerCertificate(Field),
    /// The chain carries an end-entity certificate that is not the leaf, or a
    /// second copy of the leaf anywhere but position zero.
    #[error("client-cert-chain conflicts with client-cert")]
    ConflictingLeaf,
}

impl IngressError {
    /// Stable `snake_case` code shared with the TypeScript package.
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::HeaderBytesExceeded => "header_bytes_exceeded",
            Self::LeafMissing => "leaf_missing",
            Self::LeafRepeated => "leaf_repeated",
            Self::MalformedStructuredField(_) => "malformed_structured_field",
            Self::NotByteSequence(_) => "not_byte_sequence",
            Self::ParametersPresent(_) => "parameters_present",
            Self::EmptyItem(_) => "empty_item",
            Self::CertificateTooLarge(_) => "certificate_too_large",
            Self::ChainTooLong => "chain_too_long",
            Self::NotDerCertificate(_) => "not_der_certificate",
            Self::ConflictingLeaf => "conflicting_leaf",
        }
    }

    /// The field the problem was found in, when it is attributable to one.
    #[must_use]
    pub const fn field(&self) -> Option<Field> {
        match self {
            Self::MalformedStructuredField(f)
            | Self::NotByteSequence(f)
            | Self::ParametersPresent(f)
            | Self::EmptyItem(f)
            | Self::CertificateTooLarge(f)
            | Self::NotDerCertificate(f) => Some(*f),
            Self::LeafMissing | Self::LeafRepeated => Some(Field::ClientCert),
            Self::ChainTooLong | Self::ConflictingLeaf => Some(Field::ClientCertChain),
            Self::HeaderBytesExceeded => None,
        }
    }
}
