//! Per-trust-domain trust bundles, and peer verification against exactly one
//! domain's anchors.
//!
//! A peer is verified against the bundle of the trust domain **it presents**
//! (from its own URI SAN) and then against the allowed-peer set. The anchors
//! of every other domain are never consulted: there is no union-of-all-domains
//! trust store, so domain A's bundle can never vouch for a domain-B SVID
//! (AT-SPIFFE-FEDERATION). Removing a domain from a snapshot removes its
//! anchors from the next generation, and the verifier built from that
//! generation stops accepting the domain.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use rustls_pki_types::{CertificateDer, UnixTime};
use spiffe::X509Context;
use webpki::{EndEntityCert, KeyUsage};
use x509_parser::prelude::{FromDer as _, X509Certificate};

use crate::error::SpiffeSourceError;
use crate::pem::chain_to_pem;
use crate::svid_profile::{
    presented_spiffe_id, validate_leaf, SvidExpectation, SvidFacts, SvidProfileError, SvidRole,
};

/// Bundles keyed by trust domain name.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TrustDomainBundles {
    domains: BTreeMap<String, Vec<CertificateDer<'static>>>,
}

/// Why a presented peer chain was refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PeerVerifyError {
    #[error("peer presented no certificate")]
    EmptyChain,
    #[error("peer leaf: {0}")]
    Profile(#[from] SvidProfileError),
    #[error("no trust bundle for the peer's trust domain {trust_domain}")]
    NoBundleForPresentedDomain { trust_domain: String },
    #[error("peer chain does not verify against its trust domain's bundle: {0}")]
    ChainInvalid(String),
    #[error("peer {presented} is authenticated but not in the allowed set")]
    PeerNotAllowed { presented: String },
}

impl TrustDomainBundles {
    /// Every bundle a Workload API context carries: the SVIDs' own domains
    /// plus federated domains. Each authority must parse and be a CA. A
    /// domain whose bundle carries no authorities is simply absent: nothing
    /// vouches for it, so nothing from it verifies.
    ///
    /// # Errors
    /// [`SpiffeSourceError::BundleMalformed`] naming the domain.
    pub fn from_context(ctx: &X509Context) -> Result<Self, SpiffeSourceError> {
        let mut out = Self::default();
        for (td, bundle) in ctx.bundle_set().iter() {
            let anchors: Vec<Vec<u8>> = bundle
                .authorities()
                .iter()
                .map(|c| c.as_bytes().to_vec())
                .collect();
            if anchors.is_empty() {
                continue;
            }
            out.insert(td.as_str(), anchors)?;
        }
        Ok(out)
    }

    /// Insert (or replace) the anchors of one trust domain.
    ///
    /// # Errors
    /// An empty set, an unparsable certificate, or a non-CA certificate.
    pub fn insert(
        &mut self,
        trust_domain: &str,
        anchors_der: Vec<Vec<u8>>,
    ) -> Result<(), SpiffeSourceError> {
        let malformed = |detail: &str| SpiffeSourceError::BundleMalformed {
            trust_domain: trust_domain.to_owned(),
            detail: detail.to_owned(),
        };
        if anchors_der.is_empty() {
            return Err(malformed("bundle carries no authorities"));
        }
        let mut anchors = Vec::with_capacity(anchors_der.len());
        for der in anchors_der {
            let (rest, cert) =
                X509Certificate::from_der(&der).map_err(|_| malformed("authority is not DER"))?;
            if !rest.is_empty() {
                return Err(malformed("authority has trailing bytes"));
            }
            if !cert.is_ca() {
                return Err(malformed("authority is not a CA certificate"));
            }
            anchors.push(CertificateDer::from(der));
        }
        self.domains.insert(trust_domain.to_owned(), anchors);
        Ok(())
    }

    /// Anchors for one trust domain, if present.
    #[must_use]
    pub fn get(&self, trust_domain: &str) -> Option<&[CertificateDer<'static>]> {
        self.domains.get(trust_domain).map(Vec::as_slice)
    }

    /// Trust domain names, sorted.
    pub fn trust_domains(&self) -> impl Iterator<Item = &str> {
        self.domains.keys().map(String::as_str)
    }

    /// Number of trust domains.
    #[must_use]
    pub fn len(&self) -> usize {
        self.domains.len()
    }

    /// True when no domain is trusted.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.domains.is_empty()
    }

    /// One domain's anchors as PEM, for `TrustBundle::from_pem`.
    #[must_use]
    pub fn pem_for(&self, trust_domain: &str) -> Option<Vec<u8>> {
        self.get(trust_domain).map(chain_to_pem)
    }

    /// Verify a presented chain (leaf first) as an X509-SVID peer taking
    /// `role`, against **its own** trust domain's anchors, then against the
    /// exact `allowed` SPIFFE IDs.
    ///
    /// # Errors
    /// In order: empty chain; unparsable/non-SVID leaf; no bundle for the
    /// presented domain; chain does not verify; SVID profile violation;
    /// authenticated but not allowed.
    pub fn verify_peer(
        &self,
        chain_der: &[&[u8]],
        role: SvidRole,
        allowed: &[&str],
        now: DateTime<Utc>,
    ) -> Result<SvidFacts, PeerVerifyError> {
        let (leaf, intermediates) = chain_der.split_first().ok_or(PeerVerifyError::EmptyChain)?;
        let id = presented_spiffe_id(leaf)?;
        let trust_domain = id.trust_domain().to_string();
        let anchors_der =
            self.get(&trust_domain)
                .ok_or_else(|| PeerVerifyError::NoBundleForPresentedDomain {
                    trust_domain: trust_domain.clone(),
                })?;
        let anchors = anchors_der
            .iter()
            .map(webpki::anchor_from_trusted_cert)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| PeerVerifyError::ChainInvalid(e.to_string()))?;
        let leaf_der = CertificateDer::from(*leaf);
        let ee = EndEntityCert::try_from(&leaf_der)
            .map_err(|e| PeerVerifyError::ChainInvalid(e.to_string()))?;
        let inters: Vec<CertificateDer<'_>> = intermediates
            .iter()
            .map(|d| CertificateDer::from(*d))
            .collect();
        let secs = u64::try_from(now.timestamp()).unwrap_or(0);
        let usage = match role {
            SvidRole::Client => KeyUsage::client_auth(),
            SvidRole::Server => KeyUsage::server_auth(),
        };
        ee.verify_for_usage(
            webpki::ALL_VERIFICATION_ALGS,
            &anchors,
            &inters,
            UnixTime::since_unix_epoch(std::time::Duration::from_secs(secs)),
            usage,
            None,
            None,
        )
        .map_err(|e| PeerVerifyError::ChainInvalid(e.to_string()))?;
        let facts = validate_leaf(
            leaf,
            &SvidExpectation {
                trust_domain: &trust_domain,
                spiffe_id: None,
                role,
            },
            now,
        )?;
        if !allowed.contains(&facts.spiffe_id.as_str()) {
            return Err(PeerVerifyError::PeerNotAllowed {
                presented: facts.spiffe_id,
            });
        }
        Ok(facts)
    }
}

#[cfg(all(test, feature = "fake-workload-api"))]
#[path = "bundles_tests.rs"]
mod tests;
