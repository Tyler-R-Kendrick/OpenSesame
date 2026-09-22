//! Mapping between library errors and the stable, non-secret
//! [`TransportError`] codes.

use opensesame_domain::transport::TransportError;
use rustls::CertificateError;

/// Classify a rustls error into a `TransportError`.
///
/// Handshake failures carry no secret material, but they do carry the peer's
/// error text; the mapping keeps the stable code and drops the rest so a
/// code is what reaches a log line or a status view.
#[must_use]
pub fn classify_tls_error(error: &rustls::Error) -> TransportError {
    match error {
        rustls::Error::InvalidCertificate(cert) => classify_certificate_error(cert),
        rustls::Error::NoCertificatesPresented => TransportError::IdentityMissing,
        rustls::Error::InvalidCertRevocationList(_) => {
            TransportError::malformed("certificate revocation list is malformed")
        }
        rustls::Error::PeerIncompatible(_) => TransportError::EnforcementUnsupported,
        rustls::Error::AlertReceived(_) | rustls::Error::PeerMisbehaved(_) => {
            TransportError::ProofMismatch
        }
        rustls::Error::General(text) => TransportError::malformed(text.clone()),
        other => TransportError::malformed(other.to_string()),
    }
}

fn classify_certificate_error(error: &CertificateError) -> TransportError {
    match error {
        CertificateError::Expired | CertificateError::ExpiredContext { .. } => {
            TransportError::EvidenceExpired
        }
        CertificateError::NotValidYet | CertificateError::NotValidYetContext { .. } => {
            TransportError::malformed("certificate is not yet valid")
        }
        CertificateError::Revoked => TransportError::EvidenceRevoked,
        CertificateError::UnknownIssuer | CertificateError::UnknownRevocationStatus => {
            TransportError::TrustUnknown
        }
        CertificateError::NotValidForName
        | CertificateError::NotValidForNameContext { .. }
        | CertificateError::InvalidPurpose
        | CertificateError::InvalidPurposeContext { .. } => TransportError::PeerDisallowed,
        CertificateError::BadSignature => TransportError::ProofMismatch,
        other => TransportError::malformed(format!("certificate rejected: {other:?}")),
    }
}

/// Translate a `webpki` error into rustls's vocabulary so a custom verifier
/// reports the same alerts and codes the built-in verifiers would.
#[must_use]
pub fn pki_error(error: webpki::Error) -> rustls::Error {
    use webpki::Error as E;
    let cert = match error {
        E::CertExpired { .. } => CertificateError::Expired,
        E::CertNotValidYet { .. } => CertificateError::NotValidYet,
        E::CertRevoked => CertificateError::Revoked,
        E::UnknownIssuer => CertificateError::UnknownIssuer,
        E::UnknownRevocationStatus => CertificateError::UnknownRevocationStatus,
        E::CertNotValidForName(_) => CertificateError::NotValidForName,
        E::InvalidSignatureForPublicKey => CertificateError::BadSignature,
        E::RequiredEkuNotFoundContext(_) => CertificateError::InvalidPurpose,
        other => CertificateError::Other(rustls::OtherError(std::sync::Arc::new(other))),
    };
    rustls::Error::InvalidCertificate(cert)
}

/// Shorthand for the malformed-configuration code with a non-secret detail.
pub(crate) fn malformed(detail: impl Into<String>) -> TransportError {
    TransportError::MalformedConfiguration(detail.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn certificate_errors_map_to_stable_codes() {
        let expired = rustls::Error::InvalidCertificate(CertificateError::Expired);
        assert_eq!(classify_tls_error(&expired).code(), "evidence_expired");
        let revoked = rustls::Error::InvalidCertificate(CertificateError::Revoked);
        assert_eq!(classify_tls_error(&revoked).code(), "evidence_revoked");
        let issuer = rustls::Error::InvalidCertificate(CertificateError::UnknownIssuer);
        assert_eq!(classify_tls_error(&issuer).code(), "trust_unknown");
        let none = rustls::Error::NoCertificatesPresented;
        assert_eq!(classify_tls_error(&none).code(), "identity_missing");
        let name = rustls::Error::InvalidCertificate(CertificateError::NotValidForName);
        assert_eq!(classify_tls_error(&name).code(), "peer_disallowed");
    }

    #[test]
    fn webpki_errors_become_rustls_certificate_errors() {
        assert!(matches!(
            pki_error(webpki::Error::UnknownIssuer),
            rustls::Error::InvalidCertificate(CertificateError::UnknownIssuer)
        ));
        assert!(matches!(
            pki_error(webpki::Error::CertRevoked),
            rustls::Error::InvalidCertificate(CertificateError::Revoked)
        ));
    }
}
