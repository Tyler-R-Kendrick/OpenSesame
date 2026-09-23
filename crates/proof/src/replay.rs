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

    /// Record a `jti` whose proof stays acceptable until `valid_until` (the
    /// last second the validator would still admit it). The entry must be
    /// retained at least that long; the default forwards to
    /// [`ReplayCache::check_and_record_at`], so an implementation that only
    /// has a fixed TTL must size it for `max_age + DPOP_MAX_FUTURE_SKEW_SECS`.
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    fn check_and_record_until(
        &self,
        jti: &str,
        now: i64,
        valid_until: i64,
    ) -> Result<(), ProofError> {
        let _ = valid_until;
        self.check_and_record_at(jti, now)
    }
}

/// The validator's usual `max_age` (300s) plus the future `iat` skew it
/// accepts: a proof dated ahead stays valid that much longer than one dated
/// now. Remembering a `jti` beyond that adds no protection — only growth.
pub const DEFAULT_REPLAY_TTL_SECS: i64 = 300 + crate::jwk::DPOP_MAX_FUTURE_SKEW_SECS;
/// Hard ceiling on retained `jti` values; the cache fails closed when reached.
pub const DEFAULT_REPLAY_CAPACITY: usize = 100_000;
/// `jti` values longer than this are rejected rather than stored.
pub const MAX_JTI_LEN: usize = 256;

/// In-memory replay cache suitable for single-process validators.
///
/// Bounded two ways: entries expire after `ttl_secs` (or later, at the
/// proof's own `valid_until`) and the map is capped at `capacity`. At capacity
/// the cache rejects new proofs (fail closed) rather than evicting entries,
/// since evicting would re-open the replay window.
#[derive(Debug)]
pub struct InMemoryReplayCache {
    /// `jti` → last second the entry must still be remembered.
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
        self.check_and_record_until(jti, now, now)
    }

    fn check_and_record_until(
        &self,
        jti: &str,
        now: i64,
        valid_until: i64,
    ) -> Result<(), ProofError> {
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

        // Drop entries that can no longer be replayed: their proof is past both
        // the cache TTL and its own acceptance window.
        guard.retain(|_, retain_until| *retain_until >= now);

        if guard.contains_key(jti) {
            return Err(ProofError::Replay(jti.to_string()));
        }
        if guard.len() >= self.capacity {
            return Err(ProofError::InvalidProof(
                "replay cache at capacity; rejecting proof".into(),
            ));
        }
        let retain_until = now.saturating_add(self.ttl_secs).max(valid_until);
        guard.insert(jti.to_string(), retain_until);
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
    fn entries_outlive_the_ttl_until_the_proof_itself_expires() {
        let cache = InMemoryReplayCache::with_limits(300, 16);
        // A proof first seen at 1_000 but acceptable until 1_360 (future iat).
        cache.check_and_record_until("jti-1", 1_000, 1_360).unwrap();
        for replay_at in [1_350, 1_360] {
            assert!(matches!(
                cache.check_and_record_until("jti-1", replay_at, 1_360),
                Err(ProofError::Replay(_))
            ));
        }
        // Once the proof is past its own window the entry may go.
        cache.check_and_record_at("jti-2", 1_361).unwrap();
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
