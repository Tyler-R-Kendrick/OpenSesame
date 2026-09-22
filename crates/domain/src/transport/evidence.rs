//! Verified peer evidence and its safe, serializable view.
//!
//! [`VerifiedPeer`] has private fields, no `Deserialize`, and no public
//! constructor: the only way in is [`super::attest::AttestedPeer::into_verified`],
//! which validates everything and whose callers are the TLS verifier, the
//! Identity plane's socket receiver, and the UDS peer-credential adapter.
//! A JSON body, a header, or a plugin manifest can therefore never become
//! trusted evidence (AT-TLS-FAKECONTEXT).

use super::binding::{BindingPurpose, BindingScope, ServiceBinding, ServiceBindingSet};
use super::error::TransportError;
use super::policy::{EvidenceSource, TlsVersion, TransportPolicy, TrustProfileRef};
use super::selector::PeerIdentitySelector;
use super::timestamp;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Internal verified evidence about one authenticated peer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedPeer {
    pub(super) source: EvidenceSource,
    pub(super) identities: Vec<PeerIdentitySelector>,
    pub(super) leaf_thumbprint_sha256: String,
    pub(super) not_before: DateTime<Utc>,
    pub(super) not_after: DateTime<Utc>,
    pub(super) trust_profile: TrustProfileRef,
    pub(super) trust_generation: u64,
    pub(super) credential_generation: u64,
    pub(super) listener: String,
    pub(super) policy: TransportPolicy,
    pub(super) tls_version: TlsVersion,
    pub(super) authenticated_at: DateTime<Utc>,
    pub(super) usable_until: DateTime<Utc>,
    pub(super) ingress: Option<Box<VerifiedPeer>>,
}

impl VerifiedPeer {
    #[must_use]
    pub const fn source(&self) -> EvidenceSource {
        self.source
    }
    /// Every validated selector: SANs plus the leaf thumbprint.
    #[must_use]
    pub fn identities(&self) -> &[PeerIdentitySelector] {
        &self.identities
    }
    #[must_use]
    pub fn leaf_thumbprint_sha256(&self) -> &str {
        &self.leaf_thumbprint_sha256
    }
    #[must_use]
    pub const fn not_before(&self) -> DateTime<Utc> {
        self.not_before
    }
    #[must_use]
    pub const fn not_after(&self) -> DateTime<Utc> {
        self.not_after
    }
    #[must_use]
    pub const fn trust_profile(&self) -> &TrustProfileRef {
        &self.trust_profile
    }
    #[must_use]
    pub const fn trust_generation(&self) -> u64 {
        self.trust_generation
    }
    #[must_use]
    pub const fn credential_generation(&self) -> u64 {
        self.credential_generation
    }
    #[must_use]
    pub fn listener(&self) -> &str {
        &self.listener
    }
    #[must_use]
    pub const fn policy(&self) -> TransportPolicy {
        self.policy
    }
    #[must_use]
    pub const fn tls_version(&self) -> TlsVersion {
        self.tls_version
    }
    #[must_use]
    pub const fn authenticated_at(&self) -> DateTime<Utc> {
        self.authenticated_at
    }
    #[must_use]
    pub const fn usable_until(&self) -> DateTime<Utc> {
        self.usable_until
    }
    /// The authenticated ingress that forwarded this evidence; set only when
    /// `source` is `TrustedIngressAssertion`.
    #[must_use]
    pub fn ingress(&self) -> Option<&VerifiedPeer> {
        self.ingress.as_deref()
    }

    /// True while `now` is inside `[authenticated_at, usable_until]`.
    #[must_use]
    pub fn is_usable_at(&self, now: DateTime<Utc>) -> bool {
        self.authenticated_at <= now && now < self.usable_until
    }

    /// Deny when either generation the evidence was produced under is no
    /// longer the current one.
    ///
    /// # Errors
    ///
    /// `GenerationStale`.
    pub fn require_generations(
        &self,
        current_trust: u64,
        current_credential: u64,
    ) -> Result<(), TransportError> {
        if self.trust_generation == current_trust
            && self.credential_generation == current_credential
        {
            Ok(())
        } else {
            Err(TransportError::GenerationStale)
        }
    }

