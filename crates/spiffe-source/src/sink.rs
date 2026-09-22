//! Where validated generations go. The production sink is
//! `opensesame_transport_security::TransportGenerations` (see
//! [`crate::sink::transport`]); tests use [`RecordingSink`].

use opensesame_domain::TransportError;

use crate::snapshot::SvidGeneration;

/// A consumer of generations: activates a fully validated candidate
/// atomically, or withdraws the current one with a reason.
pub trait GenerationSink: Send + Sync + 'static {
    /// Activate `generation`; returns the new generation number. An error
    /// means the candidate was rejected and the previous generation (if any)
    /// is still current.
    ///
    /// # Errors
    /// Whatever the manager refused (key mismatch, chain does not build,
    /// expired), as a stable [`TransportError`].
    fn activate(&self, generation: &SvidGeneration) -> Result<u64, TransportError>;

    /// Withdraw the current generation so nothing new is authenticated with it.
    fn withdraw(&self, reason: TransportError);
}

/// A sink that records every call. Test-only.
#[cfg(feature = "fake-workload-api")]
pub mod recording {
    use std::sync::{Arc, Mutex};

    use opensesame_domain::TransportError;

    use super::GenerationSink;
    use crate::snapshot::SvidGeneration;

    /// One observed sink event (no key material).
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum SinkEvent {
        /// A generation was activated with this number, ID and thumbprint.
        Activated {
            number: u64,
            spiffe_id: String,
            thumbprint: String,
            trust_domains: Vec<String>,
        },
        /// The current generation was withdrawn.
        Withdrawn(TransportError),
    }

    /// Records activations and withdrawals; optionally rejects activations.
    #[derive(Debug, Default)]
    pub struct RecordingSink {
        events: Mutex<Vec<SinkEvent>>,
        next: Mutex<u64>,
        reject: Mutex<Option<TransportError>>,
    }

    impl RecordingSink {
        /// A shared, empty sink.
        #[must_use]
        pub fn shared() -> Arc<Self> {
            Arc::new(Self::default())
        }

        /// Snapshot of everything seen so far.
        #[must_use]
        pub fn events(&self) -> Vec<SinkEvent> {
            self.events.lock().map(|e| e.clone()).unwrap_or_default()
        }

        /// Make every following activation fail with `reason` (None: accept).
        pub fn reject_activations(&self, reason: Option<TransportError>) {
            if let Ok(mut r) = self.reject.lock() {
                *r = reason;
            }
        }

        /// The last event, if any.
        #[must_use]
        pub fn last(&self) -> Option<SinkEvent> {
            self.events().last().cloned()
        }
    }

    impl GenerationSink for RecordingSink {
        fn activate(&self, generation: &SvidGeneration) -> Result<u64, TransportError> {
            if let Some(reason) = self.reject.lock().ok().and_then(|r| r.clone()) {
                return Err(reason);
            }
            let number = self.next.lock().map_or(0, |mut n| {
                *n += 1;
                *n
            });
            if let Ok(mut events) = self.events.lock() {
                events.push(SinkEvent::Activated {
                    number,
                    spiffe_id: generation.spiffe_id.clone(),
                    thumbprint: generation.leaf_thumbprint_sha256.clone(),
                    trust_domains: generation
                        .bundles
                        .trust_domains()
                        .map(str::to_owned)
                        .collect(),
                });
            }
            Ok(number)
        }

        fn withdraw(&self, reason: TransportError) {
            if let Ok(mut events) = self.events.lock() {
                events.push(SinkEvent::Withdrawn(reason));
            }
        }
    }
}

pub mod transport;

pub use transport::TransportGenerationsSink;
