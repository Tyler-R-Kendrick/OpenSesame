//! Scoped connector client pools (ADR 0130, CONN-POOLS).
//!
//! A client certificate authenticates a *connection*, not an HTTP request
//! object. Two tenants talking to the same upstream must therefore never share
//! a pooled client, or the second tenant's request rides the first tenant's
//! already-authenticated TLS connection and the upstream sees the wrong
//! certificate (credential substitution — the central threat of ADR 0130).
//!
//! So every pooled client is keyed by everything that could differ between two
//! requests and change what the upstream authenticates:
//!
//! | key part | why |
//! |---|---|
//! | `organization_id` | tenant isolation (AT-TLS-TENANT, AT-CONNECTOR-POOLS) |
//! | `connection_id` | one connection's authority is not another's |
//! | `executor` | a Host-executed and a worker-executed call are different peers |
//! | `authority` | `host:port`; a client pinned to one authority dials no other |
//! | `credential` | the *leaf thumbprint* of the presented identity, so a rotation to a new key builds a new pool rather than reusing a connection authenticated with the old one (AT-ROTATE-VALID) |
//! | `trust` | the trust profile *and* its generation, so a withdrawn anchor cannot keep serving through a cached client |
//! | `policy` | `server_tls` and `mtls_required` are different security postures and never share a client |
//!
//! Eviction is LRU and bounded: an attacker who can create connections cannot
//! make the Host hold unbounded TLS state, and an evicted entry is simply
//! rebuilt on its next use. Eviction is **not** a revocation mechanism — see
//! [`ConnectorClientPool::forget_connection`], which is.

use std::num::NonZeroUsize;
use std::sync::{Arc, Mutex};

use lru::LruCache;
use opensesame_domain::transport::{TransportError, TransportPolicy};
use opensesame_invoke_through::Invoker;

use super::ConnectorExecutionTarget;

/// How many distinct scopes one Host keeps live clients for.
pub const DEFAULT_POOL_CAPACITY: usize = 64;

/// The scope a pooled client belongs to. Every field is part of the identity
/// of the TLS connections inside it; nothing here is secret (a leaf
/// thumbprint is a public digest of a public certificate).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ConnectorPoolKey {
    pub organization_id: String,
    pub connection_id: String,
    pub executor: ConnectorExecutionTarget,
    /// `host:port`, lowercased.
    pub authority: String,
    /// The presented client leaf's SHA-256 thumbprint, or `None` on a
    /// `server_tls` connection that presents nothing.
    pub credential_thumbprint: Option<String>,
    pub trust_profile: Option<String>,
    pub trust_generation: u64,
    pub policy: TransportPolicy,
}

impl ConnectorPoolKey {
    /// A short, non-secret label for a receipt or a log line. Never the
    /// thumbprint in full and never the upstream path.
    #[must_use]
    pub fn label(&self) -> String {
        let credential = self
            .credential_thumbprint
            .as_deref()
            .map_or("none", |value| value.get(..8).unwrap_or(value));
        let policy = match self.policy {
            TransportPolicy::MtlsRequired => "mtls_required",
            TransportPolicy::ServerTls => "server_tls",
            TransportPolicy::ExistingLocal => "existing_local",
            TransportPolicy::TrustedIngress => "trusted_ingress",
        };
        format!(
            "{}/{}@{policy} cred={credential} trust={}",
            self.organization_id, self.connection_id, self.trust_generation,
        )
    }
}

/// Bounded, scope-keyed pool of credential-bearing clients.
pub struct ConnectorClientPool {
    entries: Mutex<LruCache<ConnectorPoolKey, Arc<Invoker>>>,
}

impl std::fmt::Debug for ConnectorClientPool {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectorClientPool")
            .field("len", &self.len())
            .finish()
    }
}

impl Default for ConnectorClientPool {
    fn default() -> Self {
        Self::with_capacity(DEFAULT_POOL_CAPACITY)
    }
}

impl ConnectorClientPool {
    /// A pool holding at most `capacity` scopes (at least one).
    #[must_use]
    pub fn with_capacity(capacity: usize) -> Self {
        let capacity = NonZeroUsize::new(capacity.max(1)).unwrap_or(NonZeroUsize::MIN);
        Self {
            entries: Mutex::new(LruCache::new(capacity)),
        }
    }

    /// The pooled client for `key`, building it with `build` when the scope
    /// has no live client.
    ///
    /// `build` runs only on a miss, and only after the caller has already
    /// cleared its egress fence and resolved the identity this key names, so a
    /// denied request never creates a client.
    ///
    /// # Errors
    ///
    /// Whatever `build` returns, plus `MalformedConfiguration` if the pool
    /// lock was poisoned by a panicking builder (fail closed rather than
    /// reuse state a panic left behind).
    pub fn get_or_build<F>(
        &self,
        key: &ConnectorPoolKey,
        build: F,
    ) -> Result<Arc<Invoker>, TransportError>
    where
        F: FnOnce() -> Result<Invoker, TransportError>,
    {
        {
            let mut entries = self.lock()?;
            if let Some(existing) = entries.get(key) {
                return Ok(Arc::clone(existing));
            }
        }
        let built = Arc::new(build()?);
        let mut entries = self.lock()?;
        // Another task may have built the same scope while this one was
        // building; either client is correct for the scope, so keep the one
        // already published rather than replacing a live pool.
        if let Some(existing) = entries.get(key) {
            return Ok(Arc::clone(existing));
        }
        entries.put(key.clone(), Arc::clone(&built));
        Ok(built)
    }

    /// Drop every live client for one connection.
    ///
    /// This is what a revocation, a re-authorization or a transport-record
    /// change calls. It bounds *new* connections only: an HTTP request already
    /// in flight on a dropped client finishes, which is the honest bound
    /// (ADR 0130 "revocation and session boundaries") — the Host does not
    /// promise that revoking a certificate tears down established sessions.
    pub fn forget_connection(&self, organization_id: &str, connection_id: &str) {
        let Ok(mut entries) = self.entries.lock() else {
            return;
        };
        let doomed: Vec<ConnectorPoolKey> = entries
            .iter()
            .filter(|(key, _)| {
                key.organization_id == organization_id && key.connection_id == connection_id
            })
            .map(|(key, _)| key.clone())
            .collect();
        for key in doomed {
            entries.pop(&key);
        }
    }

    /// Drop every live client, for a trust or identity generation change that
    /// is not scoped to one connection.
    pub fn clear(&self) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.clear();
        }
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.lock().map_or(0, |entries| entries.len())
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Whether a scope currently has a live client, without promoting it.
    #[must_use]
    pub fn contains(&self, key: &ConnectorPoolKey) -> bool {
        self.entries
            .lock()
            .is_ok_and(|entries| entries.contains(key))
    }

    fn lock(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, LruCache<ConnectorPoolKey, Arc<Invoker>>>, TransportError>
    {
        self.entries
            .lock()
            .map_err(|_| TransportError::malformed("connector client pool lock poisoned"))
    }
}

#[cfg(test)]
#[path = "transport_pool_tests.rs"]
mod tests;
