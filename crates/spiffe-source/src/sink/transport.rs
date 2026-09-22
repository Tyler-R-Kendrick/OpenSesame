//! The production sink: `opensesame_transport_security::TransportGenerations`.
//!
//! Every Workload API snapshot becomes one [`GenerationCandidate`]: the
//! selected SVID as the identity (`identity_required`), and one
//! [`TrustBundle`] of kind `SpiffeTrustDomain` per trust domain the snapshot
//! carried, each under a trust profile named after its domain. `own_trust`
//! names the SVID's own domain so the manager re-verifies our chain against
//! our issuer before the swap. A withdrawal is
//! [`TransportGenerations::withdraw`], which every listener and client built
//! on the manager observes on its next handshake.

use std::collections::BTreeMap;
use std::sync::Arc;

use opensesame_domain::{TransportError, TrustProfileKind, TrustProfileRef};
use opensesame_transport_security::{
    GenerationCandidate, TlsIdentity, TransportGenerations, TrustBundle,
};
use rustls_pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use secrecy::ExposeSecret as _;

use super::GenerationSink;
use crate::snapshot::SvidGeneration;

/// Adapter from [`SvidGeneration`] to the native generation manager.
#[derive(Clone)]
pub struct TransportGenerationsSink {
    generations: Arc<TransportGenerations>,
}

impl std::fmt::Debug for TransportGenerationsSink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TransportGenerationsSink")
            .finish_non_exhaustive()
    }
}

impl TransportGenerationsSink {
    /// Wrap a manager.
    #[must_use]
    pub const fn new(generations: Arc<TransportGenerations>) -> Self {
        Self { generations }
    }

    /// The manager, for building listeners and clients.
    #[must_use]
    pub fn generations(&self) -> Arc<TransportGenerations> {
        Arc::clone(&self.generations)
    }

    /// The trust profile a trust domain's bundle is filed under: the domain
    /// name itself.
    ///
    /// # Errors
    /// A domain name that is not a valid profile name (longer than 64 bytes).
    pub fn profile_for(trust_domain: &str) -> Result<TrustProfileRef, TransportError> {
        TrustProfileRef::new(trust_domain)
    }

    /// Build the candidate without activating it.
    ///
    /// # Errors
    /// Key/chain mismatch, unusable anchors, or a domain name that cannot be
    /// a profile name.
    pub fn candidate(generation: &SvidGeneration) -> Result<GenerationCandidate, TransportError> {
        let chain: Vec<CertificateDer<'static>> = generation
            .chain_der
            .iter()
            .map(|d| CertificateDer::from(d.clone()))
            .collect();
        let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
            generation.key_pkcs8_der().expose_secret().clone(),
        ));
        let identity = TlsIdentity::from_der(chain, key)?;
        let mut peer_trust = BTreeMap::new();
        for domain in generation.bundles.trust_domains() {
            let profile = Self::profile_for(domain)?;
            let anchors = generation
                .bundles
                .get(domain)
                .map(<[CertificateDer<'static>]>::to_vec)
                .unwrap_or_default();
            let bundle = TrustBundle::from_der(
                profile.clone(),
                TrustProfileKind::SpiffeTrustDomain,
                anchors,
            )?;
            peer_trust.insert(profile, bundle);
        }
        Ok(GenerationCandidate {
            identity: Some(Arc::new(identity)),
            peer_trust,
            own_trust: Some(Self::profile_for(&generation.trust_domain)?),
            identity_required: true,
        })
    }
}

impl GenerationSink for TransportGenerationsSink {
    fn activate(&self, generation: &SvidGeneration) -> Result<u64, TransportError> {
        let candidate = Self::candidate(generation)?;
        self.generations.activate(candidate)
    }

    fn withdraw(&self, reason: TransportError) {
        self.generations.withdraw(reason);
    }
}
