//! Chain-depth bounds around rustls's built-in verifiers.
//!
//! `rustls-webpki` allows up to six sub-CAs on a path; this crate promises
//! [`MAX_CHAIN_DEPTH`] certificates in total (leaf plus intermediates) on
//! every verifier, so the built-in `WebPKI` verifiers are wrapped and a longer
//! presented chain is refused before path building starts. Everything else
//! is delegated untouched.

use std::sync::Arc;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::{DigitallySignedStruct, DistinguishedName, SignatureScheme};

use crate::error::pki_error;
use crate::MAX_CHAIN_DEPTH;

fn check_depth(intermediates: &[CertificateDer<'_>]) -> Result<(), rustls::Error> {
    if intermediates.len() + 1 > MAX_CHAIN_DEPTH {
        return Err(pki_error(webpki::Error::MaximumPathDepthExceeded));
    }
    Ok(())
}

/// A client-certificate verifier that refuses chains longer than
/// [`MAX_CHAIN_DEPTH`] and delegates the rest.
#[derive(Debug)]
pub(crate) struct BoundedClientVerifier {
    inner: Arc<dyn ClientCertVerifier>,
}

impl BoundedClientVerifier {
    pub(crate) fn new(inner: Arc<dyn ClientCertVerifier>) -> Arc<Self> {
        Arc::new(Self { inner })
    }
}

impl ClientCertVerifier for BoundedClientVerifier {
    fn offer_client_auth(&self) -> bool {
        self.inner.offer_client_auth()
    }

    fn client_auth_mandatory(&self) -> bool {
        self.inner.client_auth_mandatory()
    }

    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        self.inner.root_hint_subjects()
    }

    fn verify_client_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        now: UnixTime,
    ) -> Result<ClientCertVerified, rustls::Error> {
        check_depth(intermediates)?;
        self.inner
            .verify_client_cert(end_entity, intermediates, now)
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }

    fn requires_raw_public_keys(&self) -> bool {
        self.inner.requires_raw_public_keys()
    }
}

/// A server-certificate verifier that refuses chains longer than
/// [`MAX_CHAIN_DEPTH`] and delegates the rest.
#[derive(Debug)]
pub(crate) struct BoundedServerVerifier {
    inner: Arc<dyn ServerCertVerifier>,
}

impl BoundedServerVerifier {
    pub(crate) fn new(inner: Arc<dyn ServerCertVerifier>) -> Arc<Self> {
        Arc::new(Self { inner })
    }
}

impl ServerCertVerifier for BoundedServerVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        check_depth(intermediates)?;
        self.inner
            .verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now)
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }

    fn requires_raw_public_keys(&self) -> bool {
        self.inner.requires_raw_public_keys()
    }

    fn root_hint_subjects(&self) -> Option<&[DistinguishedName]> {
        self.inner.root_hint_subjects()
    }
}
