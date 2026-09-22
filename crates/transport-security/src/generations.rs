//! Atomic credential/trust generations.
//!
//! A [`GenerationCandidate`] is validated whole — identity present when the
//! deployment needs one, not expired, chain building to the named trust
//! bundle — and only then swapped in. A failed candidate leaves the current
//! generation serving untouched; nothing is half-installed and nothing's
//! expiry is extended. [`TransportGenerations::withdraw`] replaces the
//! current generation with one carrying a reason so listeners refuse new
//! connections and the request guard denies the open ones.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex, RwLock};

use arc_swap::ArcSwap;
use chrono::{DateTime, Utc};
use opensesame_domain::transport::{TransportError, TrustProfileRef};
use tokio::sync::watch;

use crate::error::malformed;
use crate::identity::{ChainUsage, TlsIdentity};
use crate::trust::TrustBundle;

/// One activated configuration.
#[derive(Clone, Debug)]
pub struct Generation {
    /// Monotonic; starts at 1.
    pub number: u64,
    pub identity: Option<Arc<TlsIdentity>>,
    /// Bundles used to verify peers, by profile.
    pub peer_trust: BTreeMap<TrustProfileRef, TrustBundle>,
    pub activated_at: DateTime<Utc>,
    /// Set once the generation has been withdrawn (source revoked, snapshot
    /// dropped the identity, ...). New connections are refused with it.
    pub withdrawn: Option<TransportError>,
}

impl Generation {
    /// The bundle for a profile.
    ///
    /// # Errors
    ///
    /// `TrustUnknown` when this generation has no bundle for `profile`.
    pub fn trust(&self, profile: &TrustProfileRef) -> Result<&TrustBundle, TransportError> {
        self.peer_trust
            .get(profile)
            .ok_or(TransportError::TrustUnknown)
    }
}

/// What an operator, a file watcher or a Workload API stream proposes.
#[derive(Clone, Debug, Default)]
pub struct GenerationCandidate {
    pub identity: Option<Arc<TlsIdentity>>,
    pub peer_trust: BTreeMap<TrustProfileRef, TrustBundle>,
    /// When set, the identity's chain must validate against this bundle
    /// (private-root and SPIFFE deployments where we trust our own issuer).
    pub own_trust: Option<TrustProfileRef>,
    /// When set, a candidate without an identity is refused.
    pub identity_required: bool,
}

impl GenerationCandidate {
    /// Validate the candidate whole at `now`.
    ///
    /// # Errors
    ///
    /// `IdentityMissing`, `EvidenceExpired`, `TrustUnknown`, or the chain
    /// verification failure; `MalformedConfiguration` for an identity not
    /// yet valid.
    pub fn validate(&self, now: DateTime<Utc>) -> Result<(), TransportError> {
        if self.identity_required && self.identity.is_none() {
            return Err(TransportError::IdentityMissing);
        }
        let Some(identity) = &self.identity else {
            return Ok(());
        };
        if now > identity.not_after() {
            return Err(TransportError::EvidenceExpired);
        }
        if now < identity.not_before() {
            return Err(malformed("identity is not yet valid"));
        }
        if let Some(profile) = &self.own_trust {
            let trust = self
                .peer_trust
                .get(profile)
                .ok_or(TransportError::TrustUnknown)?;
            let usage = if identity.usage().permits_server_auth() {
                ChainUsage::ServerAuth
            } else {
                ChainUsage::ClientAuth
            };
            identity.verify_chain(trust, usage, now)?;
        }
        Ok(())
    }

    /// Validate and stamp as generation `number`.
    ///
    /// # Errors
    ///
    /// As [`Self::validate`].
    pub fn into_generation(
        self,
        number: u64,
        now: DateTime<Utc>,
    ) -> Result<Generation, TransportError> {
        self.validate(now)?;
        Ok(Generation {
            number,
            identity: self.identity,
            peer_trust: self.peer_trust,
            activated_at: now,
            withdrawn: None,
        })
    }
}

/// The current generation, swapped atomically, with a change feed and a
/// process-wide revoked-leaf denylist.
pub struct TransportGenerations {
    current: ArcSwap<Generation>,
    changes: watch::Sender<u64>,
    activation: Mutex<()>,
    denied: RwLock<BTreeSet<String>>,
}

impl std::fmt::Debug for TransportGenerations {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let current = self.current.load();
        f.debug_struct("TransportGenerations")
            .field("number", &current.number)
            .field("withdrawn", &current.withdrawn)
            .finish_non_exhaustive()
    }
}

impl TransportGenerations {
    /// Start from an already-validated generation (see
    /// [`GenerationCandidate::into_generation`]).
    #[must_use]
    pub fn new(initial: Generation) -> Arc<Self> {
        let (changes, _) = watch::channel(initial.number);
        Arc::new(Self {
            current: ArcSwap::from_pointee(initial),
            changes,
            activation: Mutex::new(()),
            denied: RwLock::new(BTreeSet::new()),
        })
    }

    /// The generation serving right now.
    #[must_use]
    pub fn current(&self) -> Arc<Generation> {
        self.current.load_full()
    }

    /// Validate `candidate` whole and, only then, make it current. Returns
    /// the new generation number. Concurrent activations are serialized;
    /// a failure leaves the current generation exactly as it was.
    ///
    /// # Errors
    ///
    /// As [`GenerationCandidate::validate`].
    pub fn activate(&self, candidate: GenerationCandidate) -> Result<u64, TransportError> {
        let _serial = self
            .activation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let now = Utc::now();
        candidate.validate(now)?;
        let number = self.current.load().number + 1;
        let next = candidate.into_generation(number, now)?;
        self.current.store(Arc::new(next));
        self.changes.send_replace(number);
        Ok(number)
    }

    /// Withdraw the current generation: a new number, same material, with
    /// `reason` attached so listeners refuse new connections and the request
    /// guard denies requests on open ones.
    pub fn withdraw(&self, reason: TransportError) {
        let _serial = self
            .activation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let current = self.current.load_full();
        let number = current.number + 1;
        let next = Generation {
            number,
            identity: current.identity.clone(),
            peer_trust: current.peer_trust.clone(),
            activated_at: Utc::now(),
            withdrawn: Some(reason),
        };
        self.current.store(Arc::new(next));
        self.changes.send_replace(number);
    }

    /// A receiver that observes every new generation number.
    #[must_use]
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    /// Deny a leaf thumbprint process-wide (a revoked certificate). Takes
    /// effect at the next handshake and on the next request of every open
    /// connection guarded by [`crate::enforce_current_generation`].
    pub fn deny_thumbprint(&self, thumbprint: &str) {
        self.denied
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(thumbprint.to_ascii_lowercase());
    }

    /// Whether a leaf thumbprint is denied.
    #[must_use]
    pub fn is_denied(&self, thumbprint: &str) -> bool {
        self.denied
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains(&thumbprint.to_ascii_lowercase())
    }
}
