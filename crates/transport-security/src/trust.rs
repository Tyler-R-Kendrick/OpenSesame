//! [`TrustBundle`]: the anchors and CRLs used to verify a *peer*.
//!
//! Deliberately a different type from [`crate::TlsIdentity`]: the chain we
//! present and the roots we trust are never the same object, and a bundle
//! knows which profile it serves (`WebPkiDns`, `PrivateRoot`,
//! `SpiffeTrustDomain`) so a SPIFFE verifier cannot be handed a Web PKI
//! bundle or vice versa.

use std::fmt;
use std::sync::Arc;

use chrono::Utc;
use opensesame_domain::transport::{TransportError, TrustProfileKind, TrustProfileRef};
use rustls::RootCertStore;
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, CertificateRevocationListDer};

use crate::error::malformed;
use crate::leaf::ParsedLeaf;

/// Trust anchors plus optional CRLs for one trust profile.
#[derive(Clone)]
pub struct TrustBundle {
    profile: TrustProfileRef,
    kind: TrustProfileKind,
    anchors: Vec<CertificateDer<'static>>,
    anchor_thumbprints: Vec<String>,
    roots: Arc<RootCertStore>,
    crls: Vec<CertificateRevocationListDer<'static>>,
    generation: u64,
}

impl TrustBundle {
    /// Parse every `CERTIFICATE` block in `pem` as a trust anchor.
    ///
    /// # Errors
    ///
    /// `MalformedConfiguration` when the PEM holds no certificate, a block
    /// does not parse, an anchor is not a CA (`basicConstraints.cA`), an
    /// anchor is outside its validity window, or `webpki` cannot use it as
    /// an anchor.
    pub fn from_pem(
        profile: TrustProfileRef,
        kind: TrustProfileKind,
        pem: &[u8],
    ) -> Result<Self, TransportError> {
        let anchors = CertificateDer::pem_slice_iter(pem)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| malformed(format!("trust bundle PEM: {e}")))?;
        Self::from_der(profile, kind, anchors)
    }

    /// Build from DER anchors.
    ///
    /// # Errors
    ///
    /// As [`Self::from_pem`].
    pub fn from_der(
        profile: TrustProfileRef,
        kind: TrustProfileKind,
        anchors: Vec<CertificateDer<'static>>,
    ) -> Result<Self, TransportError> {
        profile.validate()?;
        if anchors.is_empty() {
            return Err(malformed(format!(
                "trust profile {profile}: no trust anchors"
            )));
        }
        let now = Utc::now();
        let mut roots = RootCertStore::empty();
        let mut anchor_thumbprints = Vec::with_capacity(anchors.len());
        for anchor in &anchors {
            let parsed = ParsedLeaf::parse(anchor)?;
            if !parsed.is_ca {
                return Err(malformed(format!(
                    "trust profile {profile}: anchor {} is not a CA certificate",
                    parsed.thumbprint_sha256
                )));
            }
            if !parsed.is_valid_at(now) {
                return Err(malformed(format!(
                    "trust profile {profile}: anchor {} is outside its validity window",
                    parsed.thumbprint_sha256
                )));
            }
            roots
                .add(anchor.clone())
                .map_err(|e| malformed(format!("trust profile {profile}: anchor rejected: {e}")))?;
            anchor_thumbprints.push(parsed.thumbprint_sha256);
        }
        Ok(Self {
            profile,
            kind,
            anchors,
            anchor_thumbprints,
            roots: Arc::new(roots),
            crls: Vec::new(),
            generation: 0,
        })
    }

    /// Attach every `X509 CRL` block in `crl_pem`. Each CRL must parse for
    /// `webpki`; its signature is checked against the issuing anchor at
    /// verification time.
    ///
    /// # Errors
    ///
    /// `MalformedConfiguration` when a block is not a parseable CRL.
    pub fn with_crls(mut self, crl_pem: &[u8]) -> Result<Self, TransportError> {
        let crls = CertificateRevocationListDer::pem_slice_iter(crl_pem)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| malformed(format!("CRL PEM: {e}")))?;
        for crl in &crls {
            webpki::BorrowedCertRevocationList::from_der(crl.as_ref())
                .map_err(|e| malformed(format!("CRL: {e:?}")))?;
        }
        self.crls.extend(crls);
        Ok(self)
    }

    /// Stamp the bundle with the trust generation it belongs to.
    #[must_use]
    pub fn with_generation(mut self, generation: u64) -> Self {
        self.generation = generation;
        self
    }

    #[must_use]
    pub fn profile(&self) -> &TrustProfileRef {
        &self.profile
    }

    #[must_use]
    pub fn kind(&self) -> TrustProfileKind {
        self.kind
    }

    #[must_use]
    pub fn generation(&self) -> u64 {
        self.generation
    }

    #[must_use]
    pub fn anchors(&self) -> &[CertificateDer<'static>] {
        &self.anchors
    }

    /// SHA-256 thumbprints of the anchors, for status views.
    #[must_use]
    pub fn anchor_thumbprints(&self) -> &[String] {
        &self.anchor_thumbprints
    }

    #[must_use]
    pub fn crls(&self) -> &[CertificateRevocationListDer<'static>] {
        &self.crls
    }

    /// The rustls root store built from the anchors.
    #[must_use]
    pub fn roots(&self) -> Arc<RootCertStore> {
        Arc::clone(&self.roots)
    }

    /// Owned CRL DER for a rustls verifier builder.
    #[must_use]
    pub fn crls_owned(&self) -> Vec<CertificateRevocationListDer<'static>> {
        self.crls.clone()
    }

    /// CRLs parsed for `webpki`.
    ///
    /// # Errors
    ///
    /// `MalformedConfiguration` if a stored CRL no longer parses (cannot
    /// happen after [`Self::with_crls`] succeeded; kept fallible so the
    /// verifier never unwraps).
    pub fn parsed_crls(&self) -> Result<Vec<webpki::CertRevocationList<'_>>, TransportError> {
        self.crls
            .iter()
            .map(|crl| {
                webpki::BorrowedCertRevocationList::from_der(crl.as_ref())
                    .map(webpki::CertRevocationList::from)
                    .map_err(|e| malformed(format!("CRL: {e:?}")))
            })
            .collect()
    }

    /// Revocation options for a `webpki` verification: every certificate in
    /// the chain is checked, and an unknown status is a failure.
    #[must_use]
    pub fn revocation_options<'a>(
        &self,
        crls: &'a [&'a webpki::CertRevocationList<'a>],
    ) -> Option<webpki::RevocationOptions<'a>> {
        let builder = webpki::RevocationOptionsBuilder::new(crls).ok()?;
        Some(
            builder
                .with_depth(webpki::RevocationCheckDepth::Chain)
                .with_status_policy(webpki::UnknownStatusPolicy::Deny)
                .with_expiration_policy(webpki::ExpirationPolicy::Enforce)
                .build(),
        )
    }
}

impl fmt::Debug for TrustBundle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TrustBundle")
            .field("profile", &self.profile)
            .field("kind", &self.kind)
            .field("anchors", &self.anchor_thumbprints)
            .field("crls", &self.crls.len())
            .field("generation", &self.generation)
            .finish_non_exhaustive()
    }
}
