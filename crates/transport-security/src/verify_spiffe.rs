//! The SPIFFE X.509-SVID server-identity profile verifier.
//!
//! This is a full verifier, not a bypass. In order:
//!
//! 1. the presented chain is bounded ([`MAX_CHAIN_DEPTH`]) and built by
//!    `rustls-webpki` to an anchor of the trust-domain bundle, with the
//!    `serverAuth` usage, the connection time, and every CRL the bundle
//!    carries (`EndEntityCert::verify_for_usage`);
//! 2. TLS 1.2 / 1.3 handshake signatures (`CertificateVerify`) are verified
//!    by the rustls crypto provider exactly as the built-in verifier does;
//! 3. the leaf must carry exactly one URI SAN and it must equal the expected
//!    SPIFFE ID byte for byte.
//!
//! What it deliberately does **not** do is compare a DNS reference identity:
//! that is the `WebPKI` profile (`ServerNamePolicy::Dns`), and a workload's
//! identity is its SPIFFE ID, not the host it happens to be dialed at
//! (SPIFFE `X.509-SVID` §5, RFC 9525 §1.7). The SNI passed to rustls is used
//! only to select the server's certificate.

use std::fmt;

use opensesame_domain::transport::{PeerIdentitySelector, TransportError, TrustProfileKind};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, WebPkiSupportedAlgorithms};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{CertificateError, DigitallySignedStruct, SignatureScheme};

use crate::error::{malformed, pki_error};
use crate::leaf::ParsedLeaf;
use crate::trust::TrustBundle;
use crate::MAX_CHAIN_DEPTH;

/// Verifies a server against a SPIFFE trust-domain bundle and one exact
/// SPIFFE ID.
pub struct SpiffeServerVerifier {
    trust: TrustBundle,
    expected: String,
    supported: WebPkiSupportedAlgorithms,
}

impl SpiffeServerVerifier {
    /// # Errors
    ///
    /// `MalformedConfiguration` when the bundle is not a
    /// `SpiffeTrustDomain` profile or the expected ID is not a valid SPIFFE
    /// ID.
    pub fn new(
        trust: TrustBundle,
        expected_spiffe_id: &str,
        provider: &rustls::crypto::CryptoProvider,
    ) -> Result<Self, TransportError> {
        if trust.kind() != TrustProfileKind::SpiffeTrustDomain {
            return Err(malformed(format!(
                "trust profile {} is {:?}, not spiffe_trust_domain",
                trust.profile(),
                trust.kind()
            )));
        }
        PeerIdentitySelector::SpiffeId(expected_spiffe_id.to_owned()).validate()?;
        Ok(Self {
            trust,
            expected: expected_spiffe_id.to_owned(),
            supported: provider.signature_verification_algorithms,
        })
    }

    /// The SPIFFE ID this verifier accepts.
    #[must_use]
    pub fn expected(&self) -> &str {
        &self.expected
    }
}

impl fmt::Debug for SpiffeServerVerifier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SpiffeServerVerifier")
            .field("trust", &self.trust)
            .field("expected", &self.expected)
            .finish_non_exhaustive()
    }
}

impl ServerCertVerifier for SpiffeServerVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        if intermediates.len() + 1 > MAX_CHAIN_DEPTH {
            return Err(pki_error(webpki::Error::MaximumPathDepthExceeded));
        }
        let cert = webpki::EndEntityCert::try_from(end_entity).map_err(pki_error)?;
        let crls = self
            .trust
            .parsed_crls()
            .map_err(|e| rustls::Error::General(e.code().to_owned()))?;
        let crl_refs: Vec<&webpki::CertRevocationList<'_>> = crls.iter().collect();
        let revocation = self.trust.revocation_options(&crl_refs);
        let roots = self.trust.roots();
        cert.verify_for_usage(
            self.supported.all,
            &roots.roots,
            intermediates,
            now,
            webpki::KeyUsage::server_auth(),
            revocation,
            None,
        )
        .map_err(pki_error)?;

        let leaf = ParsedLeaf::parse(end_entity)
            .map_err(|e| rustls::Error::General(format!("spiffe leaf: {}", e.code())))?;
        match leaf.uri_sans.as_slice() {
            [only] if *only == self.expected => Ok(ServerCertVerified::assertion()),
            _ => Err(rustls::Error::InvalidCertificate(
                CertificateError::NotValidForName,
            )),
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.supported)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.supported)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.supported.supported_schemes()
    }
}
