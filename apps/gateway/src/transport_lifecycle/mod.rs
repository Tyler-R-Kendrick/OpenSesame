//! Certificate lifecycle for the optional mTLS / workload-identity profiles
//! (ADR 0130, SW-LIFECYCLE): custody access, transport issuance, autonomous
//! renewal, atomic activation, revocation, and operator-managed trust.
//!
//! One handle, [`LifecycleState`], lives on `AppState` and holds everything
//! that must survive across requests: the resolved-identity cache, the
//! process-wide revoked-leaf denylist, the renewal scheduler, the CRL
//! freshness reading, and the seam to the transport runtime's
//! [`TransportGenerations`] (attached by the runtime at boot; absent in a
//! deployment with no secure listener, in which case every activation is a
//! recorded fact and nothing else).
//!
//! Nothing here holds a lock across an `.await`: every field is `std::sync`
//! and every critical section is a few instructions.
//!
//! | File | Owns |
//! |---|---|
//! | [`custody`] | `ManagedIdentityResolver` / client-identity resolution over `managed_certs_tls` |
//! | [`issuance`] | `issue_for_transport`: exact selector, purpose-shaped EKUs, validity policy |
//! | [`renewal`] | the lifecycle-feed subscriber, lease, bounded retry with jitter |
//! | [`activation`] | candidate → `TransportGenerations::activate`, facts either way |
//! | [`revocation`] | denylist, binding denials, CRL freshness, the revoke verb |
//! | [`trust`] | operator trust profiles: validation, CAS, overlap rollover, re-activation |
//! | [`facts`] | the independent per-target facts, persisted in `host_kv` |
//! | [`routes`] | the operator routes, merged by the coordinator |

pub mod activation;
pub mod custody;
pub mod facts;
pub mod issuance;
pub mod renewal;
pub mod revocation;
pub mod routes;
pub mod trust;

#[cfg(test)]
pub(crate) mod test_support;
#[cfg(test)]
mod activation_tests;
#[cfg(test)]
mod custody_tests;
#[cfg(test)]
mod issuance_tests;
#[cfg(test)]
mod renewal_tests;
#[cfg(test)]
mod revocation_tests;
#[cfg(test)]
mod trust_tests;

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, Mutex, RwLock};

use opensesame_domain::transport::{ServiceBindingSet, TrustProfileRef};
use opensesame_transport_security::{DenyThumbprint, TlsIdentity, TransportGenerations, TrustBundle};

pub use crate::managed_certs_tls::TransportPurpose;

/// The Host's own listener target name, as used for facts.
pub const HOST_LISTENER_TARGET: &str = "host-tls";

fn poisoned<T>(error: std::sync::PoisonError<T>) -> T {
    error.into_inner()
}

/// Process-lifetime lifecycle state (see the module docs).
pub struct LifecycleState {
    /// `organization:certificate_id:purpose` → resolved identity.
    identities: Mutex<HashMap<String, Arc<TlsIdentity>>>,
    /// Revoked leaf thumbprints, lowercase hex. Consulted at every handshake
    /// (through [`Self::deny_hook`]) and on every guarded request.
    denied: RwLock<BTreeSet<String>>,
    /// The transport runtime's generations, once attached.
    generations: RwLock<Option<Arc<TransportGenerations>>>,
    /// The runtime's live binding set, once attached, so a revocation can
    /// write `denied_thumbprints` where admission reads them.
    bindings: RwLock<Option<Arc<std::sync::RwLock<ServiceBindingSet>>>>,
    /// Trust bundles the deployment plane configured (env files). Stored
    /// profiles are merged beside them and may never shadow one.
    base_trust: RwLock<BTreeMap<TrustProfileRef, TrustBundle>>,
    /// target → certificate id, for facts and renewal-driven activation.
    targets: RwLock<BTreeMap<String, String>>,
    renewal: Mutex<renewal::Scheduler>,
    crl: RwLock<Option<revocation::CrlFreshness>>,
    /// The stored-trust revision last activated, and the overlap epoch it
    /// was activated under, so a passed `overlap_until` re-activates once.
    trust_epoch: Mutex<trust::ActivatedEpoch>,
}

impl std::fmt::Debug for LifecycleState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LifecycleState")
            .field("cached_identities", &self.cached_identity_count())
            .field("denied", &self.denied_count())
            .field("generations_attached", &self.generations().is_some())
            .finish_non_exhaustive()
    }
}

impl Default for LifecycleState {
    fn default() -> Self {
        Self {
            identities: Mutex::new(HashMap::new()),
            denied: RwLock::new(BTreeSet::new()),
            generations: RwLock::new(None),
            bindings: RwLock::new(None),
            base_trust: RwLock::new(BTreeMap::new()),
            targets: RwLock::new(BTreeMap::new()),
            renewal: Mutex::new(renewal::Scheduler::default()),
            crl: RwLock::new(None),
            trust_epoch: Mutex::new(trust::ActivatedEpoch::default()),
        }
    }
}

impl LifecycleState {
    #[must_use]
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    // —— runtime seams ————————————————————————————————————————————

    /// Attach the transport runtime's generations and the deployment-plane
    /// trust bundles it was booted with. Called once by the runtime.
    pub fn attach_generations(
        &self,
        generations: Arc<TransportGenerations>,
        base_trust: BTreeMap<TrustProfileRef, TrustBundle>,
    ) {
        *self.generations.write().unwrap_or_else(poisoned) = Some(generations);
        *self.base_trust.write().unwrap_or_else(poisoned) = base_trust;
    }

