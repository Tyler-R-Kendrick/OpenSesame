//! The privileged constructor for [`VerifiedPeer`].
//!
//! [`AttestedPeer`] is what a verifier that has *actually* authenticated a
//! peer fills in. Its callers are enumerated by a source-contract test:
//! `crates/transport-security` (rustls verifier), `apps/control-plane`'s
//! transport receiver (Node `tls.TLSSocket` facts, via the TS mirror), and
//! `crates/uds-authn` (kernel peer credentials). It cannot be deserialized, so
//! no route, header, or manifest can produce one.

use super::error::TransportError;
use super::evidence::VerifiedPeer;
use super::policy::{EvidenceSource, TlsVersion, TransportPolicy, TrustProfileRef};
use super::selector::PeerIdentitySelector;
use super::{validate_id, validate_thumbprint};
use chrono::{DateTime, Utc};

/// Facts a verifier attests to before they become [`VerifiedPeer`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttestedPeer {
    pub source: EvidenceSource,
    /// SAN-derived selectors; the leaf thumbprint selector is appended when
    /// absent and must equal `leaf_thumbprint_sha256` when present.
    pub identities: Vec<PeerIdentitySelector>,
    pub leaf_thumbprint_sha256: String,
    pub not_before: DateTime<Utc>,
    pub not_after: DateTime<Utc>,
    pub trust_profile: TrustProfileRef,
    pub trust_generation: u64,
    pub credential_generation: u64,
    pub listener: String,
    pub policy: TransportPolicy,
    pub tls_version: TlsVersion,
    pub authenticated_at: DateTime<Utc>,
    pub usable_until: DateTime<Utc>,
    /// Required (and only allowed) when `source` is `TrustedIngressAssertion`.
    pub ingress: Option<Box<AttestedPeer>>,
}

impl AttestedPeer {
    /// Validate every field and seal the evidence.
    ///
    /// # Errors
    ///
    /// - `MalformedConfiguration`: bad thumbprint, malformed or duplicate
    ///   selector, thumbprint selector disagreeing with the leaf, bad
    ///   listener id, inverted validity window.
    /// - `EvidenceExpired`: `authenticated_at` outside the certificate
    ///   window, or `usable_until` outside `[authenticated_at, not_after]`.
    /// - `ListenerPolicyMismatch`: the evidence source cannot occur under
    ///   the listener's policy.
    /// - `ForwardedEvidenceUnverified`: an assertion without an ingress, an
    ///   ingress on a non-assertion, or an ingress that is not itself a
    ///   directly authenticated `TrustedIngress` peer.
    pub fn into_verified(self) -> Result<VerifiedPeer, TransportError> {
        validate_thumbprint(
            "attested.leaf_thumbprint_sha256",
            &self.leaf_thumbprint_sha256,
        )?;
        validate_id("attested.listener", &self.listener)?;
        let identities = self.validated_identities()?;
        self.check_window()?;
        self.check_policy()?;
        let ingress = self.verified_ingress()?;
        Ok(VerifiedPeer {
            source: self.source,
            identities,
            leaf_thumbprint_sha256: self.leaf_thumbprint_sha256,
            not_before: self.not_before,
            not_after: self.not_after,
            trust_profile: self.trust_profile,
            trust_generation: self.trust_generation,
            credential_generation: self.credential_generation,
            listener: self.listener,
            policy: self.policy,
            tls_version: self.tls_version,
            authenticated_at: self.authenticated_at,
            usable_until: self.usable_until,
            ingress,
        })
    }

    fn validated_identities(&self) -> Result<Vec<PeerIdentitySelector>, TransportError> {
        self.trust_profile.validate()?;
        let mut identities = Vec::with_capacity(self.identities.len() + 1);
        let mut saw_thumbprint = false;
        for selector in &self.identities {
            selector.validate()?;
            if identities.contains(selector) {
                return Err(TransportError::malformed(
                    "attested.identities: duplicate selector",
                ));
            }
            saw_thumbprint |= self.check_thumbprint_selector(selector)?;
            identities.push(selector.clone());
        }
        if !saw_thumbprint {
            identities.push(PeerIdentitySelector::LeafThumbprintSha256(
                self.leaf_thumbprint_sha256.clone(),
            ));
        }
        Ok(identities)
    }

    /// `Ok(true)` when `selector` is the leaf thumbprint; an error when it is
    /// a thumbprint that disagrees with the leaf.
    fn check_thumbprint_selector(
        &self,
        selector: &PeerIdentitySelector,
    ) -> Result<bool, TransportError> {
        let PeerIdentitySelector::LeafThumbprintSha256(t) = selector else {
            return Ok(false);
        };
        if t == &self.leaf_thumbprint_sha256 {
            Ok(true)
        } else {
            Err(TransportError::malformed(
                "attested.identities: thumbprint selector disagrees with the leaf",
            ))
        }
    }

    fn check_window(&self) -> Result<(), TransportError> {
        if self.not_before >= self.not_after {
            return Err(TransportError::malformed(
                "attested: not_before must precede not_after",
            ));
        }
        let inside_cert =
            self.not_before <= self.authenticated_at && self.authenticated_at < self.not_after;
        let usable_ok =
            self.authenticated_at <= self.usable_until && self.usable_until <= self.not_after;
        if inside_cert && usable_ok {
            Ok(())
        } else {
            Err(TransportError::EvidenceExpired)
        }
    }

    fn check_policy(&self) -> Result<(), TransportError> {
        let consistent = match self.source {
            EvidenceSource::DirectTls => self.policy.authenticates_client(),
            EvidenceSource::LocalIpc => self.policy == TransportPolicy::ExistingLocal,
            EvidenceSource::TrustedIngressAssertion => {
                self.policy == TransportPolicy::TrustedIngress
            }
        };
        if consistent {
            Ok(())
        } else {
            Err(TransportError::ListenerPolicyMismatch)
        }
    }

    fn verified_ingress(&self) -> Result<Option<Box<VerifiedPeer>>, TransportError> {
        match (self.source, &self.ingress) {
            (EvidenceSource::TrustedIngressAssertion, Some(ingress)) => {
                let accepted = ingress.source == EvidenceSource::DirectTls
                    && ingress.policy == TransportPolicy::TrustedIngress
                    && ingress.ingress.is_none();
                if !accepted {
                    return Err(TransportError::ForwardedEvidenceUnverified);
                }
                Ok(Some(Box::new(ingress.as_ref().clone().into_verified()?)))
            }
            (EvidenceSource::TrustedIngressAssertion, None) | (_, Some(_)) => {
                Err(TransportError::ForwardedEvidenceUnverified)
            }
            (_, None) => Ok(None),
        }
    }
}
