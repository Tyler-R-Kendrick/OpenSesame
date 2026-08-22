use crate::ProofError;
#[cfg(feature = "concurrency-test")]
use shuttle::sync::Mutex;
use std::collections::HashMap;
#[cfg(not(feature = "concurrency-test"))]
use std::sync::Mutex;

/// Replay protection for `DPoP` `jti` values.
pub trait ReplayCache: Send + Sync {
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    fn check_and_record(&self, jti: &str) -> Result<(), ProofError>;

    /// Record with an explicit clock so entries can expire with the proof window.
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    fn check_and_record_at(&self, jti: &str, now: i64) -> Result<(), ProofError> {
        let _ = now;
        self.check_and_record(jti)
    }
}

/// Proofs older than this are rejected by the validator, so remembering a `jti`
/// beyond the window (plus skew) adds no protection — only unbounded growth.
pub const DEFAULT_REPLAY_TTL_SECS: i64 = 300;
/// Hard ceiling on retained `jti` values; the cache fails closed when reached.
pub const DEFAULT_REPLAY_CAPACITY: usize = 100_000;
/// `jti` values longer than this are rejected rather than stored.
pub const MAX_JTI_LEN: usize = 256;

/// In-memory replay cache suitable for single-process validators.
///
/// Bounded two ways: entries expire after `ttl_secs` and the map is capped at
/// `capacity`. At capacity the cache rejects new proofs (fail closed) rather
/// than evicting entries, since evicting would re-open the replay window.
#[derive(Debug)]
pub struct InMemoryReplayCache {
    seen: Mutex<HashMap<String, i64>>,
    ttl_secs: i64,
    capacity: usize,
}

impl Default for InMemoryReplayCache {
    fn default() -> Self {
        Self::new()
    }
}

impl InMemoryReplayCache {
    #[must_use]
    pub fn new() -> Self {
        Self::with_limits(DEFAULT_REPLAY_TTL_SECS, DEFAULT_REPLAY_CAPACITY)
    }

    #[must_use]
    pub fn with_limits(ttl_secs: i64, capacity: usize) -> Self {
        Self {
            seen: Mutex::new(HashMap::new()),
            ttl_secs,
            capacity,
        }
    }

    /// Retained entries (after pruning is applied on record).
    pub fn len(&self) -> usize {
        self.seen.lock().map(|g| g.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl ReplayCache for InMemoryReplayCache {
    fn check_and_record(&self, jti: &str) -> Result<(), ProofError> {
        let now = chrono::Utc::now().timestamp();
        self.check_and_record_at(jti, now)
    }

    fn check_and_record_at(&self, jti: &str, now: i64) -> Result<(), ProofError> {
        if jti.is_empty() {
            return Err(ProofError::InvalidProof("empty jti".into()));
        }
        if jti.len() > MAX_JTI_LEN {
            return Err(ProofError::InvalidProof("jti too long".into()));
        }
        let mut guard = self
            .seen
            .lock()
            .map_err(|_| ProofError::InvalidProof("replay cache poisoned".into()))?;

        // Drop entries that can no longer be replayed within the proof window.
        let cutoff = now - self.ttl_secs;
        guard.retain(|_, seen_at| *seen_at > cutoff);

        if let Some(seen_at) = guard.get(jti) {
            let _ = seen_at;
            return Err(ProofError::Replay(jti.to_string()));
        }
        if guard.len() >= self.capacity {
            return Err(ProofError::InvalidProof(
                "replay cache at capacity; rejecting proof".into(),
            ));
        }
        guard.insert(jti.to_string(), now);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replay_within_window_is_rejected() {
        let cache = InMemoryReplayCache::with_limits(300, 16);
        assert!(cache.check_and_record_at("jti-1", 1_000).is_ok());
        assert!(matches!(
            cache.check_and_record_at("jti-1", 1_010),
            Err(ProofError::Replay(_))
        ));
    }

    #[test]
    fn entries_expire_with_the_proof_window() {
        let cache = InMemoryReplayCache::with_limits(300, 16);
        cache.check_and_record_at("jti-1", 1_000).unwrap();
        assert_eq!(cache.len(), 1);
        // Past the window the proof itself is already rejected on iat, so the
        // entry is pruned instead of retained forever.
        cache.check_and_record_at("jti-2", 1_400).unwrap();
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn capacity_fails_closed_instead_of_evicting() {
        let cache = InMemoryReplayCache::with_limits(300, 2);
        cache.check_and_record_at("a", 100).unwrap();
        cache.check_and_record_at("b", 100).unwrap();
        let err = cache.check_and_record_at("c", 100).unwrap_err();
        assert!(matches!(err, ProofError::InvalidProof(m) if m.contains("capacity")));
        // The earlier jti is still remembered, so it cannot be replayed.
        assert!(matches!(
            cache.check_and_record_at("a", 100),
            Err(ProofError::Replay(_))
        ));
    }

    #[test]
    fn oversized_and_empty_jti_are_rejected() {
        let cache = InMemoryReplayCache::new();
        assert!(cache.check_and_record_at("", 100).is_err());
        let long = "x".repeat(MAX_JTI_LEN + 1);
        assert!(cache.check_and_record_at(&long, 100).is_err());
        assert_eq!(cache.len(), 0);
    }
}

#[cfg(kani)]
mod kani_proofs {
    use super::*;

    #[kani::proof]
    fn replay_and_capacity() {
        let cache = InMemoryReplayCache::with_limits(300, 2);
        assert!(cache.check_and_record_at("a", 100).is_ok());
        assert!(matches!(
            cache.check_and_record_at("a", 110),
            Err(ProofError::Replay(_))
        ));
        assert!(cache.check_and_record_at("b", 100).is_ok());
        assert!(cache.check_and_record_at("c", 100).is_err());
    }
}
