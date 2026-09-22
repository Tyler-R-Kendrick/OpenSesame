//! Bounds on forwarded-evidence processing.
//!
//! The parser's work is linear in the bytes it is handed, so bounding the
//! total header bytes bounds the parser; the decoded-size and count limits
//! bound what reaches the DER decoder and, later, the chain verifier.

/// Limits applied by [`crate::parse_client_cert_fields`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IngressLimits {
    /// Largest decoded certificate accepted, leaf or chain member.
    pub max_certificate_bytes: usize,
    /// Most members accepted across every `Client-Cert-Chain` field, after
    /// a leading duplicate of the leaf is dropped.
    pub max_chain_certificates: usize,
    /// Most bytes accepted across every `Client-Cert` and
    /// `Client-Cert-Chain` physical field value, undecoded.
    pub max_total_header_bytes: usize,
}

impl IngressLimits {
    /// 16 KiB per certificate, 8 chain certificates, 64 KiB of header text.
    pub const DEFAULT: Self = Self {
        max_certificate_bytes: 16 * 1024,
        max_chain_certificates: 8,
        max_total_header_bytes: 64 * 1024,
    };
}

impl Default for IngressLimits {
    fn default() -> Self {
        Self::DEFAULT
    }
}
