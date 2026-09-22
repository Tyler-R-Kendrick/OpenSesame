//! One Workload API snapshot reduced to the generation this workload may run
//! with: the exactly-configured SVID, validated against the X509-SVID
//! profile, plus every trust domain's bundle from the same message.
//!
//! Selection is by exact SPIFFE ID. The Workload API's "first returned" /
//! default SVID and the operator `hint` are never a privilege decision
//! (AT-SPIFFE-SELECT).

use chrono::{DateTime, Utc};
use secrecy::{ExposeSecret as _, SecretBox};
use spiffe::X509Context;

pub use crate::bundles::TrustDomainBundles;
use crate::config::SpiffeSourceConfig;
use crate::error::SpiffeSourceError;
use crate::pem::{chain_to_pem, key_to_pem};
use crate::svid_profile::{validate_leaf, SvidExpectation};

/// A validated candidate generation. The private key is held in a zeroizing
/// box and never appears in `Debug`.
pub struct SvidGeneration {
    /// The selected SPIFFE ID (equal to the configured one).
    pub spiffe_id: String,
    /// Its trust domain.
    pub trust_domain: String,
    /// DER chain, leaf first.
    pub chain_der: Vec<Vec<u8>>,
    key_pkcs8_der: SecretBox<Vec<u8>>,
    /// Leaf validity start.
    pub not_before: DateTime<Utc>,
    /// Leaf validity end: the hard bound on this generation's life.
    pub not_after: DateTime<Utc>,
    /// SHA-256 of the leaf DER, lowercase hex.
    pub leaf_thumbprint_sha256: String,
    /// Every trust domain the snapshot vouches for, keyed by name.
    pub bundles: TrustDomainBundles,
    /// When the snapshot was reduced.
    pub received_at: DateTime<Utc>,
}

impl std::fmt::Debug for SvidGeneration {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SvidGeneration")
            .field("spiffe_id", &self.spiffe_id)
            .field("trust_domain", &self.trust_domain)
            .field("chain_len", &self.chain_der.len())
            .field("not_after", &self.not_after)
            .field("leaf_thumbprint_sha256", &self.leaf_thumbprint_sha256)
            .field(
                "trust_domains",
                &self.bundles.trust_domains().collect::<Vec<_>>(),
            )
            .finish_non_exhaustive()
    }
}

impl SvidGeneration {
    /// Reduce a Workload API context to the configured identity.
    ///
    /// # Errors
    /// * [`SpiffeSourceError::NotIssued`] — the configured ID is absent (an
    ///   authoritative withdrawal);
    /// * [`SpiffeSourceError::Ambiguous`] — it is present more than once;
    /// * [`SpiffeSourceError::Profile`] — the leaf is not a conforming SVID
    ///   for the configured role;
    /// * [`SpiffeSourceError::BundleMissing`] / `BundleMalformed` — the own
    ///   trust domain has no usable bundle in the same message.
    pub fn select(
        ctx: &X509Context,
        config: &SpiffeSourceConfig,
        now: DateTime<Utc>,
    ) -> Result<Self, SpiffeSourceError> {
        let matches: Vec<_> = ctx
            .svids()
            .iter()
            .filter(|svid| svid.spiffe_id().to_string() == config.spiffe_id())
            .collect();
        let svid = match matches.as_slice() {
            [] => {
                return Err(SpiffeSourceError::NotIssued {
                    offered: ctx.svids().len(),
                })
            }
            [one] => *one,
            many => {
                return Err(SpiffeSourceError::Ambiguous { count: many.len() });
            }
        };
        let facts = validate_leaf(
            svid.leaf().as_bytes(),
            &SvidExpectation {
                trust_domain: config.trust_domain(),
                spiffe_id: Some(config.spiffe_id()),
                role: config.role(),
            },
            now,
        )?;
        let bundles = TrustDomainBundles::from_context(ctx)?;
        if bundles.get(&facts.trust_domain).is_none() {
            return Err(SpiffeSourceError::BundleMissing {
                trust_domain: facts.trust_domain,
            });
        }
        Ok(Self {
            spiffe_id: facts.spiffe_id,
            trust_domain: facts.trust_domain,
            chain_der: svid
                .cert_chain()
                .iter()
                .map(|c| c.as_bytes().to_vec())
                .collect(),
            key_pkcs8_der: SecretBox::new(Box::new(svid.private_key().as_bytes().to_vec())),
            not_before: facts.not_before,
            not_after: facts.not_after,
            leaf_thumbprint_sha256: facts.leaf_thumbprint_sha256,
            bundles,
            received_at: now,
        })
    }

    /// The chain as PEM, for `TlsIdentity::from_pem`.
    #[must_use]
    pub fn chain_pem(&self) -> Vec<u8> {
        chain_to_pem(&self.chain_der)
    }

    /// The private key as PKCS#8 PEM inside a zeroizing box.
    #[must_use]
    pub fn key_pem(&self) -> SecretBox<Vec<u8>> {
        key_to_pem(self.key_pkcs8_der.expose_secret())
    }

    /// The PKCS#8 DER key, for the generation manager only.
    pub(crate) const fn key_pkcs8_der(&self) -> &SecretBox<Vec<u8>> {
        &self.key_pkcs8_der
    }

    /// Leaf DER.
    #[must_use]
    pub fn leaf_der(&self) -> &[u8] {
        self.chain_der.first().map_or(&[], Vec::as_slice)
    }
}

#[cfg(all(test, feature = "fake-workload-api"))]
#[path = "snapshot_tests.rs"]
mod tests;
