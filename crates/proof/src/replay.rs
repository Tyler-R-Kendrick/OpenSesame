use crate::ProofError;
use std::collections::HashSet;
use std::sync::Mutex;

/// Replay protection for DPoP `jti` values.
pub trait ReplayCache: Send + Sync {
    fn check_and_record(&self, jti: &str) -> Result<(), ProofError>;
}

/// In-memory replay cache suitable for single-process validators.
#[derive(Debug, Default)]
pub struct InMemoryReplayCache {
    seen: Mutex<HashSet<String>>,
}

impl InMemoryReplayCache {
    pub fn new() -> Self {
        Self::default()
    }
}

impl ReplayCache for InMemoryReplayCache {
    fn check_and_record(&self, jti: &str) -> Result<(), ProofError> {
        let mut guard = self
            .seen
            .lock()
            .map_err(|_| ProofError::InvalidProof("replay cache poisoned".into()))?;
        if !guard.insert(jti.to_string()) {
            return Err(ProofError::Replay(jti.to_string()));
        }
        Ok(())
    }
}
