//! In-memory [`ClientIdentityResolver`] / [`TrustProfileResolver`]
//! (ADR 0130, SW-CONNECTOR).
//!
//! The broker never reads a file, a socket or a Workload API endpoint: it asks
//! a resolver for a *reference* it was given, and the resolver decides whether
//! that organization owns it. On the Host, SW-LIFECYCLE implements the traits
//! over managed certificates. This implementation is the same shape backed by
//! a map, so every test in this crate — and every downstream test that needs a
//! connector identity — exercises the real trait boundary rather than a mock
//! of the broker's internals.
//!
//! The ownership rule is the interesting part and it is implemented here
//! exactly as the trait documents it: a reference registered to another
//! organization answers `IdentityMissing`, the same answer as a reference that
//! does not exist. A tenant therefore cannot use this to discover that another
//! tenant has an identity called `payments` (AT-TLS-TENANT, AT-CUSTODY-SOURCE).

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use opensesame_domain::transport::TransportError;
use opensesame_transport_security::{TlsIdentity, TrustBundle};

use super::{
    ClientIdentityResolver, IdentityScope, TrustProfileResolver, TrustScope,
    PURPOSE_CONNECTOR_INVOKE,
};

/// What one registered identity may be used for.
#[derive(Clone)]
struct Registered {
    identity: Arc<TlsIdentity>,
    /// Purposes this identity is registered for. Empty means connector
    /// invoke only — never "any purpose".
    purposes: Vec<&'static str>,
    revoked: bool,
}

/// A map-backed resolver pair.
#[derive(Default)]
pub struct MemoryTransportResolver {
    /// Keyed by `(organization, name)`: a reference is owned, never global.
    identities: Mutex<BTreeMap<(String, String), Registered>>,
    trust: Mutex<BTreeMap<(String, String), Arc<TrustBundle>>>,
}

impl std::fmt::Debug for MemoryTransportResolver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MemoryTransportResolver")
    }
}

impl MemoryTransportResolver {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Register `name` to `organization_id` for the connector-invoke purpose.
    pub fn register_identity(
        &self,
        organization_id: &str,
        name: &str,
        identity: Arc<TlsIdentity>,
    ) {
        self.register_identity_for(organization_id, name, identity, vec![PURPOSE_CONNECTOR_INVOKE]);
    }

    /// Register `name` for an explicit purpose list.
    pub fn register_identity_for(
        &self,
        organization_id: &str,
        name: &str,
        identity: Arc<TlsIdentity>,
        purposes: Vec<&'static str>,
    ) {
        if let Ok(mut map) = self.identities.lock() {
            map.insert(
                (organization_id.to_owned(), name.to_owned()),
                Registered {
                    identity,
                    purposes,
                    revoked: false,
                },
            );
        }
    }

    /// Mark every registration of `name` revoked: it stops resolving, and no
    /// pooled client keyed on its thumbprint is rebuilt.
    pub fn revoke_identity(&self, name: &str) {
        if let Ok(mut map) = self.identities.lock() {
            for (_, entry) in map.iter_mut().filter(|((_, key), _)| key == name) {
                entry.revoked = true;
            }
        }
    }

    pub fn register_trust(&self, organization_id: &str, name: &str, bundle: Arc<TrustBundle>) {
        if let Ok(mut map) = self.trust.lock() {
            map.insert((organization_id.to_owned(), name.to_owned()), bundle);
        }
    }

    fn locked<T>(
        guard: Result<T, std::sync::PoisonError<T>>,
    ) -> Result<T, TransportError> {
        guard.map_err(|_| TransportError::malformed("resolver registry lock poisoned"))
    }
}

#[async_trait]
impl ClientIdentityResolver for MemoryTransportResolver {
    async fn resolve(&self, scope: IdentityScope) -> Result<Arc<TlsIdentity>, TransportError> {
        let map = Self::locked(self.identities.lock())?;
        // A reference this organization does not own is *missing*, not
        // forbidden: no existence oracle across tenants.
        let entry = map
            .get(&(scope.organization_id.clone(), scope.identity.name.clone()))
            .ok_or(TransportError::IdentityMissing)?;
        if entry.revoked {
            return Err(TransportError::EvidenceRevoked);
        }
        if !entry.purposes.contains(&scope.purpose) {
            return Err(TransportError::PeerDisallowed);
        }
        if !entry.identity.is_valid_at(chrono::Utc::now()) {
            return Err(TransportError::EvidenceExpired);
        }
        Ok(Arc::clone(&entry.identity))
    }
}

#[async_trait]
impl TrustProfileResolver for MemoryTransportResolver {
    async fn resolve_trust(&self, scope: TrustScope) -> Result<Arc<TrustBundle>, TransportError> {
        let map = Self::locked(self.trust.lock())?;
        let bundle = map
            .get(&(scope.organization_id.clone(), scope.trust.name.clone()))
            .ok_or(TransportError::TrustUnknown)?;
        Ok(Arc::clone(bundle))
    }
}