    /// Attach the runtime's live binding set.
    pub fn attach_bindings(&self, bindings: Arc<std::sync::RwLock<ServiceBindingSet>>) {
        *self.bindings.write().unwrap_or_else(poisoned) = Some(bindings);
    }

    #[must_use]
    pub fn generations(&self) -> Option<Arc<TransportGenerations>> {
        self.generations.read().unwrap_or_else(poisoned).clone()
    }

    #[must_use]
    pub fn bindings(&self) -> Option<Arc<std::sync::RwLock<ServiceBindingSet>>> {
        self.bindings.read().unwrap_or_else(poisoned).clone()
    }

    #[must_use]
    pub fn base_trust(&self) -> BTreeMap<TrustProfileRef, TrustBundle> {
        self.base_trust.read().unwrap_or_else(poisoned).clone()
    }

    /// Record that `target` serves `certificate_id` (a managed identity).
    pub fn bind_target(&self, target: &str, certificate_id: &str) {
        self.targets
            .write()
            .unwrap_or_else(poisoned)
            .insert(target.to_owned(), certificate_id.to_owned());
    }

    /// Every target currently serving `certificate_id`.
    #[must_use]
    pub fn targets_for(&self, certificate_id: &str) -> Vec<String> {
        self.targets
            .read()
            .unwrap_or_else(poisoned)
            .iter()
            .filter(|(_, id)| id.as_str() == certificate_id)
            .map(|(target, _)| target.clone())
            .collect()
    }

    /// The certificate `target` serves, if it is a managed one.
    #[must_use]
    pub fn certificate_for(&self, target: &str) -> Option<String> {
        self.targets
            .read()
            .unwrap_or_else(poisoned)
            .get(target)
            .cloned()
    }

    // —— identity cache ———————————————————————————————————————————

    fn cache_key(organization: &str, certificate_id: &str, purpose: TransportPurpose) -> String {
        format!("{organization}:{certificate_id}:{}", purpose.as_str())
    }

    pub(crate) fn cached_identity(
        &self,
        organization: &str,
        certificate_id: &str,
        purpose: TransportPurpose,
    ) -> Option<Arc<TlsIdentity>> {
        let key = Self::cache_key(organization, certificate_id, purpose);
        let cached = self
            .identities
            .lock()
            .unwrap_or_else(poisoned)
            .get(&key)
            .cloned()?;
        // An identity that has since expired or been revoked is never
        // served from the cache; the next resolve re-checks custody.
        let live = cached.is_valid_at(chrono::Utc::now())
            && !self.is_denied(&cached.leaf_thumbprint_sha256());
        live.then_some(cached)
    }

    pub(crate) fn cache_identity(
        &self,
        organization: &str,
        certificate_id: &str,
        purpose: TransportPurpose,
        identity: Arc<TlsIdentity>,
    ) {
        self.identities
            .lock()
            .unwrap_or_else(poisoned)
            .insert(Self::cache_key(organization, certificate_id, purpose), identity);
    }

    /// Drop every cached identity for `certificate_id` (renewal, revocation).
    pub fn invalidate(&self, certificate_id: &str) {
        let needle = format!(":{certificate_id}:");
        self.identities
            .lock()
            .unwrap_or_else(poisoned)
            .retain(|key, _| !key.contains(&needle));
    }

    #[must_use]
    pub fn cached_identity_count(&self) -> usize {
        self.identities.lock().unwrap_or_else(poisoned).len()
    }

    // —— denylist —————————————————————————————————————————————————

    /// Deny a leaf thumbprint in this process, and in the attached
    /// generations so open connections are refused on their next request.
    pub fn deny(&self, thumbprint: &str) {
        let lowered = thumbprint.to_ascii_lowercase();
        self.denied
            .write()
            .unwrap_or_else(poisoned)
            .insert(lowered.clone());
        if let Some(generations) = self.generations() {
            generations.deny_thumbprint(&lowered);
        }
    }

    #[must_use]
    pub fn is_denied(&self, thumbprint: &str) -> bool {
        self.denied
            .read()
            .unwrap_or_else(poisoned)
            .contains(&thumbprint.to_ascii_lowercase())
    }

    #[must_use]
    pub fn denied_count(&self) -> usize {
        self.denied.read().unwrap_or_else(poisoned).len()
    }

    /// The per-listener denylist hook (`ServerProfile::deny_thumbprint`):
    /// consulted at the handshake and by `enforce_current_generation`.
    #[must_use]
    pub fn deny_hook(self: &Arc<Self>) -> DenyThumbprint {
        let weak = Arc::downgrade(self);
        Arc::new(move |thumbprint: &str| {
            weak.upgrade()
                .is_some_and(|state| state.is_denied(thumbprint))
        })
    }

    // —— scheduler / crl / trust epochs ———————————————————————————

    pub(crate) fn with_scheduler<T>(&self, f: impl FnOnce(&mut renewal::Scheduler) -> T) -> T {
        f(&mut self.renewal.lock().unwrap_or_else(poisoned))
    }

    pub(crate) fn set_crl(&self, freshness: Option<revocation::CrlFreshness>) {
        *self.crl.write().unwrap_or_else(poisoned) = freshness;
    }

    #[must_use]
    pub fn crl(&self) -> Option<revocation::CrlFreshness> {
        self.crl.read().unwrap_or_else(poisoned).clone()
    }

    pub(crate) fn with_trust_epoch<T>(&self, f: impl FnOnce(&mut trust::ActivatedEpoch) -> T) -> T {
        f(&mut self.trust_epoch.lock().unwrap_or_else(poisoned))
    }
}
