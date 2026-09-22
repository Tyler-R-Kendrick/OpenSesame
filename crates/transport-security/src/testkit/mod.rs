//! Disposable PKI for tests (feature `testkit`).
//!
//! Everything is generated in memory with `rcgen` at test time; nothing is
//! ever committed. Keys are P-256 by default, and a `LeafSpec` can ask for
//! P-384, Ed25519 or RSA-2048, a chosen validity window, EKU/KU sets, any
//! SAN mix, a CA flag, or an unknown critical extension. Every knob exists
//! to build a *negative* fixture the real verifiers must reject.

mod ca;
mod leaf;

pub use ca::DisposableCa;
pub use leaf::{IssuedLeaf, KeyAlgorithm, LeafSpec, SanEntry};

/// A fresh temporary directory that is removed on drop.
///
/// # Panics
///
/// When the OS refuses to create a temporary directory.
#[must_use]
pub fn tempdir() -> tempfile::TempDir {
    tempfile::tempdir().expect("temporary directory")
}

pub(crate) fn to_offset(value: chrono::DateTime<chrono::Utc>) -> time::OffsetDateTime {
    time::OffsetDateTime::from_unix_timestamp(value.timestamp())
        .expect("chrono timestamps are in range for time")
}
