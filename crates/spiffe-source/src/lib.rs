#![doc = include_str!("../README.md")]
#![forbid(unsafe_code)]

pub mod bundles;
pub mod config;
pub mod error;
pub mod outage;
pub mod pem;
pub mod sink;
pub mod snapshot;
pub mod source;
pub mod status;
pub mod svid_profile;

#[cfg(feature = "fake-workload-api")]
pub mod fake;

pub use config::{SpiffeSourceConfig, DEFAULT_MAX_STALE, ENDPOINT_SOCKET_ENV};
pub use error::SpiffeSourceError;
pub use outage::ReconnectPolicy;
pub use sink::GenerationSink;
pub use snapshot::{SvidGeneration, TrustDomainBundles};
pub use source::{SpiffeSource, SpiffeSourceHandle};
pub use status::{SourcePhase, SourceStatus};
pub use svid_profile::{SvidExpectation, SvidFacts, SvidProfileError, SvidRole};

/// The exact SDK this crate is built on, for status and reports.
pub const SDK: &str = concat!("spiffe ", "0.16.1");