    /// Safe DTO: no subject DN, no chain, no key material.
    #[must_use]
    pub fn view(&self) -> PeerEvidenceView {
        PeerEvidenceView {
            source: self.source,
            identities: self.identities.clone(),
            leaf_thumbprint_sha256: self.leaf_thumbprint_sha256.clone(),
            not_before: self.not_before,
            not_after: self.not_after,
            trust_profile: self.trust_profile.clone(),
            trust_generation: self.trust_generation,
            credential_generation: self.credential_generation,
            listener: self.listener.clone(),
            policy: self.policy,
            tls_version: self.tls_version,
            authenticated_at: self.authenticated_at,
            usable_until: self.usable_until,
            ingress: self.ingress.as_ref().map(|i| Box::new(i.view())),
        }
    }
}

/// Serializable, audit-safe view of a [`VerifiedPeer`]. Deserializable (it is
/// a status DTO), but nothing turns it back into a `VerifiedPeer`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct PeerEvidenceView {
    pub source: EvidenceSource,
    pub identities: Vec<PeerIdentitySelector>,
    pub leaf_thumbprint_sha256: String,
    #[serde(with = "timestamp")]
    pub not_before: DateTime<Utc>,
    #[serde(with = "timestamp")]
    pub not_after: DateTime<Utc>,
    pub trust_profile: TrustProfileRef,
    pub trust_generation: u64,
    pub credential_generation: u64,
    pub listener: String,
    pub policy: TransportPolicy,
    pub tls_version: TlsVersion,
    #[serde(with = "timestamp")]
    pub authenticated_at: DateTime<Utc>,
    #[serde(with = "timestamp")]
    pub usable_until: DateTime<Utc>,
    #[serde(default)]
    pub ingress: Option<Box<PeerEvidenceView>>,
}

/// An admitted service caller: verified peer + the one binding it resolved
/// to. Built by admission, never deserialized.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServiceCaller {
    /// The immediate authenticated peer whose binding was resolved: the
    /// ingress on a `TrustedIngressAssertion` path, the client otherwise.
    pub peer: VerifiedPeer,
    pub binding: ServiceBinding,
    /// The originating client an authenticated ingress vouched for. Request
    /// local; never the connection's identity.
    pub originating: Option<VerifiedPeer>,
}

impl ServiceCaller {
    /// Admit a verified peer for `purpose` in `scope` against the current
    /// binding set and generations. Order: usable window → generations →
    /// binding resolution (which also refuses denied thumbprints). On a
    /// `TrustedIngressAssertion` peer the ingress is the peer that is bound
    /// and the assertion becomes `originating`.
    ///
    /// # Errors
    ///
    /// `EvidenceExpired`, `GenerationStale`, `ForwardedEvidenceUnverified`,
    /// or any [`ServiceBindingSet::resolve_scoped`] error.
    pub fn admit(
        peer: VerifiedPeer,
        scope: &BindingScope,
        bindings: &ServiceBindingSet,
        purpose: BindingPurpose,
        current_trust_generation: u64,
        current_credential_generation: u64,
        now: DateTime<Utc>,
    ) -> Result<Self, TransportError> {
        let (bound, originating) = if peer.source == EvidenceSource::TrustedIngressAssertion {
            let Some(ingress) = peer.ingress.clone() else {
                return Err(TransportError::ForwardedEvidenceUnverified);
            };
            (*ingress, Some(peer))
        } else {
            (peer, None)
        };
        for evidence in std::iter::once(&bound).chain(originating.iter()) {
            if !evidence.is_usable_at(now) {
                return Err(TransportError::EvidenceExpired);
            }
        }
        bound.require_generations(current_trust_generation, current_credential_generation)?;
        let binding = bindings
            .resolve_scoped(scope, &bound.trust_profile, &bound.identities, purpose, now)?
            .clone();
        Ok(Self {
            peer: bound,
            binding,
            originating,
        })
    }

    /// Effective authority is an intersection: the binding must allow the
    /// exact operation.
    ///
    /// # Errors
    ///
    /// `PeerDisallowed`.
    pub fn require_operation(&self, operation: &str) -> Result<(), TransportError> {
        if self.binding.allows_operation(operation) {
            Ok(())
        } else {
            Err(TransportError::PeerDisallowed)
        }
    }

    /// The binding must allow the exact audience.
    ///
    /// # Errors
    ///
    /// `PeerDisallowed`.
    pub fn require_audience(&self, audience: &str) -> Result<(), TransportError> {
        if self.binding.allows_audience(audience) {
            Ok(())
        } else {
            Err(TransportError::PeerDisallowed)
        }
    }
}
